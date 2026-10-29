// Los horarios y la disponibilidad. Los dos leen lo mismo; lo que cambia es quién pregunta.

import { ContractError } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import type { ScheduleCaller, SchedulePort } from '../domain/ports';
import { daysBetween, slotsOfDay } from '../domain/slots';

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const SLOTS = [5, 10, 15, 20, 30, 60];
const MAX_RANGE_DAYS = 31;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface ClockPort {
  now(): Date;
}

export class Schedule {
  constructor(
    private readonly schedule: SchedulePort,
    private readonly clock: ClockPort,
  ) {}

  async read(caller: Caller): Promise<unknown> {
    const asking = practiceOf(caller, 'horarios:definir');
    const config = await this.schedule.config(asking, asking.practiceId!);
    if (config === null) throw new ContractError('inquilino_no_existe');

    return {
      zona_horaria: config.timeZone,
      franjas: config.rules.map((r) => ({
        dia: WEEKDAYS[r.weekday],
        desde: r.startsAt,
        hasta: r.endsAt,
      })),
      margen_entre_citas_minutos: config.gapMinutes,
      paso_de_agenda_minutos: config.slotMinutes,
      aviso_minimo_horas: config.minNoticeHours,
      reserva_maxima_dias: config.maxBookingDays,
      feriados: config.holidayReasons.map((h) =>
        h.from === h.to
          ? { fecha: h.from, motivo: h.reason }
          : { desde: h.from, hasta: h.to, motivo: h.reason },
      ),
    };
  }

  async save(input: unknown, caller: Caller): Promise<unknown> {
    const asking = practiceOf(caller, 'horarios:definir');
    const body = asRecord(input);

    const rules = (Array.isArray(body.franjas) ? body.franjas : []).map((raw) => {
      const item = asRecord(raw);
      const weekday = WEEKDAYS.indexOf(asText(item.dia));
      if (weekday < 0) throw new ContractError('dia_desconocido');
      const startsAt = asText(item.desde);
      const endsAt = asText(item.hasta);
      if (!TIME.test(startsAt) || !TIME.test(endsAt)) throw new ContractError('franja_al_reves');
      if (endsAt <= startsAt) throw new ContractError('franja_al_reves');
      return { weekday, startsAt, endsAt };
    });

    // Dos franjas del mismo día que se solapan: «júntalas». Se comprueba aquí y no en la base
    // porque un `CHECK` no puede mirar otra fila.
    for (const a of rules) {
      for (const b of rules) {
        if (a === b) continue;
        if (a.weekday === b.weekday && a.startsAt < b.endsAt && a.endsAt > b.startsAt) {
          throw new ContractError('franjas_que_se_cruzan');
        }
      }
    }

    const slotMinutes = Number(body.paso_de_agenda_minutos ?? 30);
    if (!SLOTS.includes(slotMinutes)) throw new ContractError('paso_no_valido');

    const zone = asText(body.zona_horaria);
    if (body.zona_horaria !== undefined && !isTimeZone(zone)) {
      throw new ContractError('zona_horaria_desconocida');
    }

    const holidays = (Array.isArray(body.feriados) ? body.feriados : []).map((raw) => {
      const item = asRecord(raw);
      const from = asText(item.fecha) || asText(item.desde);
      const to = asText(item.hasta) || asText(item.fecha) || asText(from);
      if (!DAY.test(from) || !DAY.test(to)) throw new ContractError('franja_al_reves');
      return { from, to, reason: item.motivo === undefined ? null : asText(item.motivo) };
    });

    const saved = await this.schedule.saveConfig(asking, {
      rules,
      holidays,
      gapMinutes: Number(body.margen_entre_citas_minutos ?? 15),
      slotMinutes,
      minNoticeHours: Number(body.aviso_minimo_horas ?? 12),
      maxBookingDays: Number(body.reserva_maxima_dias ?? 90),
    });
    if (saved.outcome === 'holiday_with_appointments') {
      throw new ContractError('feriado_con_citas', { citas: saved.conflicts });
    }
    return this.read(caller);
  }

  /**
   * Los huecos reales. `tratamiento_id` es obligatorio porque la duración del tratamiento es lo
   * que decide qué es un hueco: sin ella, «libre» no significa nada.
   */
  async availability(query: Record<string, unknown>, caller: Caller): Promise<unknown> {
    const { asking, practiceId } = await this.whoAsks(caller, query);

    const treatmentId = asText(query.treatment_id) || asText(query.tratamiento_id);
    if (treatmentId === '') throw new ContractError('tratamiento_no_existe');

    const from = asText(query.desde);
    const to = asText(query.hasta) || asText(from);
    if (!DAY.test(from) || !DAY.test(to)) throw new ContractError('rango_demasiado_grande');
    const days = daysBetween(from, to);
    if (days.length === 0 || days.length > MAX_RANGE_DAYS) {
      throw new ContractError('rango_demasiado_grande');
    }

    const config = await this.schedule.config(asking, practiceId);
    if (config === null) throw new ContractError('tratamiento_no_existe');

    const duration = await this.schedule.treatmentDuration(asking, treatmentId);
    if (duration === null) throw new ContractError('tratamiento_no_existe');

    const busy = await this.schedule.busy(
      asking,
      practiceId,
      new Date(`${from}T00:00:00Z`),
      new Date(new Date(`${to}T00:00:00Z`).getTime() + 2 * 86_400_000),
    );

    const now = this.clock.now();
    return {
      zona_horaria: config.timeZone,
      duracion_minutos: duration,
      dias: days.map((day) => {
        const availability = slotsOfDay({ day, durationMinutes: duration, rules: config, busy, now });
        return availability.reason === null
          ? { dia: day, huecos: availability.slots }
          : { dia: day, huecos: availability.slots, motivo: availability.reason };
      }),
      // Lo que la app manda de vuelta al reservar: con esto el servidor sabe si la pantalla
      // está mirando una agenda de hace veinte minutos y lo puede decir mejor.
      calculado_en: now.toISOString(),
    };
  }

  /**
   * Quién pregunta y sobre qué consulta. Para la paciente el `practice_id` sale de SU vínculo
   * y el parámetro solo elige cuál; para la consulta, del token.
   */
  private async whoAsks(
    caller: Caller,
    query: Record<string, unknown>,
  ): Promise<{ asking: ScheduleCaller; practiceId: string; patientId: string | null }> {
    if (caller.accountRole === 'paciente') {
      const practiceId = asText(query.practice_id);
      if (practiceId === '') throw new ContractError('vinculo_no_existe');
      const link = await this.schedule.linkedPractice(caller.accountId, practiceId);
      if (link === null) throw new ContractError('vinculo_no_existe');
      if (link === 'invitada') throw new ContractError('vinculo_sin_aceptar');
      return {
        asking: {
          accountId: caller.accountId,
          practiceId: null,
          permissions: [],
          isPatient: true,
        },
        practiceId,
        patientId: link.patientId,
      };
    }
    const asking = practiceOf(caller, 'agenda:leer');
    return { asking, practiceId: asking.practiceId!, patientId: null };
  }

}

export function practiceOf(caller: Caller, permission: string): ScheduleCaller {
  if (caller.practiceId === null || !caller.permissions.includes(permission)) {
    throw new ContractError(
      'sin_permiso',
      undefined,
      'No tienes permiso para esto en la agenda de esta consulta.',
    );
  }
  return {
    accountId: caller.accountId,
    practiceId: caller.practiceId,
    permissions: caller.permissions,
    isPatient: false,
  };
}

/**
 * Un valor del cliente a texto, y SOLO si es texto o número. `String(unknown)` sobre un objeto
 * da `[object Object]`, que después viaja a una consulta como si fuera una fecha o un
 * identificador: el mismo error que el catálogo ya pagó una vez.
 */
export function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Una zona IANA de verdad: `Intl` la valida, y es la misma base que usa el cálculo. */
function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
