// El límite del refresco, sobre Redis. `sesion.md`: «429 `demasiados_refrescos` · más de
// 60 por sesión en una hora».
//
// POR `sid` Y NO POR CUENTA, y es la decisión del 28 de octubre: con 12 h de refresco en la
// doctora, un dispositivo en bucle gastaría la cuota de todos sus demás dispositivos y la
// dejaría fuera de MedSkin en el teléfono que sí funciona.
//
// Y un fallo de Redis NO abre la puerta: lanza, la rotación se deshace con el `ROLLBACK` de
// la transacción que lo llama y el endpoint responde 500 con su frase. Un límite que falla
// hacia el lado cómodo no es un límite (`_convenciones.md` · «Los contadores»).

import { ContractError, FAILURE_PHRASES, ServiceFailure } from '../../../shared/contract/error-catalog';
import type { Counters } from '../../../shared/security/counters';
import type { RefreshLimitsPort } from '../domain/ports';

/** `sesion.md`, literal: «Más de 60 por sesión en una hora». */
export const REFRESHES_PER_SESSION_PER_HOUR = 60;

const HOUR_SECONDS = 60 * 60;

/**
 * Las dos claves. Su sitio es `COUNTER_KEYS` de `shared/security/counters.ts`, con las
 * otras nueve, y ahí hay que mudarlas: viven aquí porque ese archivo no es de este encargo.
 * No hay riesgo de contar en dos cubos mientras sea el único endpoint que las escribe.
 *
 * El `sid` entra en la clave sin resumir y a propósito: es un uuid que el servidor generó,
 * no un dato personal enumerable como un correo. Lo que `fingerprint()` protege es lo
 * segundo.
 */
const KEYS = {
  bySession: (sessionId: string) => `sesion:refrescos:${sessionId}`,
  /**
   * Cuántos refrescos entran por la ventana de gracia. No sale en la respuesta —el cliente
   * no tiene nada que hacer con ese dato— y no va a `access_audit`: esa bitácora la LEE la
   * doctora en Ajustes, y una fila por reintento de su app es ruido en su pantalla. Aquí se
   * mide, que es para lo que se pidió.
   */
  graces: () => 'sesion:refrescos:gracia',
};

export class RefreshLimits implements RefreshLimitsPort {
  constructor(private readonly counters: Counters) {}

  async countRefresh(sessionId: string, graced: boolean): Promise<void> {
    const spent = await this.counting(() =>
      this.counters.increment(KEYS.bySession(sessionId), HOUR_SECONDS),
    );
    if (graced) {
      await this.counting(() => this.counters.increment(KEYS.graces(), HOUR_SECONDS));
    }

    // La ventana se fija en el PRIMER incremento (`Counters.increment`), así que una hora
    // es una hora: si se renovara en cada intento, el límite no caducaría nunca.
    if (spent.hits > REFRESHES_PER_SESSION_PER_HOUR) {
      throw new ContractError('demasiados_refrescos');
    }
  }

  private async counting<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (cause) {
      throw new ServiceFailure(FAILURE_PHRASES.refreshSession, cause);
    }
  }
}
