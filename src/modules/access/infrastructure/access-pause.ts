// La pausa del acceso, sobre los contadores de Redis.
//
// 5 intentos fallidos por cuenta → 15 minutos (`acceso.md` · Reglas de negocio), y el
// contador por IP además. La pausa es DEL ACCESO, no de la cuenta: la paciente puede
// recuperar la contraseña mientras corre.
//
// Lo que se consulta aquí es el contador de Redis y NO `account.locked_until`, y es a
// propósito: `locked_until` solo existe para un correo que tiene cuenta, así que mirarlo
// para decidir el 429 sería el oráculo que el 401 cierra. Además, la consola levanta la
// pausa escribiendo esas columnas (`cuentas.md`) y lo que tiene que borrar es TAMBIÉN la
// clave de Redis: por eso las claves viven en `COUNTER_KEYS` y no aquí dentro.
//
// El límite por IP no está fijado en `acceso.md`, que solo dice «el contador es por cuenta
// y por IP». Se usa 20, que es el número que `recuperacion.md` escribe para su contador por
// IP: un número que el contrato no fija no se inventa dos veces distinto. Anotado para
// `producto`.

import { FAILURE_PHRASES, ServiceFailure } from '../../../shared/contract/error-catalog';
import { COUNTER_KEYS, type Count, type Counters } from '../../../shared/security/counters';
import type { AccessPausePort, PauseState } from '../domain/ports';

export const LIMIT_PER_EMAIL = 5;
export const LIMIT_PER_IP = 20;
export const WINDOW_SECONDS = 15 * 60;

export class AccessPause implements AccessPausePort {
  constructor(private readonly counters: Counters) {}

  async peek(email: string, ip: string): Promise<PauseState> {
    return this.failingClosed(async () => {
      const byEmail = await this.counters.peek(this.emailKey(email));
      const byIp = await this.counters.peek(COUNTER_KEYS.signInByIp(ip));
      return this.verdict(byEmail, byIp);
    });
  }

  async recordFailure(email: string, ip: string): Promise<PauseState> {
    return this.failingClosed(async () => {
      const byEmail = await this.counters.increment(this.emailKey(email), WINDOW_SECONDS);
      const byIp = await this.counters.increment(COUNTER_KEYS.signInByIp(ip), WINDOW_SECONDS);
      return this.verdict(byEmail, byIp);
    });
  }

  /** «se limpia al entrar bien». La IP también: el acierto demuestra que no es un barrido. */
  async clear(email: string, ip: string): Promise<void> {
    await this.failingClosed(() =>
      this.counters.forget(this.emailKey(email), COUNTER_KEYS.signInByIp(ip)),
    );
  }

  private emailKey(email: string): string {
    return COUNTER_KEYS.signInByEmail(this.counters.fingerprint(email));
  }

  private verdict(byEmail: Count, byIp: Count): PauseState {
    const emailSpent = byEmail.hits >= LIMIT_PER_EMAIL;
    const ipSpent = byIp.hits >= LIMIT_PER_IP;
    const paused = emailSpent || ipSpent;
    return {
      paused,
      pausedUntil: paused ? (emailSpent ? byEmail.expiresAt : byIp.expiresAt) : null,
      attemptsLeft: Math.max(LIMIT_PER_EMAIL - byEmail.hits, 0),
    };
  }

  /**
   * Un fallo de Redis no abre la puerta. `_convenciones.md`: «si el contador no se puede
   * leer, el endpoint responde `500 fallo_de_servicio` con su frase, no un 200. Un límite
   * de intentos que falla hacia el lado cómodo no es un límite».
   */
  private async failingClosed<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (cause) {
      throw new ServiceFailure(FAILURE_PHRASES.signIn, cause);
    }
  }
}
