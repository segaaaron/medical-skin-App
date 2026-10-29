// LA CLAVE DE UNA OPERACIÓN QUE NO TIENE DÓNDE RESERVARLA.
//
// `POST /v1/sync` promete en su contrato «idempotente **por la clave de cada operación del
// lote**», y de sus cuatro operaciones solo una —`cita.crear`— pasaba por un endpoint que
// reserva la clave: mover, cancelar y asistencia iban sin ella. Las tres son idempotentes por
// su EFECTO hoy, y aun así `cita.mover` reaplicada deshace un cambio posterior: un lote
// reenviado devolvía una cita al horario viejo.
//
// Esto no es una segunda implementación de la idempotencia: usa la misma tabla y las mismas
// tres funciones (`claim`, `complete`, `release`). Lo que cambia es DÓNDE: la operación de la
// agenda abre su propia transacción, así que la reserva va en una transacción corta de antes y
// el cierre en otra de después, en vez de dentro de la del endpoint.
//
// LO QUE ESO CUESTA, DICHO SIN ESCONDERLO: entre la reserva y el cierre hay dos `COMMIT`, así
// que un proceso que muera justo en medio deja la reserva abierta, y la siguiente vez que
// llegue esa clave el lote recibe el `500` de «ya ocurrió y no lo repetimos». Es la misma
// decisión que los dos endpoints que mandan correo (`idempotency-rows.ts`) y es la correcta
// aquí: reaplicar en silencio es peor que decir que no se sabe.

import type { Pool } from 'pg';

import { withTenantContext, type TenantContext } from '../db/tenant-context';
import { claim, complete, release } from './idempotency-rows';
import type { IdempotencyRecord } from './idempotency-key';

export interface IdempotencyGuardPort {
  run(
    p: { record: IdempotencyRecord; accountId: string; practiceId: string; unfinished: string },
    operation: () => Promise<unknown>,
  ): Promise<unknown>;
}

export class IdempotencyGuard implements IdempotencyGuardPort {
  constructor(private readonly pool: Pool) {}

  async run(
    p: { record: IdempotencyRecord; accountId: string; practiceId: string; unfinished: string },
    operation: () => Promise<unknown>,
  ): Promise<unknown> {
    const context: TenantContext = {
      role: 'app_practitioner',
      practiceId: p.practiceId,
      accountId: p.accountId,
    };

    const replay = await withTenantContext(this.pool, context, async (c) =>
      claim<unknown>(c, {
        record: p.record,
        accountId: p.accountId,
        practiceId: p.practiceId,
        unfinished: p.unfinished,
      }),
    );
    if (replay !== null) return replay.response;

    let answer: unknown;
    try {
      answer = await operation();
    } catch (failure) {
      // La reserva se suelta: la operación no ocurrió, así que la clave vuelve a estar libre y
      // el mismo lote se puede reenviar. Sin esto, un rechazo del contrato —un hueco ocupado—
      // quemaría la clave y el reintento recibiría un 500 en vez del mismo rechazo.
      await withTenantContext(this.pool, context, async (c) =>
        release(c, { record: p.record, accountId: p.accountId }),
      );
      throw failure;
    }

    await withTenantContext(this.pool, context, async (c) =>
      complete(c, {
        record: p.record,
        accountId: p.accountId,
        status: 200,
        response: answer ?? null,
      }),
    );
    return answer;
  }
}
