// La agenda contra la base. Dos puertas y dos roles, y por eso el contexto se arma distinto:
// la consulta entra con `app_practitioner` y su consulta; la paciente con `app_patient` y SIN
// consulta, porque `withTenantContext()` lo prohíbe y tiene razón — no pertenece a ninguno.
//
// EL HUECO NO SE COMPRUEBA, SE INTENTA. La restricción `appointment_no_overlap` (0032) es lo
// que hace imposible que dos pacientes se queden el mismo hueco: la segunda recibe `23P01`
// mientras la primera confirma, y eso es el `409 hueco_ocupado`. Comprobar antes de insertar es
// la carrera que ya costó cuatro revisiones en la idempotencia.

import type { Pool, PoolClient } from 'pg';

import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import { claim, complete, release } from '../../../shared/idempotency/idempotency-rows';
import type {
  AppointmentPort,
  AppointmentRow,
  BookingFacts,
  ScheduleCaller,
  ScheduleConfig,
  SchedulePort,
} from '../domain/ports';
import type { Window } from '../domain/slots';
import { dayOf, depositOnCancel } from '../domain/slots';

function contextOf(caller: ScheduleCaller): TenantContext {
  // La paciente no fija consulta: sus políticas son por `account_id` y por su vínculo.
  if (caller.isPatient) return { role: 'app_patient', accountId: caller.accountId };
  return { role: 'app_practitioner', practiceId: caller.practiceId, accountId: caller.accountId };
}

const APPOINTMENT_SELECT = `
  select a.id, a.practice_id, a.patient_id, a.treatment_id, a.zone, a.starts_at, a.ends_at, a.status,
         a.price_cents, a.promotion_id, a.patient_note, a.forced, a.deposit_required,
         a.deposit_cents, a.deposit_status, a.deposit_due_at, a.attended, a.cancelled_at,
         a.cancelled_by,
         t.name as treatment_name, t.requires_consent,
         pr.name as promotion_name,
         coalesce((select jsonb_agg(jsonb_build_object('offsetHours', s.offset_hours,
                                                       'text', s.text) order by s.offset_hours)
                     from treatment_protocol_step s
                    where s.treatment_id = a.treatment_id and s.moment = 'antes'), '[]'::jsonb)
           as preparation
    from appointment a
    join treatment t on t.id = a.treatment_id
    left join promotion pr on pr.id = a.promotion_id`;

export class ScheduleRepository implements SchedulePort, AppointmentPort {
  constructor(private readonly pool: Pool) {}

  // -----------------------------------------------------------------------------------
  // Horarios
  // -----------------------------------------------------------------------------------

  async config(caller: ScheduleCaller, practiceId: string): Promise<ScheduleConfig | null> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows: settings } = await c.query<Record<string, unknown>>(
        `select gap_minutes, slot_minutes, min_notice_hours, max_booking_days, deposit_percent,
                deposit_min_cents, deposit_hours, pay_info
           from schedule_settings where practice_id = $1`,
        [practiceId],
      );
      const { rows: rules } = await c.query<{ weekday: number; starts_at: string; ends_at: string }>(
        `select weekday, starts_at::text as starts_at, ends_at::text as ends_at
           from schedule_rule where practice_id = $1 order by weekday, starts_at`,
        [practiceId],
      );
      const { rows: holidays } = await c.query<{ from_date: string; to_date: string; reason: string | null }>(
        `select to_char(from_date, 'YYYY-MM-DD') as from_date,
                to_char(to_date, 'YYYY-MM-DD') as to_date, reason
           from holiday where practice_id = $1 order by from_date`,
        [practiceId],
      );

      // La zona es de `practice` y la paciente no lee esa tabla: para ella va la de su vínculo
      // por la función de la 0027 —misma idea, otra columna— y para la consulta, directa.
      const timeZone = await this.timeZone(c, caller, practiceId);
      if (timeZone === null) return null;

      const s = settings[0] ?? {};
      return {
        timeZone,
        rules: rules.map((r) => ({
          weekday: r.weekday,
          startsAt: r.starts_at.slice(0, 5),
          endsAt: r.ends_at.slice(0, 5),
        })),
        holidays: holidays.map((h) => ({ from: h.from_date, to: h.to_date })),
        holidayReasons: holidays.map((h) => ({
          from: h.from_date,
          to: h.to_date,
          reason: h.reason,
        })),
        gapMinutes: (s.gap_minutes as number | undefined) ?? 15,
        slotMinutes: (s.slot_minutes as number | undefined) ?? 30,
        minNoticeHours: (s.min_notice_hours as number | undefined) ?? 12,
        maxBookingDays: (s.max_booking_days as number | undefined) ?? 90,
        depositPercent: (s.deposit_percent as number | undefined) ?? 20,
        depositMinCents: (s.deposit_min_cents as number | null | undefined) ?? null,
        depositHours: (s.deposit_hours as number | undefined) ?? 2,
        payInfo: (s.pay_info as Record<string, unknown> | undefined) ?? {},
      };
    });
  }

  async saveConfig(
    caller: ScheduleCaller,
    config: {
      rules: readonly { weekday: number; startsAt: string; endsAt: string }[];
      holidays: readonly { from: string; to: string; reason: string | null }[];
      gapMinutes: number;
      slotMinutes: number;
      minNoticeHours: number;
      maxBookingDays: number;
    },
  ): Promise<{ outcome: 'saved' | 'holiday_with_appointments'; conflicts: readonly string[] }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // «Un día cerrado con citas vivas es una paciente que se presenta a una puerta cerrada»:
      // el feriado NO se impone, se rechaza con la lista de lo que hay ese día.
      const conflicts: string[] = [];
      for (const holiday of config.holidays) {
        const { rows } = await c.query<{ id: string }>(
          `select a.id from appointment a
            where a.status in ('pendiente_de_sena', 'confirmada')
              and (a.starts_at at time zone (select time_zone from practice))::date
                  between $1::date and $2::date`,
          [holiday.from, holiday.to],
        );
        conflicts.push(...rows.map((r) => r.id));
      }
      if (conflicts.length > 0) return { outcome: 'holiday_with_appointments', conflicts };

      await c.query(
        `insert into schedule_settings (practice_id, gap_minutes, slot_minutes, min_notice_hours,
                                        max_booking_days)
         values (medskin_current_practice(), $1, $2, $3, $4)
         on conflict (practice_id) do update
            set gap_minutes = excluded.gap_minutes, slot_minutes = excluded.slot_minutes,
                min_notice_hours = excluded.min_notice_hours,
                max_booking_days = excluded.max_booking_days, updated_at = now()`,
        [config.gapMinutes, config.slotMinutes, config.minNoticeHours, config.maxBookingDays],
      );

      // Reemplazo entero: el `PUT` es la semana completa y es idempotente. «Cambiar el horario
      // no mueve ninguna cita ya agendada»: esto no toca `appointment`, a propósito.
      await c.query(`delete from schedule_rule`);
      for (const rule of config.rules) {
        await c.query(
          `insert into schedule_rule (practice_id, weekday, starts_at, ends_at)
           values (medskin_current_practice(), $1, $2::time, $3::time)`,
          [rule.weekday, rule.startsAt, rule.endsAt],
        );
      }
      await c.query(`delete from holiday`);
      for (const holiday of config.holidays) {
        await c.query(
          `insert into holiday (practice_id, from_date, to_date, reason)
           values (medskin_current_practice(), $1::date, $2::date, $3)`,
          [holiday.from, holiday.to, holiday.reason],
        );
      }
      return { outcome: 'saved', conflicts: [] };
    });
  }

  async busy(
    caller: ScheduleCaller,
    practiceId: string,
    from: Date,
    to: Date,
  ): Promise<readonly Window[]> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // Dos horas y nunca una fila: la función de la 0031 no devuelve de quién es la cita.
      const { rows } = await c.query<{ starts_at: Date; ends_at: Date }>(
        'select starts_at, ends_at from medskin_busy_intervals($1, $2, $3)',
        [practiceId, from, to],
      );
      return rows.map((r) => ({ startsAt: r.starts_at, endsAt: r.ends_at }));
    });
  }

  async linkedPractice(
    accountId: string,
    practiceId: string,
  ): Promise<{ patientId: string } | 'invitada' | null> {
    return withTenantContext(this.pool, { role: 'app_patient', accountId }, async (c) => {
      const { rows } = await c.query<{ patient_id: string; status: string }>(
        `select patient_id, status from patient_link where practice_id = $1`,
        [practiceId],
      );
      const link = rows[0];
      if (link === undefined) return null;
      if (link.status !== 'vinculada') return 'invitada';
      return { patientId: link.patient_id };
    });
  }

  async treatmentDuration(caller: ScheduleCaller, treatmentId: string): Promise<number | null> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // Un tratamiento archivado no es un hueco que ofrecer: el contrato lo cuenta como que
      // «ya no está disponible», que es el mismo 404 que uno de otra consulta.
      const { rows } = await c.query<{ duration_minutes: number }>(
        `select duration_minutes from treatment where id = $1 and status = 'activo'`,
        [treatmentId],
      );
      return rows[0]?.duration_minutes ?? null;
    });
  }

  // -----------------------------------------------------------------------------------
  // Citas
  // -----------------------------------------------------------------------------------

  async facts(
    caller: ScheduleCaller,
    p: {
      practiceId: string;
      patientId: string;
      treatmentId: string;
      zone: string | null;
      promotionId: string | null;
      promotionCode: string | null;
      today: string;
    },
  ): Promise<BookingFacts | 'no_treatment' | 'no_patient'> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows: treatments } = await c.query<Record<string, unknown>>(
        // El precio de la ZONA si la hay, y si no el base: es lo que decide el importe.
        `select t.id, t.name, t.duration_minutes, t.min_interval_days, t.requires_consent,
                coalesce((select cents from price pz
                           where pz.treatment_id = t.id and pz.zone = $2),
                         (select cents from price pb
                           where pb.treatment_id = t.id and pb.zone is null), 0) as price_cents
           from treatment t
          where t.id = $1 and t.status = 'activo'`,
        [p.treatmentId, p.zone],
      );
      const treatment = treatments[0];
      if (treatment === undefined) return 'no_treatment';

      // La consulta puede agendar solo a SU paciente; la política ya lo acota, y sin fila es el
      // 404 del contrato.
      if (!caller.isPatient) {
        const { rows } = await c.query(`select 1 from patient where id = $1`, [p.patientId]);
        if (rows.length === 0) return 'no_patient';
      }

      const { rows: open } = await c.query<{ starts_at: Date }>(
        `select starts_at from appointment
          where patient_id = $1 and treatment_id = $2
            and status in ('pendiente_de_sena', 'confirmada')
          order by starts_at limit 1`,
        [p.patientId, p.treatmentId],
      );

      // El cruce clínico, por la función de la 0034: devuelve UN BOOLEANO y ninguna de las dos
      // apps recibe qué lo bloqueó. `medical_history` entera no la puede leer ni la paciente
      // —`phototype` no está en su `GRANT`— ni hace falta que la lea nadie para esto.
      const { rows: contra } = await c.query<{ blocked: boolean }>(
        'select medskin_treatment_blocked_for($1, $2) as blocked',
        [p.treatmentId, p.patientId],
      );

      let promotion: BookingFacts['promotion'] = null;
      if (p.promotionId !== null || p.promotionCode !== null) {
        const { rows } = await c.query<Record<string, unknown>>(
          `select pr.id, pr.name, pr.discount_type, pr.discount_value, pr.quota, pr.redeemed,
                  to_char(pr.starts_on, 'YYYY-MM-DD') as starts_on,
                  to_char(pr.ends_on, 'YYYY-MM-DD') as ends_on,
                  coalesce((select array_agg(pt.treatment_id::text) from promotion_treatment pt
                             where pt.promotion_id = pr.id), '{}') as treatments
             from promotion pr
            where pr.published
              and (($1::uuid is not null and pr.id = $1) or ($2::text is not null and pr.code = $2))`,
          [p.promotionId, p.promotionCode],
        );
        const found = rows[0];
        if (found !== undefined) {
          promotion = {
            id: found.id as string,
            name: found.name as string,
            discountType: found.discount_type as string,
            discountValue: found.discount_value as number,
            quota: (found.quota as number | null) ?? null,
            redeemed: found.redeemed as number,
            startsOn: found.starts_on as string,
            endsOn: found.ends_on as string,
            treatmentIds: (found.treatments as string[] | null) ?? [],
          };
        }
      }

      return {
        patientId: p.patientId,
        practiceId: p.practiceId,
        treatment: {
          id: treatment.id as string,
          name: treatment.name as string,
          durationMinutes: treatment.duration_minutes as number,
          minIntervalDays: (treatment.min_interval_days as number | null) ?? null,
          requiresConsent: treatment.requires_consent as boolean,
          priceCents: treatment.price_cents as number,
          // La moneda: de `practice` para la consulta, y por la función de la 0027 para la
          // paciente, que no lee esa tabla.
          currency: await this.currencyOf(c, caller, p.practiceId),
        },
        promotion,
        openAppointmentAt: open[0]?.starts_at ?? null,
        contraindicated: contra[0]?.blocked === true,
        // La última sesión de ese tratamiento es del tramo 5: hasta entonces el intervalo
        // mínimo no cierra nada porque no hay desde cuándo contar.
        availableFrom: null,
      };
    });
  }

  async book(
    caller: ScheduleCaller,
    p: {
      facts: BookingFacts;
      startsAt: Date;
      endsAt: Date;
      zone: string | null;
      priceCents: number;
      promotionId: string | null;
      patientNote: string | null;
      forced: boolean;
      depositCents: number | null;
      depositDueAt: Date | null;
      idempotency: IdempotencyRecord;
      gapMinutes: number;
    },
    render: (row: AppointmentRow) => unknown,
  ): Promise<{
    outcome: 'booked' | 'slot_taken' | 'promotion_quota';
    row: AppointmentRow | null;
    replay: unknown;
  }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // La reserva de la clave, antes de escribir nada: «sin clave un reintento produce dos
      // citas», y es el contrato quien la exige en este endpoint.
      const replay = await claim<unknown>(c, {
        record: p.idempotency,
        accountId: caller.accountId,
        practiceId: caller.isPatient ? null : caller.practiceId,
        unfinished: 'No pudimos confirmar tu cita, y puede que sí haya quedado agendada.',
      });
      if (replay !== null) return { outcome: 'booked', row: null, replay: replay.response };

      // El margen entre citas no lo cubre la restricción de solape —no es solape, es cortesía
      // clínica—, así que se mira aquí. `forzar: true` lo salta: la agenda es de la doctora.
      if (!p.forced && p.gapMinutes > 0) {
        if (await this.gapTaken(c, p.facts.practiceId, p.startsAt, p.endsAt, p.gapMinutes, null)) {
          await release(c, { record: p.idempotency, accountId: caller.accountId });
          return { outcome: 'slot_taken', row: null, replay: null };
        }
      }

      const deposit = p.depositCents !== null;
      let id: string;
      // UN SOLO `SAVEPOINT` PARA LAS DOS ESCRITURAS —el cupo y la cita—, porque son una sola
      // cosa: o las dos o ninguna. Si el cupo se descontara fuera del punto, un hueco tomado
      // dejaría el `redeemed` subido para una cita que no existe. Y el punto hace falta igual
      // porque una violación de restricción aborta la TRANSACCIÓN entera, no la sentencia, así
      // que el `release()` del `catch` moriría con ella (la lección del tramo 3).
      await c.query('savepoint before_booking');

      // «Dos pacientes que canjean el último cupo a la vez no pueden canjearlo las dos»: el
      // cupo se descuenta EN ESTA MISMA TRANSACCIÓN, y por una función (0043) por dos razones.
      // `app_patient` no tiene `UPDATE` sobre `promotion` —reservar con descuento por la
      // puerta de la paciente era un 500 seguro— y la función comprueba el cupo DENTRO del
      // `UPDATE`, así que «ya no hay cupo» son cero filas y no una transacción abortada.
      if (p.promotionId !== null) {
        const { rows: redeemed } = await c.query<{ ok: boolean | null }>(
          'select medskin_promotion_redeem($1, $2) as ok',
          [p.promotionId, p.facts.practiceId],
        );
        if (redeemed[0]?.ok !== true) {
          await c.query('rollback to savepoint before_booking');
          await release(c, { record: p.idempotency, accountId: caller.accountId });
          return { outcome: 'promotion_quota', row: null, replay: null };
        }
      }

      try {
        const { rows } = await c.query<{ id: string }>(
          `insert into appointment (practice_id, patient_id, treatment_id, zone, starts_at,
                                    ends_at, status, price_cents, promotion_id, patient_note,
                                    forced, deposit_required, deposit_cents, deposit_status,
                                    deposit_due_at, created_by_account_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           returning id`,
          [
            p.facts.practiceId,
            p.facts.patientId,
            p.facts.treatment.id,
            p.zone,
            p.startsAt,
            p.endsAt,
            // «Sin seña exigida, la cita nace confirmada.»
            deposit ? 'pendiente_de_sena' : 'confirmada',
            p.priceCents,
            p.promotionId,
            p.patientNote,
            p.forced,
            deposit,
            p.depositCents,
            deposit ? 'pendiente' : null,
            p.depositDueAt,
            caller.accountId,
          ],
        );
        id = rows[0]!.id;
        await c.query('release savepoint before_booking');
      } catch (failure) {
        // `23P01`: la restricción `appointment_no_overlap`. Es EL error de este tramo.
        if (isExclusion(failure)) {
          await c.query('rollback to savepoint before_booking');
          await release(c, { record: p.idempotency, accountId: caller.accountId });
          return { outcome: 'slot_taken', row: null, replay: null };
        }
        throw failure;
      }

      // LA PREPARACIÓN PREVIA, encolada al agendar y no por un programador: el protocolo de
      // «antes» ya está decidido, así que el aviso nace con su instante —24 h antes— y espera
      // en la tabla. Solo si el tratamiento tiene pasos de antes, y solo si esas 24 h todavía
      // no pasaron: un aviso de preparación para dentro de dos horas no prepara nada.
      await c.query(
        `select medskin_notify_patient($1, $2, 'preparacion_previa', 'push', 'preparacion',
                                       jsonb_build_object('cita_id', $3::text),
                                       'preparacion:' || $3::text, $4)
          where exists (select 1 from treatment_protocol_step s
                         where s.treatment_id = $5 and s.moment = 'antes')
            and $4::timestamptz > now()`,
        [
          p.facts.practiceId,
          p.facts.patientId,
          id,
          new Date(p.startsAt.getTime() - 24 * 3_600_000),
          p.facts.treatment.id,
        ],
      );

      const row = await this.readOne(c, id);
      if (row === null) throw new Error(`la cita ${id} no se pudo releer tras crearla`);
      // LO QUE SE GUARDA ES LO QUE EL CLIENTE RECIBIO, no la fila interna: un reintento tiene
      // que devolver el MISMO 201, y la fila lleva nombres en ingles que el contrato no tiene.
      await complete(c, {
        record: p.idempotency,
        accountId: caller.accountId,
        status: 201,
        response: render(row),
      });
      return { outcome: 'booked', row, replay: null };
    });
  }

  async list(
    caller: ScheduleCaller,
    p: { practiceId: string | null; from: string | null; to: string | null; status: string | null },
  ): Promise<readonly AppointmentRow[]> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query<Record<string, unknown>>(
        `${APPOINTMENT_SELECT}
          where ($1::timestamptz is null or a.starts_at >= $1)
            and ($2::timestamptz is null or a.starts_at <= $2)
            and ($3::text is null or a.status = $3)
          order by a.starts_at`,
        [p.from, p.to, p.status],
      );
      return rows.map(mapAppointment);
    });
  }

  async one(caller: ScheduleCaller, appointmentId: string): Promise<AppointmentRow | null> {
    return withTenantContext(this.pool, contextOf(caller), async (c) =>
      this.readOne(c, appointmentId),
    );
  }

  async reschedule(
    caller: ScheduleCaller,
    appointmentId: string,
    p: { startsAt: Date; endsAt: Date; zone: string | null; note: string | null; gapMinutes: number },
  ): Promise<{ outcome: 'moved' | 'slot_taken' | 'attended' | 'cancelled'; row: AppointmentRow | null }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows: current } = await c.query<{ status: string; practice_id: string }>(
        `select status, practice_id from appointment where id = $1 for update`,
        [appointmentId],
      );
      const found = current[0];
      if (found === undefined) return { outcome: 'moved', row: null };
      if (found.status === 'atendida' || found.status === 'no_asistio') {
        return { outcome: 'attended', row: null };
      }
      if (found.status === 'cancelada') return { outcome: 'cancelled', row: null };

      // El mismo margen de cortesía que al reservar, y excluyendo esta cita: sin esto mover
      // una cita era la única puerta por la que el margen de la consulta no se respetaba.
      if (
        p.gapMinutes > 0 &&
        (await this.gapTaken(c, found.practice_id, p.startsAt, p.endsAt, p.gapMinutes, appointmentId))
      ) {
        return { outcome: 'slot_taken', row: null };
      }

      await c.query('savepoint before_move');
      try {
        await c.query(
          `update appointment set starts_at = $2, ends_at = $3,
                                  zone = coalesce($4, zone),
                                  patient_note = coalesce($5, patient_note),
                                  updated_at = now()
            where id = $1`,
          [appointmentId, p.startsAt, p.endsAt, p.zone, p.note],
        );
        await c.query('release savepoint before_move');
      } catch (failure) {
        if (isExclusion(failure)) {
          await c.query('rollback to savepoint before_move');
          return { outcome: 'slot_taken', row: null };
        }
        throw failure;
      }
      return { outcome: 'moved', row: await this.readOne(c, appointmentId) };
    });
  }

  async cancel(
    caller: ScheduleCaller,
    appointmentId: string,
    by: 'patient' | 'practice',
    now: Date,
  ): Promise<
    | { outcome: 'cancelled'; row: AppointmentRow; deposit: { status: string; how: string; why: string } | null; waitlisted: number }
    | { outcome: 'attended' | 'already' }
  > {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows: current } = await c.query<{
        status: string;
        starts_at: Date;
        attended: boolean | null;
        deposit_required: boolean;
        treatment_id: string;
        practice_id: string;
      }>(
        `select status, starts_at, attended, deposit_required, treatment_id, practice_id
           from appointment where id = $1 for update`,
        [appointmentId],
      );
      const found = current[0];
      if (found === undefined) return { outcome: 'already' };
      if (found.status === 'atendida') return { outcome: 'attended' };
      // Cancelar lo cancelado devuelve el mismo 200: idempotente por naturaleza.
      if (found.status === 'cancelada') {
        const row = await this.readOne(c, appointmentId);
        return row === null
          ? { outcome: 'already' }
          : { outcome: 'cancelled', row, deposit: null, waitlisted: 0 };
      }

      const deposit = found.deposit_required
        ? depositOnCancel({ by, startsAt: found.starts_at, now, attended: found.attended })
        : null;

      await c.query(
        `update appointment set status = 'cancelada', cancelled_at = $2, cancelled_by = $3,
                                deposit_status = coalesce($4, deposit_status), updated_at = now()
          where id = $1`,
        [appointmentId, now, by, deposit?.status ?? null],
      );

      // «Cancelar libera el hueco y avisa a la lista de espera en el acto, en orden de
      // llegada.» Una a la vez, treinta minutos.
      //
      // ENTERO EN UNA FUNCIÓN (0061), y no es comodidad: **quien cancela no puede ver la lista**.
      // La política de `app_patient` sobre `waitlist_entry` la acota a sus propios asientos, así
      // que el `select` que buscaba a quién avisar no veía a nadie cuando cancelaba una
      // paciente —que es quien más cancela—: con otra persona esperando, cero avisos y nadie se
      // enteraba; con ella misma en la lista, el `update offered_until` reventaba por falta de
      // privilegio y **la cita no se cancelaba**. La decisión de a quién se le ofrece la toma
      // quien puede ver la lista entera, y el aviso y la reserva se escriben juntos o ninguno.
      // Los casteos van explícitos: con `$1` a secas Postgres no puede resolver la sobrecarga
      // —«function medskin_waitlist_offer(unknown, unknown, …) does not exist»— y el mismo
      // instante viaja dos veces, como texto para la carga del aviso y como `timestamptz` para
      // la reserva, así que son dos parámetros y no uno.
      // EL DÍA QUE SE PREGUNTA ES EL DEL HUECO, no hoy. `desde`/`hasta` del asiento es el rango
      // en el que ELLA quiere cita («avísame si se libera algo esa semana», `agenda.md`), así
      // que comparar con hoy ofrecía el hueco del 20 a quien espera del 1 al 5 y lo escondía a
      // quien espera del 15 al 25. Y el día se resuelve en la zona de la consulta: un hueco de
      // las 21:00 en La Paz es del día siguiente en UTC, que es lo que un `::date` sobre el
      // instante habría contestado.
      const zone = await this.timeZone(c, caller, found.practice_id);
      const gapDay = dayOf(found.starts_at, zone ?? 'UTC');

      const until = new Date(now.getTime() + 30 * 60_000);
      const { rows: offered } = await c.query<{ id: string | null }>(
        `select medskin_waitlist_offer($1::uuid, $2::uuid, $3::date,
                  jsonb_build_object('tratamiento_id', $2::text,
                                     'empieza_en', $4::text,
                                     'vence_en', $5::text),
                  $6::text, $7::timestamptz) as id`,
        [
          found.practice_id,
          found.treatment_id,
          gapDay,
          found.starts_at.toISOString(),
          until.toISOString(),
          `hueco:${appointmentId}`,
          until,
        ],
      );
      const offeredTo = offered[0]?.id ?? null;

      const row = await this.readOne(c, appointmentId);
      if (row === null) throw new Error(`la cita ${appointmentId} no se pudo releer al cancelar`);
      return { outcome: 'cancelled', row, deposit, waitlisted: offeredTo === null ? 0 : 1 };
    });
  }

  async deposit(
    caller: ScheduleCaller,
    appointmentId: string,
    p: { receiptKey: string | null; paidAt: Date | null; now: Date },
  ): Promise<{ outcome: 'claimed' | 'not_required' | 'already' | 'expired'; row: AppointmentRow | null }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const state = await this.depositState(c, appointmentId, p.now);
      if (state !== 'ok') return { outcome: state, row: null };

      await c.query(
        `insert into deposit_payment (practice_id, appointment_id, receipt_key, claimed_at)
         select a.practice_id, a.id, $2, coalesce($3, now()) from appointment a where a.id = $1`,
        [appointmentId, p.receiptKey, p.paidAt],
      );
      // «Dice que pagó» NO es «pagó»: la cita sigue `pendiente_de_sena` hasta que la consulta
      // confirme. Mezclar los dos momentos sería afirmar un cobro que nadie vio.
      await c.query(
        `update appointment set deposit_status = 'dice_que_pago', updated_at = now()
          where id = $1`,
        [appointmentId],
      );
      return { outcome: 'claimed', row: await this.readOne(c, appointmentId) };
    });
  }

  async confirmDeposit(
    caller: ScheduleCaller,
    appointmentId: string,
    now: Date,
  ): Promise<{ outcome: 'confirmed' | 'not_required' | 'already' | 'expired'; row: AppointmentRow | null }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const state = await this.depositState(c, appointmentId, now, true);
      if (state !== 'ok') return { outcome: state, row: null };

      await c.query(
        `update deposit_payment set confirmed_at = $2, confirmed_by_account_id = $3
          where appointment_id = $1 and confirmed_at is null`,
        [appointmentId, now, caller.accountId],
      );
      // Es el que mueve la cita a `confirmada`: la consulta vio el dinero.
      await c.query(
        `update appointment set deposit_status = 'confirmada', status = 'confirmada',
                                updated_at = now()
          where id = $1`,
        [appointmentId],
      );
      return { outcome: 'confirmed', row: await this.readOne(c, appointmentId) };
    });
  }

  async attendance(
    caller: ScheduleCaller,
    appointmentId: string,
    attended: boolean,
    now: Date,
  ): Promise<{ outcome: 'marked' | 'cancelled'; row: AppointmentRow | null }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query<{ status: string; deposit_required: boolean }>(
        `select status, deposit_required from appointment where id = $1 for update`,
        [appointmentId],
      );
      const found = rows[0];
      if (found === undefined) return { outcome: 'marked', row: null };
      if (found.status === 'cancelada') return { outcome: 'cancelled', row: null };

      // Un `false` aplica la regla de «no se presentó»: crédito 90 días. «No hay castigo
      // automático más allá de eso»: el servidor no inventa una política de negocio.
      await c.query(
        `update appointment
            set attended = $2, status = $3,
                deposit_status = case when deposit_required and not $2 then 'credito'
                                      else deposit_status end,
                updated_at = now()
          where id = $1`,
        [appointmentId, attended, attended ? 'atendida' : 'no_asistio'],
      );
      void now;
      return { outcome: 'marked', row: await this.readOne(c, appointmentId) };
    });
  }

  async waitlist(
    caller: ScheduleCaller,
    p: { practiceId: string; patientId: string; treatmentId: string; from: string; to: string },
  ): Promise<{ outcome: 'added' | 'too_many'; id: string | null }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // «Máximo 3 entradas vivas por paciente y por consulta. Sin tope, la lista deja de ser
      // una cola.»
      const { rows: live } = await c.query<{ n: string }>(
        `select count(*)::text as n from waitlist_entry
          where patient_id = $1 and practice_id = $2 and to_date >= current_date`,
        [p.patientId, p.practiceId],
      );
      if (Number(live[0]?.n ?? 0) >= 3) return { outcome: 'too_many', id: null };

      const { rows } = await c.query<{ id: string }>(
        `insert into waitlist_entry (practice_id, patient_id, treatment_id, from_date, to_date)
         values ($1, $2, $3, $4::date, $5::date) returning id`,
        [p.practiceId, p.patientId, p.treatmentId, p.from, p.to],
      );
      return { outcome: 'added', id: rows[0]?.id ?? null };
    });
  }

  async leaveWaitlist(caller: ScheduleCaller, entryId: string): Promise<boolean> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rowCount } = await c.query(`delete from waitlist_entry where id = $1`, [entryId]);
      return rowCount === 1;
    });
  }

  // -----------------------------------------------------------------------------------

  /** El estado de la seña, compartido por los dos endpoints que la tocan. */
  private async depositState(
    c: PoolClient,
    appointmentId: string,
    now: Date,
    confirming = false,
  ): Promise<'ok' | 'not_required' | 'already' | 'expired'> {
    const { rows } = await c.query<{
      status: string;
      deposit_required: boolean;
      deposit_status: string | null;
      deposit_due_at: Date | null;
    }>(
      `select status, deposit_required, deposit_status, deposit_due_at
         from appointment where id = $1 for update`,
      [appointmentId],
    );
    const found = rows[0];
    if (found === undefined) return 'already';
    if (!found.deposit_required) return 'not_required';
    if (found.deposit_status === 'confirmada') return 'already';
    // «Vencido sin confirmar, la cita pasa a cancelada por falta de seña»: se resuelve al
    // tocarla, además del barrido, para que el estado nunca mienta al leerlo.
    if (found.deposit_due_at !== null && found.deposit_due_at < now && !confirming) {
      await c.query(
        `update appointment set status = 'cancelada', cancelled_at = $2,
                                cancelled_by = 'system', deposit_status = 'vencida',
                                updated_at = now()
          where id = $1 and status = 'pendiente_de_sena'`,
        [appointmentId, now],
      );
      return 'expired';
    }
    return 'ok';
  }

  /**
   * El margen de cortesía entre citas, que NO es solape y por eso no lo decide la restricción
   * de exclusión de la 0032: `10:00–10:30` y `10:35–11:05` no se solapan y aun así rompen un
   * margen de 15 minutos.
   *
   * Se comprueba leyendo antes de escribir, y un `select` no serializa nada: dos reservas
   * simultáneas dentro del margen pasarían las dos. De ahí el cerrojo de aviso, que SÍ
   * serializa: lo toma la transacción, se suelta sola al terminar, y acota a las reservas de
   * ESTA consulta —el `practice_id` es la clave— para no poner en cola las de las demás.
   *
   * ponytail: un cerrojo por consulta serializa TODAS sus reservas, no solo las vecinas. Con
   * una agenda de consultorio es gratis; si alguna llega a reservar en paralelo de verdad, la
   * clave puede bajar al día (`practice_id` + fecha) sin tocar a quien llama.
   */
  private async gapTaken(
    c: PoolClient,
    practiceId: string,
    startsAt: Date,
    endsAt: Date,
    gapMinutes: number,
    exceptAppointmentId: string | null,
  ): Promise<boolean> {
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [`agenda:${practiceId}`]);
    const { rows } = await c.query<{ id: string }>(
      `select a.id from appointment a
        where a.status in ('pendiente_de_sena', 'confirmada', 'atendida', 'no_asistio')
          and ($4::uuid is null or a.id <> $4)
          and a.starts_at < $2::timestamptz + make_interval(mins => $3)
          and a.ends_at > $1::timestamptz - make_interval(mins => $3)
        limit 1`,
      [startsAt, endsAt, gapMinutes, exceptAppointmentId],
    );
    return rows.length > 0;
  }

  private async readOne(c: PoolClient, id: string): Promise<AppointmentRow | null> {
    const { rows } = await c.query<Record<string, unknown>>(`${APPOINTMENT_SELECT} where a.id = $1`, [
      id,
    ]);
    return rows[0] === undefined ? null : mapAppointment(rows[0]);
  }

  private async timeZone(
    c: PoolClient,
    caller: ScheduleCaller,
    practiceId: string,
  ): Promise<string | null> {
    if (caller.isPatient) {
      const { rows } = await c.query<{ zone: string | null }>(
        'select medskin_patient_practice_time_zone($1) as zone',
        [practiceId],
      );
      return rows[0]?.zone ?? null;
    }
    const { rows } = await c.query<{ time_zone: string }>(
      `select time_zone from practice where id = $1`,
      [practiceId],
    );
    return rows[0]?.time_zone ?? null;
  }

  private async currencyOf(
    c: PoolClient,
    caller: ScheduleCaller,
    practiceId: string,
  ): Promise<string> {
    if (caller.isPatient) {
      const { rows } = await c.query<{ currency: string | null }>(
        'select medskin_patient_practice_currency($1) as currency',
        [practiceId],
      );
      return rows[0]?.currency ?? '';
    }
    const { rows } = await c.query<{ currency: string }>(`select currency from practice`);
    return rows[0]?.currency ?? '';
  }
}

function mapAppointment(row: Record<string, unknown>): AppointmentRow {
  return {
    id: row.id as string,
    practiceId: row.practice_id as string,
    patientId: row.patient_id as string,
    treatmentId: row.treatment_id as string,
    treatmentName: row.treatment_name as string,
    zone: (row.zone as string | null) ?? null,
    startsAt: row.starts_at as Date,
    endsAt: row.ends_at as Date,
    status: row.status as string,
    priceCents: row.price_cents as number,
    currency: '',
    promotionId: (row.promotion_id as string | null) ?? null,
    promotionName: (row.promotion_name as string | null) ?? null,
    patientNote: (row.patient_note as string | null) ?? null,
    forced: row.forced as boolean,
    depositRequired: row.deposit_required as boolean,
    depositCents: (row.deposit_cents as number | null) ?? null,
    depositStatus: (row.deposit_status as string | null) ?? null,
    depositDueAt: (row.deposit_due_at as Date | null) ?? null,
    attended: (row.attended as boolean | null) ?? null,
    cancelledAt: (row.cancelled_at as Date | null) ?? null,
    cancelledBy: (row.cancelled_by as string | null) ?? null,
    requiresConsent: row.requires_consent as boolean,
    preparation: (row.preparation as AppointmentRow['preparation']) ?? [],
  };
}

/** `23P01 exclusion_violation`: el hueco se tomó mientras esta transacción lo pedía. */
function isExclusion(failure: unknown): boolean {
  return (
    typeof failure === 'object' &&
    failure !== null &&
    (failure as { code?: string }).code === '23P01'
  );
}

