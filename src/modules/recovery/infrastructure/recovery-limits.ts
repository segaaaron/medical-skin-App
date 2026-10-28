// Los contadores de la recuperación, sobre Redis.
//
// Las tres reglas de `_convenciones.md` · «Los contadores», y las tres salen de la misma
// obligación —que la respuesta sea idéntica exista o no la cuenta—:
//   1. se incrementa exista o no la cuenta;
//   2. la clave lleva el HMAC del correo, nunca el correo;
//   3. un fallo de Redis NO abre la puerta: lanza, y el endpoint responde 500.

import { FAILURE_PHRASES, ServiceFailure } from '../../../shared/contract/error-catalog';
import { COUNTER_KEYS, type Counters } from '../../../shared/security/counters';
import {
  ATTEMPTS_PER_CODE,
  ATTEMPTS_PER_IP,
  CODE_LIFETIME_MINUTES,
  REQUESTS_PER_EMAIL_PER_HOUR,
  REQUESTS_PER_IP_PER_HOUR,
} from '../domain/code';
import type { RecoveryLimitsPort, RequestRoom } from '../domain/ports';

const HOUR_SECONDS = 60 * 60;
const CODE_WINDOW_SECONDS = CODE_LIFETIME_MINUTES * 60;

export class RecoveryLimits implements RecoveryLimitsPort {
  constructor(private readonly counters: Counters) {}

  async countRequest(p: { email: string; ip: string; expiresAt: Date }): Promise<RequestRoom> {
    return this.failingClosed(FAILURE_PHRASES.requestRecoveryCode, async () => {
      const fingerprint = this.counters.fingerprint(p.email);
      const byEmail = await this.counters.increment(
        COUNTER_KEYS.recoveryRequestsByEmail(fingerprint),
        HOUR_SECONDS,
      );
      const byIp = await this.counters.increment(
        COUNTER_KEYS.recoveryRequestsByIp(p.ip),
        HOUR_SECONDS,
      );

      // «Pedir un código nuevo anula el anterior. Solo hay uno vivo por cuenta»: sus cinco
      // intentos se van con él, y la marca de vida se mueve a la caducidad del nuevo.
      await this.counters.forget(COUNTER_KEYS.recoveryAttemptsByEmail(fingerprint));
      await this.counters.mark(
        COUNTER_KEYS.recoveryCodeIsLive(fingerprint),
        CODE_WINDOW_SECONDS,
      );

      return {
        tooMany:
          byEmail.hits > REQUESTS_PER_EMAIL_PER_HOUR || byIp.hits > REQUESTS_PER_IP_PER_HOUR,
      };
    });
  }

  async countAttemptByIp(ip: string): Promise<RequestRoom> {
    return this.failingClosed(FAILURE_PHRASES.checkRecoveryCode, async () => {
      const byIp = await this.counters.increment(
        COUNTER_KEYS.recoveryAttemptsByIp(ip),
        CODE_WINDOW_SECONDS,
      );
      return { tooMany: byIp.hits > ATTEMPTS_PER_IP };
    });
  }

  async historyOf(email: string): Promise<{
    attemptsSpent: number;
    codeIsLive: boolean;
    codeWasAsked: boolean;
  }> {
    return this.failingClosed(FAILURE_PHRASES.checkRecoveryCode, async () => {
      const fingerprint = this.counters.fingerprint(email);
      const attempts = await this.counters.peek(
        COUNTER_KEYS.recoveryAttemptsByEmail(fingerprint),
      );
      const asked = await this.counters.peek(COUNTER_KEYS.recoveryRequestsByEmail(fingerprint));
      return {
        attemptsSpent: attempts.hits,
        codeIsLive: await this.counters.has(COUNTER_KEYS.recoveryCodeIsLive(fingerprint)),
        codeWasAsked: asked.hits > 0,
      };
    });
  }

  async recordMiss(email: string): Promise<number> {
    return this.failingClosed(FAILURE_PHRASES.checkRecoveryCode, async () => {
      const spent = await this.counters.increment(
        COUNTER_KEYS.recoveryAttemptsByEmail(this.counters.fingerprint(email)),
        CODE_WINDOW_SECONDS,
      );
      return Math.max(ATTEMPTS_PER_CODE - spent.hits, 0);
    });
  }

  async clearAttempts(email: string): Promise<void> {
    await this.failingClosed(FAILURE_PHRASES.checkRecoveryCode, () =>
      this.counters.forget(
        COUNTER_KEYS.recoveryAttemptsByEmail(this.counters.fingerprint(email)),
        COUNTER_KEYS.recoveryCodeIsLive(this.counters.fingerprint(email)),
      ),
    );
  }

  /**
   * «Si el contador no se puede leer, el endpoint responde `500 fallo_de_servicio` con su
   * frase, no un 200. Un límite de intentos que falla hacia el lado cómodo no es un
   * límite.» La frase la pasa quien llama, porque es la de su endpoint.
   */
  private async failingClosed<T>(phrase: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (cause) {
      throw new ServiceFailure(phrase, cause);
    }
  }
}
