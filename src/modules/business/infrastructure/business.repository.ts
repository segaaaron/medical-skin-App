// Cobros, márgenes, inventario, informes, plan y exportación.
//
// NINGÚN AGREGADO GLOBAL. Todos los informes se calculan bajo la política de RLS como cualquier
// otra lectura: «un informe es una consulta, no una excepción». No hay un «total de la
// plataforma» que alguien pueda leer por error, y no se cachean entre consultas.

import type { Pool, PoolClient } from 'pg';

import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import { claim, complete, release } from '../../../shared/idempotency/idempotency-rows';
import type {
  BusinessCaller,
  BusinessPort,
  MarginRow,
  PaymentRow,
  PlanRow,
} from '../domain/ports';
import type { MovementDraft, PaymentDraft } from '../domain/business';

function contextOf(caller: BusinessCaller): TenantContext {
  if (caller.isPatient) return { role: 'app_patient', accountId: caller.accountId };
  return { role: 'app_practitioner', practiceId: caller.practiceId, accountId: caller.accountId };
}

/** Menos de cinco pacientes y el agregado NO se devuelve: con dos filas, un promedio identifica. */
export const MIN_COHORT = 5;

export class BusinessRepository implements BusinessPort {
  constructor(private readonly pool: Pool) {}

  async charge(
    caller: BusinessCaller,
    draft: PaymentDraft,
    idempotency: IdempotencyRecord,
    render: (row: PaymentRow) => unknown,
  ): Promise<{
    outcome: 'charged' | 'no_session' | 'already' | 'no_credit';
    row: PaymentRow | null;
    credit: number;
    replay: unknown;
  }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // «Un reintento no puede cobrar dos veces»: la clave es obligatoria en este endpoint.
      const replay = await claim<unknown>(c, {
        record: idempotency,
        accountId: caller.accountId,
        practiceId: caller.practiceId,
        unfinished: 'No pudimos registrar el cobro, y puede que sí se haya registrado.',
      });
      if (replay !== null) {
        return { outcome: 'charged', row: null, credit: 0, replay: replay.response };
      }

      const fail = async (outcome: 'no_session' | 'already' | 'no_credit', credit = 0) => {
        await release(c, { record: idempotency, accountId: caller.accountId });
        return { outcome, row: null, credit, replay: null };
      };

      if (draft.sessionId !== null) {
        const { rows } = await c.query(`select 1 from clinical_session where id = $1`, [
          draft.sessionId,
        ]);
        if (rows.length === 0) return fail('no_session');
      }

      // El crédito de 90 días de una seña perdida: se comprueba que exista, que no esté vencido
      // y que alcance. «Si sobra, el resto sigue siendo crédito.»
      if (draft.method === 'credito_de_sena') {
        const available = await this.creditOf(c, draft.patientId);
        if (available < draft.cents) return fail('no_credit', available);
      }

      let id: string;
      await c.query('savepoint before_payment');
      try {
        const { rows } = await c.query<{ id: string }>(
          `insert into payment (practice_id, patient_id, session_id, appointment_id, concept,
                                cents, method, credit_used_cents, reference, charged_at,
                                actor_account_id)
           values (medskin_current_practice(), $1, $2, $3, $4, $5, $6, $7, $8,
                   coalesce($9, now()), $10)
           returning id`,
          [
            draft.patientId,
            draft.sessionId,
            draft.appointmentId,
            draft.concept,
            draft.cents,
            draft.method,
            draft.creditUsedCents,
            draft.reference,
            draft.chargedAt,
            caller.accountId,
          ],
        );
        id = rows[0]!.id;
        await c.query('release savepoint before_payment');
      } catch (failure) {
        // El único parcial de `(practice, session, concept)` entre los no anulados: «esa sesión
        // ya está cobrada», y lo decide la base, no una lectura previa.
        if (isUnique(failure)) {
          await c.query('rollback to savepoint before_payment');
          return fail('already');
        }
        throw failure;
      }

      const row = await this.readPayment(c, id);
      if (row === null) throw new Error(`el cobro ${id} no se pudo releer tras crearlo`);
      // Lo que se guarda es lo que el cliente recibio, no la fila interna: un reintento de un
      // COBRO tiene que devolver el MISMO 201, y la fila lleva campos que la paciente no ve.
      await complete(c, {
        record: idempotency,
        accountId: caller.accountId,
        status: 201,
        response: render(row),
      });
      return { outcome: 'charged', row, credit: 0, replay: null };
    });
  }

  async payments(
    caller: BusinessCaller,
    p: { patientId: string | null; from: string | null; to: string | null },
  ): Promise<readonly PaymentRow[]> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // La paciente no puede leer `method` ni `reference` —no están en su `GRANT`—, así que su
      // consulta nombra menos columnas. El rol decide la forma, no un `if` de la app.
      const columns = caller.isPatient
        ? 'id, patient_id, session_id, concept, cents, charged_at, voided_at'
        : `id, patient_id, session_id, concept, cents, method, credit_used_cents, reference,
           charged_at, voided_at, voided_reason`;
      const { rows } = await c.query<Record<string, unknown>>(
        `select ${columns} from payment
          where ($1::uuid is null or patient_id = $1)
            and ($2::date is null or charged_at::date >= $2)
            and ($3::date is null or charged_at::date <= $3)
          order by charged_at desc`,
        [p.patientId, p.from, p.to],
      );
      return rows.map(mapPayment);
    });
  }

  async voidPayment(
    caller: BusinessCaller,
    paymentId: string,
    reason: string,
  ): Promise<{ outcome: 'voided' | 'no_payment'; id: string | null }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query<Record<string, unknown>>(
        `select id, patient_id, session_id, appointment_id, concept, cents, method
           from payment where id = $1 and voided_at is null`,
        [paymentId],
      );
      const original = rows[0];
      if (original === undefined) return { outcome: 'no_payment', id: null };

      // «Un cobro no se borra: se anula con su motivo, y la anulación es OTRA FILA.»
      await c.query(
        `update payment set voided_at = now(), voided_reason = $2 where id = $1`,
        [paymentId, reason],
      );
      const { rows: added } = await c.query<{ id: string }>(
        `insert into payment (practice_id, patient_id, session_id, appointment_id, concept,
                              cents, method, reference, voids_payment_id, actor_account_id,
                              voided_at, voided_reason)
         values (medskin_current_practice(), $1, $2, $3, $4, $5, $6, 'anulacion', $7, $8,
                 now(), $9)
         returning id`,
        [
          original.patient_id,
          original.session_id,
          original.appointment_id,
          original.concept,
          original.cents,
          original.method,
          paymentId,
          caller.accountId,
          reason,
        ],
      );
      return { outcome: 'voided', id: added[0]?.id ?? null };
    });
  }

  async margins(
    caller: BusinessCaller,
    p: { from: string | null; to: string | null },
  ): Promise<{ rows: readonly MarginRow[]; withoutCost: number; currency: string }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // EL COSTO SALE DEL LOTE APLICADO, no de un promedio: `cost_cents / units` es lo que
      // costó cada unidad de ESE lote, y por eso un margen de marzo no cambia en octubre.
      const { rows } = await c.query<Record<string, unknown>>(
        `with aplicado as (
           select s.id as session_id, t.name as treatment,
                  sum(sa.total_units) as units,
                  sum(case when l.cost_cents is null then null
                           else round(l.cost_cents::numeric / l.units * sa.total_units) end)
                    as cost_cents
             from clinical_session s
             join appointment a on a.id = s.appointment_id
             join treatment t on t.id = a.treatment_id
             join session_application sa on sa.session_id = s.id
             join product_lot l on l.id = sa.lot_id
            where s.status <> 'anulada'
              and ($1::date is null or s.started_at::date >= $1)
              and ($2::date is null or s.started_at::date <= $2)
            group by s.id, t.name
         ),
         cobrado as (
           select p.session_id, sum(p.cents) as cents
             from payment p
            where p.voided_at is null and p.session_id is not null
            group by p.session_id
         )
         select ap.treatment,
                count(*)::text as sessions,
                coalesce(sum(co.cents), 0)::text as charged,
                coalesce(sum(ap.cost_cents), 0)::text as cost,
                coalesce(sum(ap.units), 0)::text as units,
                count(*) filter (where ap.cost_cents is null)::text as without_cost
           from aplicado ap
           left join cobrado co on co.session_id = ap.session_id
          group by ap.treatment
          order by ap.treatment`,
        [p.from, p.to],
      );

      const { rows: currency } = await c.query<{ currency: string }>(
        `select currency from practice`,
      );

      let withoutCost = 0;
      const margins = rows.map((row) => {
        withoutCost += Number(row.without_cost ?? 0);
        const charged = Number(row.charged ?? 0);
        const cost = Number(row.cost ?? 0);
        return {
          treatment: row.treatment as string,
          sessions: Number(row.sessions ?? 0),
          chargedCents: charged,
          costCents: cost,
          marginCents: charged - cost,
          // El porcentaje solo cuando hay cobrado: dividir por cero daría un número inventado.
          marginPercent: charged === 0 ? null : Math.round(((charged - cost) / charged) * 1000) / 10,
          units: Number(row.units ?? 0),
        };
      });

      return { rows: margins, withoutCost, currency: currency[0]?.currency ?? '' };
    });
  }

  async inventory(caller: BusinessCaller): Promise<
    readonly {
      productId: string;
      name: string;
      unitsLeft: number;
      lots: readonly { id: string; code: string; expiresOn: string; unitsLeft: number }[];
    }[]
  > {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query<Record<string, unknown>>(
        `select p.id as product_id, p.name,
                coalesce(sum(l.units_left), 0)::text as units_left,
                coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'code', l.code,
                                   'expiresOn', l.expires_on::text, 'unitsLeft', l.units_left)
                                   order by l.expires_on)
                         filter (where l.id is not null), '[]'::jsonb) as lots
           from product p
           left join product_lot l on l.product_id = p.id
          where p.status = 'activo'
          group by p.id, p.name
          order by p.name`,
      );
      return rows.map((row) => ({
        productId: row.product_id as string,
        name: row.name as string,
        unitsLeft: Number(row.units_left ?? 0),
        lots: row.lots as { id: string; code: string; expiresOn: string; unitsLeft: number }[],
      }));
    });
  }

  async addProduct(
    caller: BusinessCaller,
    p: { name: string; unit: string },
    idempotency: IdempotencyRecord,
  ): Promise<{ id: string | null; replay: unknown }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const replay = await claim<unknown>(c, {
        record: idempotency,
        accountId: caller.accountId,
        practiceId: caller.practiceId,
        unfinished: 'No pudimos guardar el producto, y puede que sí se haya guardado.',
      });
      if (replay !== null) return { id: null, replay: replay.response };

      const { rows } = await c.query<{ id: string }>(
        `insert into product (practice_id, name, unit)
         values (medskin_current_practice(), $1, $2) returning id`,
        [p.name, p.unit],
      );
      const id = rows[0]!.id;
      await complete(c, {
        record: idempotency,
        accountId: caller.accountId,
        status: 201,
        response: { id, nombre: p.name },
      });
      return { id, replay: null };
    });
  }

  async move(
    caller: BusinessCaller,
    draft: MovementDraft,
    idempotency: IdempotencyRecord,
  ): Promise<{ outcome: 'moved' | 'no_lot' | 'negative'; left: number; replay: unknown }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const replay = await claim<unknown>(c, {
        record: idempotency,
        accountId: caller.accountId,
        practiceId: caller.practiceId,
        unfinished: 'No pudimos guardar el movimiento, y puede que sí se haya guardado.',
      });
      if (replay !== null) return { outcome: 'moved', left: 0, replay: replay.response };

      const { rows } = await c.query<{ units: number; units_left: number }>(
        `select units, units_left from product_lot where id = $1 for update`,
        [draft.lotId],
      );
      const lot = rows[0];
      if (lot === undefined) {
        await release(c, { record: idempotency, accountId: caller.accountId });
        return { outcome: 'no_lot', left: 0, replay: null };
      }

      const delta = draft.kind === 'entrada' || draft.kind === 'devolucion' ? draft.units : -draft.units;
      const left = lot.units_left + delta;
      // «Un inventario negativo no es un dato, es un error que se arrastra.»
      if (left < 0) {
        await release(c, { record: idempotency, accountId: caller.accountId });
        return { outcome: 'negative', left: lot.units_left, replay: null };
      }

      await c.query(
        // El tope es `units` del lote: una entrada no puede inventar unidades que nunca
        // entraron, y el `CHECK` de la 0035 lo garantiza además de esta cuenta.
        `update product_lot set units_left = $2, units = greatest(units, $2), updated_at = now()
          where id = $1`,
        [draft.lotId, left],
      );
      await c.query(
        `insert into inventory_movement (practice_id, lot_id, kind, units, reason,
                                         actor_account_id)
         values (medskin_current_practice(), $1, $2, $3, $4, $5)`,
        [draft.lotId, draft.kind, delta, draft.reason, caller.accountId],
      );
      await complete(c, {
        record: idempotency,
        accountId: caller.accountId,
        status: 201,
        response: { quedan: left },
      });
      return { outcome: 'moved', left, replay: null };
    });
  }

  async report(
    caller: BusinessCaller,
    p: { kind: string; from: string | null; to: string | null },
  ): Promise<{ suppressed: boolean; rows: readonly Record<string, unknown>[] }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      if (p.kind === 'ingresos') {
        const { rows } = await c.query<Record<string, unknown>>(
          `select to_char(charged_at, 'YYYY-MM') as mes, method as medio,
                  sum(cents)::text as centavos, count(distinct patient_id)::text as pacientes
             from payment
            where voided_at is null
              and ($1::date is null or charged_at::date >= $1)
              and ($2::date is null or charged_at::date <= $2)
            group by 1, 2 order by 1, 2`,
          [p.from, p.to],
        );
        return this.suppress(rows);
      }
      if (p.kind === 'ausencias') {
        // LA ÚNICA EXCEPCIÓN: `ausencias` SÍ nombra a quien no se presentó, «porque la doctora
        // necesita hablar con ella y ya tiene su ficha abierta». Y queda en la auditoría como
        // el acceso que es.
        const { rows } = await c.query<Record<string, unknown>>(
          `select a.id, a.starts_at, a.status, a.cancelled_by, a.cancelled_at,
                  pa.first_name || ' ' || pa.last_name as paciente,
                  extract(epoch from (a.starts_at - a.cancelled_at)) / 3600 as aviso_horas
             from appointment a join patient pa on pa.id = a.patient_id
            where a.status in ('cancelada', 'no_asistio')
              and ($1::date is null or a.starts_at::date >= $1)
              and ($2::date is null or a.starts_at::date <= $2)
            order by a.starts_at desc`,
          [p.from, p.to],
        );
        for (const row of rows) {
          await c.query(
            `insert into access_audit (practice_id, actor_account_id, action, subject_type,
                                       subject_id, data)
             values (medskin_current_practice(), $1, 'paciente.ficha_abierta', 'cita', $2,
                     jsonb_build_object('motivo', 'informe_ausencias'))`,
            [caller.accountId, row.id],
          );
        }
        return { suppressed: false, rows };
      }
      if (p.kind === 'repeticion') {
        const { rows } = await c.query<Record<string, unknown>>(
          `select count(*)::text as pacientes,
                  count(*) filter (where veces > 1)::text as volvieron,
                  round(avg(dias) filter (where dias is not null))::text as dias_promedio
             from (
               select s.patient_id, count(*) as veces,
                      extract(day from max(s.started_at) - min(s.started_at)) as dias
                 from clinical_session s
                where s.status <> 'anulada'
                group by s.patient_id
             ) por_paciente`,
        );
        return this.suppress(rows, Number(rows[0]?.pacientes ?? 0));
      }
      // `ocupacion`: huecos ofrecidos contra ocupados. Sin la agenda histórica de huecos
      // ofrecidos, lo que se puede contar de verdad son las citas por día y franja — y eso es
      // lo que se devuelve, en vez de inventar un denominador.
      const { rows } = await c.query<Record<string, unknown>>(
        `select to_char(starts_at, 'ID') as dia_semana,
                to_char(starts_at, 'HH24') as hora,
                count(*)::text as citas,
                count(*) filter (where status = 'atendida')::text as atendidas
           from appointment
          where ($1::date is null or starts_at::date >= $1)
            and ($2::date is null or starts_at::date <= $2)
          group by 1, 2 order by 1, 2`,
        [p.from, p.to],
      );
      return this.suppress(rows);
    });
  }

  async plan(caller: BusinessCaller): Promise<PlanRow | null> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query<Record<string, unknown>>(
        `select p.plan, p.patient_limit, p.currency, p.plan_renews_on::text as renews_on,
                (select count(*) from patient where practice_id = p.id and status = 'activa')::text
                  as patients,
                medskin_practice_photo_bytes(p.id)::text as photo_bytes
           from practice p`,
      );
      const row = rows[0];
      if (row === undefined) return null;
      return {
        plan: row.plan as string,
        patientLimit: row.patient_limit as number,
        patients: Number(row.patients ?? 0),
        photoBytes: Number(row.photo_bytes ?? 0),
        renewsOn: (row.renews_on as string | null) ?? null,
      };
    });
  }

  async requestPlan(caller: BusinessCaller, wanted: string, note: string | null): Promise<string | null> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // NO COBRA: crea una solicitud y la consola la resuelve. Misma razón que todo el tramo.
      const { rows } = await c.query<{ id: string }>(
        `insert into plan_request (practice_id, wanted_plan, note, requested_by_account_id)
         values (medskin_current_practice(), $1, $2, $3) returning id`,
        [wanted, note, caller.accountId],
      );
      return rows[0]?.id ?? null;
    });
  }

  async requestExport(
    caller: BusinessCaller,
    idempotency: IdempotencyRecord,
    render: (id: string) => unknown,
  ): Promise<{ outcome: 'queued' | 'too_soon'; id: string | null; replay: unknown }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // LA RESERVA ANTES DE ESCRIBIR NADA, como los demás `POST` que crean algo. Y aquí tiene
      // una consecuencia que no tienen los otros: el único-por-día lo garantiza un índice, así
      // que sin clave un `202` perdido devolvía `429` al reintento y la app **nunca llegaba a
      // conocer el `id`** de la exportación que sí se había creado. El contrato la exige.
      const replay = await claim<unknown>(c, {
        record: idempotency,
        accountId: caller.accountId,
        practiceId: caller.isPatient ? null : caller.practiceId,
        unfinished: 'No pudimos preparar tu copia, y puede que sí se haya pedido.',
      });
      if (replay !== null) {
        return { outcome: 'queued', id: null, replay: replay.response };
      }

      await c.query('savepoint before_export');
      let id: string | null;
      try {
        const { rows } = await c.query<{ id: string }>(
          `insert into data_export (account_id, practice_id)
           values (medskin_current_account(), $1) returning id`,
          [caller.isPatient ? null : caller.practiceId],
        );
        await c.query('release savepoint before_export');
        id = rows[0]?.id ?? null;
      } catch (failure) {
        // Una solicitud por día y por cuenta, garantizada por el único sobre el día.
        if (isUnique(failure)) {
          await c.query('rollback to savepoint before_export');
          await release(c, { record: idempotency, accountId: caller.accountId });
          return { outcome: 'too_soon', id: null, replay: null };
        }
        throw failure;
      }
      if (id === null) throw new Error('la exportación no devolvió su identificador');

      await complete(c, {
        record: idempotency,
        accountId: caller.accountId,
        status: 202,
        response: render(id),
      });
      return { outcome: 'queued', id, replay: null };
    });
  }

  async exportStatus(
    caller: BusinessCaller,
    exportId: string,
  ): Promise<{ status: string; expiresAt: Date | null } | null> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query<{ status: string; expires_at: Date | null }>(
        `select status, expires_at from data_export where id = $1`,
        [exportId],
      );
      const row = rows[0];
      return row === undefined ? null : { status: row.status, expiresAt: row.expires_at };
    });
  }

  // -----------------------------------------------------------------------------------

  /** El crédito vivo de una seña perdida: 90 días desde la cancelación. */
  private async creditOf(c: PoolClient, patientId: string): Promise<number> {
    const { rows } = await c.query<{ cents: string }>(
      `select coalesce(sum(a.deposit_cents), 0)::text as cents
         from appointment a
        where a.patient_id = $1 and a.deposit_status = 'credito'
          and a.cancelled_at > now() - interval '90 days'
          and not exists (select 1 from payment p
                           where p.patient_id = a.patient_id
                             and p.method = 'credito_de_sena' and p.voided_at is null
                             and p.charged_at > a.cancelled_at)`,
      [patientId],
    );
    return Number(rows[0]?.cents ?? 0);
  }

  /** Menos de cinco pacientes: no se devuelve. «Con dos filas, un promedio identifica a las dos.» */
  private suppress(
    rows: readonly Record<string, unknown>[],
    cohort?: number,
  ): { suppressed: boolean; rows: readonly Record<string, unknown>[] } {
    const people =
      cohort ??
      rows.reduce((total, row) => total + Number(row.pacientes ?? row.citas ?? 0), 0);
    if (rows.length > 0 && people > 0 && people < MIN_COHORT) {
      return { suppressed: true, rows: [] };
    }
    return { suppressed: false, rows };
  }

  private async readPayment(c: PoolClient, id: string): Promise<PaymentRow | null> {
    const { rows } = await c.query<Record<string, unknown>>(
      `select id, patient_id, session_id, concept, cents, method, credit_used_cents, reference,
              charged_at, voided_at, voided_reason
         from payment where id = $1`,
      [id],
    );
    return rows[0] === undefined ? null : mapPayment(rows[0]);
  }
}

function mapPayment(row: Record<string, unknown>): PaymentRow {
  return {
    id: row.id as string,
    patientId: row.patient_id as string,
    sessionId: (row.session_id as string | null) ?? null,
    concept: row.concept as string,
    cents: row.cents as number,
    method: (row.method as string | undefined) ?? null,
    creditUsedCents: (row.credit_used_cents as number | undefined) ?? 0,
    reference: (row.reference as string | null | undefined) ?? null,
    chargedAt: row.charged_at as Date,
    voidedAt: (row.voided_at as Date | null) ?? null,
  };
}

function isUnique(failure: unknown): boolean {
  return (
    typeof failure === 'object' &&
    failure !== null &&
    (failure as { code?: string }).code === '23505'
  );
}
