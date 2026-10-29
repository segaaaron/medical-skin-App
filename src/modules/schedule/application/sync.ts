// POST /v1/sync · la bandeja de salida de la app de la doctora, cuando vuelve la señal.
//
// §9.3: «sincronización por bandeja de salida, NO gana el último, y el reloj que decide es el
// del servidor». Lo que llega son OPERACIONES, no filas: mandar la fila final sería gana el
// último con otro nombre.
//
// UN RECHAZO NO DETIENE EL LOTE. Cada operación se aplica sola y cada rechazo vuelve con el
// mismo `codigo` y la misma frase que habría devuelto su endpoint, para que la app los muestre
// como una bandeja de pendientes y la doctora resuelva uno por uno. «Un lote que se cae entero
// por una operación obsoleta pierde el trabajo de una mañana.»
//
// Y EL ORDEN SE RESPETA, en serie y no en paralelo: crear una cita y cancelarla después no
// puede aplicarse al revés.

import { ContractError } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import type { IdempotencyGuardPort } from '../../../shared/idempotency/idempotency-guard';
import { fingerprintOf } from '../../../shared/idempotency/idempotency-key';
import type { Appointments } from './appointments';
import { asRecord, asText } from './schedule';

/** Las operaciones que un lote puede traer. Lo que no está aquí no se aplica. */
const OPERATIONS = ['cita.crear', 'cita.mover', 'cita.cancelar', 'cita.asistencia'] as const;

/**
 * EL TOPE DEL LOTE, y no es un número redondo por gusto: cada operación es su propia
 * transacción EN SERIE, así que un lote sin tope ocupa un trabajador tanto como operaciones
 * traiga, y el límite de ritmo cuenta PETICIONES, no operaciones. Un día entero sin señal de
 * una consulta ocupada no llega a doscientas; lo que no entra es un lote de diez mil, que es
 * un minuto de un proceso por una sola petición.
 */
const MAX_OPERATIONS = 200;

export type SyncResult = {
  aplicadas: number;
  rechazadas: readonly {
    clave: string;
    codigo: string;
    mensaje: string;
    datos?: unknown;
  }[];
};

export class SyncBatch {
  constructor(
    private readonly appointments: Appointments,
    private readonly guard: IdempotencyGuardPort,
  ) {}

  async run(input: unknown, caller: Caller): Promise<SyncResult> {
    const body = asRecord(input);
    const operations = Array.isArray(body.operaciones) ? body.operaciones : [];
    if (operations.length > MAX_OPERATIONS) {
      throw new ContractError('lote_demasiado_grande', { maximo: MAX_OPERATIONS });
    }

    let applied = 0;
    const rejected: { clave: string; codigo: string; mensaje: string; datos?: unknown }[] = [];

    for (const raw of operations) {
      const operation = asRecord(raw);
      const key = asText(operation.clave);
      const kind = asText(operation.tipo);
      const payload = asRecord(operation.datos);

      try {
        if (!OPERATIONS.includes(kind as (typeof OPERATIONS)[number])) {
          throw new ContractError('formato_no_admitido');
        }
        // Cada operación lleva SU clave de idempotencia: un lote reenviado no duplica nada, y
        // la huella del cuerpo es la misma que calcularía su endpoint.
        await this.apply(kind, key, payload, caller);
        applied += 1;
      } catch (failure) {
        if (failure instanceof ContractError) {
          // El MISMO cuerpo de error que habría devuelto su endpoint: el `codigo` y la frase
          // salen del propio error, no se reescriben aquí.
          const { error } = failure.body();
          rejected.push({
            clave: key,
            codigo: error.codigo,
            mensaje: error.mensaje,
            ...(failure.data === undefined ? {} : { datos: failure.data }),
          });
          continue;
        }
        // Un fallo que no es del contrato no se disfraza de rechazo del lote: si la base no
        // respondió, la app tiene que reintentar el lote entero y no tachar la operación.
        throw failure;
      }
    }

    return { aplicadas: applied, rechazadas: rejected };
  }

  private async apply(
    kind: string,
    key: string,
    payload: Record<string, unknown>,
    caller: Caller,
  ): Promise<void> {
    const id = asText(payload.cita_id);
    const record = { key, bodyHash: fingerprintOf(payload) };

    // `cita.crear` reserva la clave DENTRO de su propia transacción, que es donde mejor está:
    // lo que serializa dos reservas simultáneas es la clave primaria de `idempotency_key`.
    if (kind === 'cita.crear') {
      await this.appointments.book(payload, caller, record);
      return;
    }

    // Las otras tres no tienen dónde reservarla —su endpoint no lleva clave, porque por la
    // puerta de la app un `PATCH` o un `DELETE` son idempotentes por naturaleza—, y aquí sí
    // hace falta: el contrato del lote promete la clave de CADA operación, y `cita.mover`
    // reaplicada deshace un cambio posterior.
    await this.guard.run(
      {
        record,
        accountId: caller.accountId,
        practiceId: caller.practiceId!,
        unfinished: 'No pudimos aplicar esa operación, y puede que sí se haya aplicado.',
      },
      async () => {
        switch (kind) {
          case 'cita.mover':
            return this.appointments.reschedule(id, payload, caller);
          case 'cita.cancelar':
            return this.appointments.cancel(id, caller);
          default:
            return this.appointments.attendance(id, payload, caller);
        }
      },
    );
  }
}
