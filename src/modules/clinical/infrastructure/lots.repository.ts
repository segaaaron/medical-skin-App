// Los lotes y la consulta de retiro, con `app_practitioner`.
//
// `GET /v1/lots/{id}/patients` ES LA RAZÓN DE QUE `session_application` APUNTE AL LOTE: «dado un
// lote, qué pacientes lo recibieron. Es una sola consulta con índice, no un recorrido» (§12.2.4).
// Y lleva el celular a propósito: «cuando hay que llamar a catorce personas porque un lote se
// retira del mercado, obligar a abrir catorce fichas es un error de diseño con consecuencia
// sanitaria». Cada nombre que sale de ahí deja su línea de apertura de historial.

import type { Pool } from 'pg';

import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import { claim, complete, release } from '../../../shared/idempotency/idempotency-rows';
import type { ClinicalCaller, LotPort, LotRow } from '../domain/ports';
import type { LotDraft } from '../domain/session';

function contextOf(caller: ClinicalCaller): TenantContext {
  return { role: 'app_practitioner', practiceId: caller.practiceId, accountId: caller.accountId };
}

const LOT_SELECT = `
  select l.id, l.product_id, l.code, l.expires_on::text as expires_on, l.units, l.units_left,
         l.cost_cents, p.name as product_name
    from product_lot l join product p on p.id = l.product_id`;

export class LotsRepository implements LotPort {
  constructor(private readonly pool: Pool) {}

  async list(caller: ClinicalCaller): Promise<readonly LotRow[]> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // Por vencimiento ascendente: lo que primero caduca es lo primero que hay que mirar. Un
      // lote agotado sigue en la lista —«su historia es lo que importa»—.
      const { rows } = await c.query<Record<string, unknown>>(
        `${LOT_SELECT} order by l.expires_on, l.code`,
      );
      return rows.map(mapLot);
    });
  }

  async create(
    caller: ClinicalCaller,
    draft: LotDraft,
    idempotency: IdempotencyRecord,
  ): Promise<{
    outcome: 'created' | 'duplicate_code' | 'no_product';
    row: LotRow | null;
    replay: unknown;
  }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const replay = await claim<unknown>(c, {
        record: idempotency,
        accountId: caller.accountId,
        practiceId: caller.practiceId,
        unfinished: 'No pudimos guardar el lote, y puede que sí se haya guardado.',
      });
      if (replay !== null) return { outcome: 'created', row: null, replay: replay.response };

      const { rows: products } = await c.query(`select 1 from product where id = $1`, [
        draft.productId,
      ]);
      if (products.length === 0) {
        await release(c, { record: idempotency, accountId: caller.accountId });
        return { outcome: 'no_product', row: null, replay: null };
      }

      let id: string;
      await c.query('savepoint before_lot');
      try {
        const { rows } = await c.query<{ id: string }>(
          `insert into product_lot (practice_id, product_id, code, expires_on, units, units_left,
                                    cost_cents)
           values (medskin_current_practice(), $1, $2, $3::date, $4, $4, $5) returning id`,
          [draft.productId, draft.code, draft.expiresOn, draft.units, draft.costCents],
        );
        id = rows[0]!.id;
        await c.query('release savepoint before_lot');
      } catch (failure) {
        // El único del código por producto y consulta: dos lotes con el mismo código hacen
        // imposible la consulta de retiro, que es la única razón de que esta tabla exista.
        if (isUnique(failure)) {
          await c.query('rollback to savepoint before_lot');
          await release(c, { record: idempotency, accountId: caller.accountId });
          return { outcome: 'duplicate_code', row: null, replay: null };
        }
        throw failure;
      }

      await c.query(
        `insert into stock_movement (practice_id, lot_id, units, reason, actor_account_id)
         values (medskin_current_practice(), $1, $2, 'alta_de_lote', $3)`,
        [id, draft.units, caller.accountId],
      );

      const { rows } = await c.query<Record<string, unknown>>(`${LOT_SELECT} where l.id = $1`, [id]);
      const row = rows[0] === undefined ? null : mapLot(rows[0]);
      if (row === null) throw new Error(`el lote ${id} no se pudo releer tras crearlo`);
      await complete(c, {
        record: idempotency,
        accountId: caller.accountId,
        status: 201,
        response: row,
      });
      return { outcome: 'created', row, replay: null };
    });
  }

  async patients(
    caller: ClinicalCaller,
    lotId: string,
  ): Promise<
    | {
        lot: LotRow;
        patients: readonly {
          patientId: string;
          fullName: string;
          phone: string | null;
          sessionOn: string;
          units: number;
        }[];
      }
    | null
  > {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows: lots } = await c.query<Record<string, unknown>>(`${LOT_SELECT} where l.id = $1`, [
        lotId,
      ]);
      if (lots[0] === undefined) return null;

      // Las cuatro tablas del cruce van con política sobre `practice_id`: un lote de otra
      // consulta no devuelve filas, y no hace falta nombrar el inquilino en el `where`.
      const { rows } = await c.query<{
        patient_id: string;
        full_name: string;
        phone: string | null;
        session_on: string;
        units: string;
      }>(
        `select p.id as patient_id, p.first_name || ' ' || p.last_name as full_name, p.phone,
                (s.started_at)::date::text as session_on, sum(sa.total_units)::text as units
           from session_application sa
           join clinical_session s on s.id = sa.session_id
           join patient p on p.id = s.patient_id
          where sa.lot_id = $1 and s.status <> 'anulada'
          group by p.id, p.first_name, p.last_name, p.phone, s.started_at
          order by s.started_at desc`,
        [lotId],
      );

      // Cada nombre servido es una apertura de historial, y queda. «Obligar a abrir catorce
      // fichas es un error de diseño con consecuencia sanitaria», pero la apertura se registra
      // igual: lo que cambia es el número de toques, no la trazabilidad.
      for (const row of rows) {
        await c.query(
          `insert into access_audit (practice_id, actor_account_id, action, subject_type,
                                     subject_id, data)
           values (medskin_current_practice(), $1, 'paciente.ficha_abierta', 'paciente', $2,
                   jsonb_build_object('motivo', 'retiro_de_lote'))`,
          [caller.accountId, row.patient_id],
        );
      }

      return {
        lot: mapLot(lots[0]),
        patients: rows.map((row) => ({
          patientId: row.patient_id,
          fullName: row.full_name,
          phone: row.phone,
          sessionOn: row.session_on,
          units: Number(row.units),
        })),
      };
    });
  }
}

function mapLot(row: Record<string, unknown>): LotRow {
  return {
    id: row.id as string,
    productId: row.product_id as string,
    productName: row.product_name as string,
    code: row.code as string,
    expiresOn: row.expires_on as string,
    units: row.units as number,
    unitsLeft: row.units_left as number,
    costCents: (row.cost_cents as number | null) ?? null,
  };
}

function isUnique(failure: unknown): boolean {
  return (
    typeof failure === 'object' &&
    failure !== null &&
    (failure as { code?: string }).code === '23505'
  );
}
