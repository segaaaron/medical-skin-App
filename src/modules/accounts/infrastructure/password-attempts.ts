// El contador del `429 demasiados_intentos` de `PATCH /v1/cuentas/mia/contrasena`, sobre
// Redis.
//
// Va por `cuenta_id` y no por correo, al contrario que los del acceso y de la
// recuperación: aquí quien llama ya está dentro, así que hay una fila de cuenta segura que
// contar y no hay ningún correo desconocido al que mentirle.
//
// Un fallo de Redis NO abre la puerta: lanza, y el endpoint responde 500.

import { FAILURE_PHRASES, ServiceFailure } from '../../../shared/contract/error-catalog';
import { COUNTER_KEYS, type Counters } from '../../../shared/security/counters';
import { WINDOW_MINUTES } from '../application/change-password';
import type { PasswordAttemptsPort } from '../domain/ports';

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
