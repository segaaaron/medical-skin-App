// El expediente contra la base, con `app_practitioner`.
//
// TODO LO DE UNA SESIÓN OCURRE EN UNA TRANSACCIÓN: la sesión, sus aplicaciones, sus puntos, el
// descuento de stock y su movimiento. «Un inventario que se actualiza después es un inventario
// que miente cada vez que algo falla en medio.»

import type { Pool, PoolClient } from 'pg';

import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import { claim, complete, release } from '../../../shared/idempotency/idempotency-rows';
import type { ClinicalCaller, ClinicalPort, SessionRow } from '../domain/ports';
import { mergeNote, noteIsEmpty, type AdverseEventDraft, type NoteConflict, type SessionDraft } from '../domain/session';

function contextOf(caller: ClinicalCaller): TenantContext {
  return { role: 'app_practitioner', practiceId: caller.practiceId, accountId: caller.accountId };
}

export class ClinicalRepository implements ClinicalPort {
  constructor(private readonly pool: Pool) {}

  async create(
    caller: ClinicalCaller,
    draft: SessionDraft,
    idempotency: IdempotencyRecord,
  ): Promise<{
    outcome:
      | 'created'
      | 'no_appointment'
      | 'not_attended'
      | 'already_has_session'
      | 'no_lot'
      | 'expired_lot'
      | 'no_stock';
    row: SessionRow | null;
    replay: unknown;
  }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // Se registra desde la sala y con mala señal: sin clave, un reintento deja dos
      // expedientes de la misma sesión y el stock descontado dos veces.
      const replay = await claim<unknown>(c, {
        record: idempotency,
        accountId: caller.accountId,
        practiceId: caller.practiceId,
        unfinished: 'No pudimos guardar la sesión, y puede que sí se haya guardado.',
      });
      if (replay !== null) return { outcome: 'created', row: null, replay: replay.response };

      const fail = async (
        outcome: 'no_appointment' | 'not_attended' | 'already_has_session' | 'no_lot' | 'expired_lot' | 'no_stock',
      ) => {
        await release(c, { record: idempotency, accountId: caller.accountId });
        return { outcome, row: null, replay: null };
      };

      const { rows: appointments } = await c.query<{
        patient_id: string;
        status: string;
        treatment_id: string;
      }>(
        `select patient_id, status, treatment_id from appointment where id = $1 for update`,
        [draft.appointmentId],
      );
      const appointment = appointments[0];
      if (appointment === undefined) return fail('no_appointment');
      // «Marca primero que llegó»: una sesión cuelga de una cita ATENDIDA.
      if (appointment.status !== 'atendida') return fail('not_attended');

      const { rows: existing } = await c.query(
        `select 1 from clinical_session where appointment_id = $1 and status <> 'anulada'`,
        [draft.appointmentId],
      );
      if (existing.length > 0) return fail('already_has_session');

      // Los lotes, antes de escribir nada: vencido BLOQUEA, y sin stock también.
      for (const application of draft.applications) {
        const { rows } = await c.query<{ expires_on: string; units_left: number }>(
          `select expires_on::text as expires_on, units_left from product_lot
            where id = $1 for update`,
          [application.lotId],
        );
        const lot = rows[0];
        if (lot === undefined) return fail('no_lot');
        if (lot.expires_on < new Date().toISOString().slice(0, 10)) return fail('expired_lot');
        if (lot.units_left < application.totalUnits) return fail('no_stock');
      }

      const { rows: created } = await c.query<{ id: string }>(
        `insert into clinical_session (practice_id, patient_id, appointment_id,
                                       practitioner_account_id, started_at, ended_at,
                                       observations)
         values (medskin_current_practice(), $1, $2, $3, $4, $5, $6)
         returning id`,
        [
          appointment.patient_id,
          draft.appointmentId,
          caller.accountId,
          draft.startedAt,
          draft.endedAt,
          draft.observations,
        ],
      );
      const sessionId = created[0]!.id;

      const stock: { lotId: string; units: number; left: number }[] = [];
      for (const application of draft.applications) {
        const { rows: inserted } = await c.query<{ id: string }>(
          `insert into session_application (practice_id, session_id, lot_id, zone, technique,
                                            depth, total_units)
           values (medskin_current_practice(), $1, $2, $3, $4, $5, $6) returning id`,
          [
            sessionId,
            application.lotId,
            application.zone,
            application.technique,
            application.depth,
            application.totalUnits,
          ],
        );
        const applicationId = inserted[0]!.id;

        for (const point of application.points) {
          await c.query(
            `insert into application_point (practice_id, application_id, zone, x, y, units)
             values (medskin_current_practice(), $1, $2, $3, $4, $5)`,
            [applicationId, point.zone, point.x, point.y, point.units],
          );
        }

        // El stock, EN ESTA MISMA TRANSACCIÓN, con su movimiento.
        const { rows: left } = await c.query<{ units_left: number }>(
          `update product_lot set units_left = units_left - $2, updated_at = now()
            where id = $1 returning units_left`,
          [application.lotId, application.totalUnits],
        );
        await c.query(
          `insert into stock_movement (practice_id, lot_id, session_id, units, reason,
                                       actor_account_id)
           values (medskin_current_practice(), $1, $2, $3, 'aplicacion', $4)`,
          [application.lotId, sessionId, -application.totalUnits, caller.accountId],
        );
        stock.push({
          lotId: application.lotId,
          units: application.totalUnits,
          left: left[0]?.units_left ?? 0,
        });
      }

      // La nota nace vacía: «la sesión nace en borrador y el expediente no se cierra hasta
      // firmar la nota».
      await c.query(
        `insert into session_note (practice_id, session_id) values (medskin_current_practice(), $1)`,
        [sessionId],
      );

      const row = await this.readOne(c, sessionId, stock);
      if (row === null) throw new Error(`la sesión ${sessionId} no se pudo releer tras crearla`);
      await complete(c, {
        record: idempotency,
        accountId: caller.accountId,
        status: 201,
        response: row,
      });
      return { outcome: 'created', row, replay: null };
    });
  }

  async one(caller: ClinicalCaller, sessionId: string): Promise<SessionRow | null> {
    return withTenantContext(this.pool, contextOf(caller), async (c) =>
      this.readOne(c, sessionId, []),
    );
  }

  async saveDraft(
    caller: ClinicalCaller,
    sessionId: string,
    p: { incoming: Record<string, unknown>; seenAt: Date | null; author: string; now: Date },
  ): Promise<
    | { outcome: 'saved'; saved: readonly string[]; conflicts: readonly NoteConflict[] }
    | { outcome: 'no_session' | 'signed' | 'voided' }
  > {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query<{
        id: string;
        fields: Record<string, { value: string; at: string; by: string }>;
        conflicts: NoteConflict[];
        signed_at: Date | null;
        status: string;
      }>(
        `select n.id, n.fields, n.conflicts, n.signed_at, s.status
           from session_note n join clinical_session s on s.id = n.session_id
          where n.session_id = $1 for update of n`,
        [sessionId],
      );
      const note = rows[0];
      if (note === undefined) return { outcome: 'no_session' };
      if (note.status === 'anulada') return { outcome: 'voided' };
      // Firmada: ya no se edita. «Para corregirla, agrega una corrección.»
      if (note.signed_at !== null) return { outcome: 'signed' };

      const merged = mergeNote({
        incoming: p.incoming,
        seenAt: p.seenAt,
        current: note.fields,
        author: p.author,
        now: p.now,
      });

      // Los conflictos se ACUMULAN y no se reemplazan: dos pantallas pueden dejar dos campos
      // en conflicto, y resolver uno no borra el otro.
      const conflicts = [
        ...note.conflicts.filter((old) => !merged.conflicts.some((fresh) => fresh.campo === old.campo)),
        ...merged.conflicts,
      ].filter((conflict) => !merged.saved.includes(conflict.campo));

      await c.query(
        `update session_note set fields = $2::jsonb, conflicts = $3::jsonb, updated_at = now()
          where id = $1`,
        [note.id, JSON.stringify(merged.fields), JSON.stringify(conflicts)],
      );

      return { outcome: 'saved', saved: merged.saved, conflicts: merged.conflicts };
    });
  }

  async sign(
    caller: ClinicalCaller,
    sessionId: string,
    now: Date,
  ): Promise<{
    outcome: 'signed' | 'no_session' | 'empty' | 'conflicts' | 'no_consent' | 'voided';
    row: SessionRow | null;
    aftercare: number;
  }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query<{
        id: string;
        fields: Record<string, { value: string }>;
        conflicts: unknown[];
        signed_at: Date | null;
        status: string;
        treatment_id: string;
        patient_id: string;
        requires_consent: boolean;
      }>(
        `select n.id, n.fields, n.conflicts, n.signed_at, s.status, a.treatment_id, s.patient_id,
                t.requires_consent
           from session_note n
           join clinical_session s on s.id = n.session_id
           join appointment a on a.id = s.appointment_id
           join treatment t on t.id = a.treatment_id
          where n.session_id = $1 for update of n`,
        [sessionId],
      );
      const note = rows[0];
      if (note === undefined) return { outcome: 'no_session', row: null, aftercare: 0 };
      if (note.status === 'anulada') return { outcome: 'voided', row: null, aftercare: 0 };
      // Firmar lo firmado devuelve el mismo 200: idempotente por naturaleza.
      if (note.signed_at !== null) {
        return { outcome: 'signed', row: await this.readOne(c, sessionId, []), aftercare: 0 };
      }
      if (noteIsEmpty(note.fields)) return { outcome: 'empty', row: null, aftercare: 0 };
      if (note.conflicts.length > 0) return { outcome: 'conflicts', row: null, aftercare: 0 };

      if (note.requires_consent) {
        const { rows: consents } = await c.query(
          `select 1 from consent
            where patient_id = $1 and treatment_id = $2 and purpose = 'clinico'
              and revoked_at is null`,
          [note.patient_id, note.treatment_id],
        );
        if (consents.length === 0) return { outcome: 'no_consent', row: null, aftercare: 0 };
      }

      const { rows: practitioners } = await c.query<{ id: string }>(
        `select id from practitioner where account_id = $1 and status = 'activa'`,
        [caller.accountId],
      );

      await c.query(
        `update session_note set signed_at = $2, signed_by_practitioner_id = $3 where id = $1`,
        [note.id, now, practitioners[0]?.id ?? null],
      );
      await c.query(
        `update clinical_session set status = 'firmada' where id = $1`,
        [sessionId],
      );

      // FIRMAR ES LO QUE PROGRAMA LOS CUIDADOS, con el protocolo COPIADO en este momento: el
      // texto y la hora se guardan en `care_step`, no se enlazan al protocolo. «Cambiar el
      // protocolo después no mueve lo que ya se le mandó, y una paciente no ve cambiar
      // instrucciones que ya cumplió.»
      const { rows: plans } = await c.query<{ id: string }>(
        `insert into care_plan (practice_id, patient_id, session_id, practice_name,
                                treatment_name, session_at)
         select medskin_current_practice(), s.patient_id, s.id,
                (select l.practice_name from patient_link l
                  where l.patient_id = s.patient_id limit 1),
                t.name, s.started_at
           from clinical_session s
           join appointment a on a.id = s.appointment_id
           join treatment t on t.id = a.treatment_id
          where s.id = $1
         returning id`,
        [sessionId],
      );
      const planId = plans[0]?.id ?? null;

      const { rows: steps } = await c.query<{ offset_hours: number; text: string }>(
        `select offset_hours, text from treatment_protocol_step
          where treatment_id = $1 and moment = 'despues' order by offset_hours`,
        [note.treatment_id],
      );
      if (planId !== null) {
        for (const step of steps) {
          // El instante YA CALCULADO desde el fin de la sesión: la app lo necesita así para
          // agendar su aviso local y que el recordatorio funcione sin conexión.
          await c.query(
            `insert into care_step (practice_id, plan_id, appears_at, text)
             select medskin_current_practice(), $1,
                    s.ended_at + make_interval(hours => $2), $3
               from clinical_session s where s.id = $4`,
            [planId, step.offset_hours, step.text, sessionId],
          );
        }
      }

      return {
        outcome: 'signed',
        row: await this.readOne(c, sessionId, []),
        aftercare: steps.length,
      };
    });
  }

  async correct(
    caller: ClinicalCaller,
    sessionId: string,
    p: { text: string; reason: string },
  ): Promise<{ outcome: 'added' | 'no_session' | 'not_signed'; id: string | null }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query<{ id: string; signed_at: Date | null }>(
        `select id, signed_at from session_note where session_id = $1`,
        [sessionId],
      );
      const note = rows[0];
      if (note === undefined) return { outcome: 'no_session', id: null };
      // «Esa nota aún no está firmada: edítala.» Una corrección de un borrador no es una
      // corrección, es una edición.
      if (note.signed_at === null) return { outcome: 'not_signed', id: null };

      const { rows: practitioners } = await c.query<{ id: string }>(
        `select id from practitioner where account_id = $1 and status = 'activa'`,
        [caller.accountId],
      );
      // La última corrección de la cadena, para que la nueva apunte a ella: «la ficha muestra
      // la nota original y sus correcciones en orden».
      const { rows: last } = await c.query<{ id: string }>(
        `select id from note_correction where note_id = $1 order by created_at desc limit 1`,
        [note.id],
      );

      const { rows: added } = await c.query<{ id: string }>(
        `insert into note_correction (practice_id, note_id, corrects_correction_id, text, reason,
                                      author_practitioner_id)
         values (medskin_current_practice(), $1, $2, $3, $4, $5) returning id`,
        [note.id, last[0]?.id ?? null, p.text, p.reason, practitioners[0]?.id ?? null],
      );
      return { outcome: 'added', id: added[0]?.id ?? null };
    });
  }

  async adverseEvent(
    caller: ClinicalCaller,
    sessionId: string,
    draft: AdverseEventDraft,
    idempotency: IdempotencyRecord,
  ): Promise<{ outcome: 'added' | 'no_session' | 'no_lot'; id: string | null; replay: unknown }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const replay = await claim<unknown>(c, {
        record: idempotency,
        accountId: caller.accountId,
        practiceId: caller.practiceId,
        unfinished: 'No pudimos registrar el evento, y puede que sí se haya registrado.',
      });
      if (replay !== null) return { outcome: 'added', id: null, replay: replay.response };

      const { rows } = await c.query<{ patient_id: string }>(
        `select patient_id from clinical_session where id = $1`,
        [sessionId],
      );
      const session = rows[0];
      if (session === undefined) {
        await release(c, { record: idempotency, accountId: caller.accountId });
        return { outcome: 'no_session', id: null, replay: null };
      }
      if (draft.lotId !== null) {
        const { rows: lots } = await c.query(`select 1 from product_lot where id = $1`, [
          draft.lotId,
        ]);
        if (lots.length === 0) {
          await release(c, { record: idempotency, accountId: caller.accountId });
          return { outcome: 'no_lot', id: null, replay: null };
        }
      }

      const { rows: added } = await c.query<{ id: string }>(
        `insert into adverse_event (practice_id, session_id, patient_id, kind, severity,
                                    appeared_at, description, management, lot_id)
         values (medskin_current_practice(), $1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [
          sessionId,
          session.patient_id,
          draft.kind,
          draft.severity,
          draft.appearedAt,
          draft.description,
          draft.management,
          draft.lotId,
        ],
      );
      const id = added[0]?.id ?? null;
      await complete(c, {
        record: idempotency,
        accountId: caller.accountId,
        status: 201,
        response: { id, estado: 'registrado' },
      });
      return { outcome: 'added', id, replay: null };
    });
  }

  async voidSession(
    caller: ClinicalCaller,
    sessionId: string,
    reason: string,
    now: Date,
  ): Promise<{ outcome: 'voided' | 'no_session' | 'signed'; row: SessionRow | null }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query<{ status: string }>(
        `select status from clinical_session where id = $1 for update`,
        [sessionId],
      );
      const session = rows[0];
      if (session === undefined) return { outcome: 'no_session', row: null };
      // «Una sesión con nota firmada no se anula: se corrige.»
      if (session.status === 'firmada') return { outcome: 'signed', row: null };
      // Anular lo anulado devuelve lo mismo: idempotente.
      if (session.status === 'anulada') {
        return { outcome: 'voided', row: await this.readOne(c, sessionId, []) };
      }

      // EL STOCK SE DEVUELVE, y el movimiento queda registrado: un inventario sin movimientos
      // es un número que nadie puede explicar.
      const { rows: applications } = await c.query<{ lot_id: string; total_units: number }>(
        `select lot_id, total_units from session_application where session_id = $1`,
        [sessionId],
      );
      for (const application of applications) {
        await c.query(
          `update product_lot set units_left = least(units, units_left + $2), updated_at = now()
            where id = $1`,
          [application.lot_id, application.total_units],
        );
        await c.query(
          `insert into stock_movement (practice_id, lot_id, session_id, units, reason,
                                       actor_account_id)
           values (medskin_current_practice(), $1, $2, $3, 'anulacion', $4)`,
          [application.lot_id, sessionId, application.total_units, caller.accountId],
        );
      }

      await c.query(
        `update clinical_session set status = 'anulada', voided_at = $2, voided_reason = $3
          where id = $1`,
        [sessionId, now, reason],
      );
      return { outcome: 'voided', row: await this.readOne(c, sessionId, []) };
    });
  }

  private async readOne(
    c: PoolClient,
    sessionId: string,
    stock: readonly { lotId: string; units: number; left: number }[],
  ): Promise<SessionRow | null> {
    const { rows } = await c.query<Record<string, unknown>>(
      `select s.id, s.patient_id, s.appointment_id, s.status, s.started_at, s.ended_at,
              s.observations,
              n.fields, n.conflicts, n.signed_at,
              p.first_name || ' ' || p.last_name as signed_by,
              t.requires_consent,
              exists (select 1 from consent co
                       where co.patient_id = s.patient_id and co.treatment_id = a.treatment_id
                         and co.purpose = 'clinico' and co.revoked_at is null) as consent_signed
         from clinical_session s
         join appointment a on a.id = s.appointment_id
         join treatment t on t.id = a.treatment_id
         left join session_note n on n.session_id = s.id
         left join practitioner p on p.id = n.signed_by_practitioner_id
        where s.id = $1`,
      [sessionId],
    );
    const row = rows[0];
    if (row === undefined) return null;

    return {
      id: row.id as string,
      patientId: row.patient_id as string,
      appointmentId: row.appointment_id as string,
      status: row.status as string,
      startedAt: row.started_at as Date,
      endedAt: row.ended_at as Date,
      observations: (row.observations as string | null) ?? null,
      note:
        row.fields === null || row.fields === undefined
          ? null
          : {
              fields: row.fields as Record<string, { value: string; at: string; by: string }>,
              conflicts: (row.conflicts as NoteConflict[]) ?? [],
              signedAt: (row.signed_at as Date | null) ?? null,
              signedBy: (row.signed_by as string | null) ?? null,
            },
      consentRequired: row.requires_consent as boolean,
      consentSigned: row.consent_signed as boolean,
      stock,
    };
  }
}
