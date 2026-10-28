// Los contadores de las cuentas, sobre Redis: los intentos de `actual` en
// `PATCH /v1/cuentas/mia/contrasena`, los reenvíos de acceso de
// `POST /v1/cuentas/{cuenta_id}/acceso` y las altas de `POST /v1/pacientes`.
//
// Van por `cuenta_id` —o por consulta el de las altas— y no por correo, al contrario que
// los del acceso y de la recuperación: aquí quien llama ya está dentro, así que hay una fila
// segura que contar y no hay ningún correo desconocido al que mentirle.
//
// Un fallo de Redis NO abre la puerta: lanza, y el endpoint responde 500.

import { FAILURE_PHRASES, ServiceFailure } from '../../../shared/contract/error-catalog';
import { COUNTER_KEYS, type Counters } from '../../../shared/security/counters';
import { WINDOW_MINUTES } from '../application/change-password';
import { CREATIONS_PER_HOUR } from '../domain/patient-registration';
import type {
  PasswordAttemptsPort,
  PatientCreationLimitPort,
  ResendLimitPort,
} from '../domain/ports';

export class PasswordAttempts implements PasswordAttemptsPort {
  constructor(private readonly counters: Counters) {}

  async spent(accountId: string): Promise<number> {
    return this.failingClosed(async () => (await this.counters.peek(key(accountId))).hits);
  }

  async recordFailure(accountId: string): Promise<void> {
    await this.failingClosed(() =>
      this.counters.increment(key(accountId), WINDOW_MINUTES * 60),
    );
  }

  async clear(accountId: string): Promise<void> {
    await this.failingClosed(() => this.counters.forget(key(accountId)));
  }

  private async failingClosed<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (cause) {
      throw new ServiceFailure(FAILURE_PHRASES.changePassword, cause);
    }
  }
}

function key(accountId: string): string {
  return COUNTER_KEYS.passwordChangeByAccount(accountId);
}

/**
 * El contador del `429 demasiados_reenvios`: «más de 3 en una hora para la misma cuenta»
 * (`cuentas.md`). Va por `cuenta_id` y su clave es la que escribe `_convenciones.md`.
 */
export class ResendLimit implements ResendLimitPort {
  constructor(private readonly counters: Counters) {}

  async count(accountId: string): Promise<{ tooMany: boolean }> {
    try {
      const hits = await this.counters.increment(
        COUNTER_KEYS.accessResendsByAccount(accountId),
        60 * 60,
      );
      return { tooMany: hits.hits > RESENDS_PER_HOUR };
    } catch (cause) {
      // Un fallo de Redis no abre la puerta: aquí lo que se protege es que una doctora no
      // acuñe temporales en bucle sobre la cuenta de su paciente.
      throw new ServiceFailure(FAILURE_PHRASES.sendPatientAccess, cause);
    }
  }
}

/** «Más de 3 en una hora para la misma cuenta.» */
export const RESENDS_PER_HOUR = 3;

/**
 * El contador del `429 demasiadas_altas`: «más de 60 altas en una hora» (`cuentas.md`). Va
 * por CONSULTA, al contrario que los dos de arriba: lo que el contrato acota es el ritmo de
 * altas de una consulta, que es la misma cuota la pida la doctora o su asistente.
 */
export class PatientCreationLimit implements PatientCreationLimitPort {
  constructor(private readonly counters: Counters) {}

  async count(practiceId: string): Promise<{ tooMany: boolean }> {
    try {
      const hits = await this.counters.increment(
        COUNTER_KEYS.patientCreationsByPractice(practiceId),
        60 * 60,
      );
      return { tooMany: hits.hits > CREATIONS_PER_HOUR };
    } catch (cause) {
      // Un fallo de Redis no abre la puerta: un límite que falla hacia el lado cómodo no es
      // un límite, y lo que protege este es el alta, que crea identidades.
      throw new ServiceFailure(FAILURE_PHRASES.createPatient, cause);
    }
  }
}
