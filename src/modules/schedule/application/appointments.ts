// Las citas. ES EL ENDPOINT DONDE EL SERVIDOR MANDA: la app pide un hueco y obedece.
//
// «La paciente no manda `paciente_id`»: sale de su `patient_link` para ese `practice_id`. Si lo
// mandara y el servidor lo creyera, agendar en la ficha de otra persona sería un campo de
// distancia.

import { ContractError } from '../../../shared/contract/error-catalog';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import type { Caller } from '../../access/application/caller';
import { discounted } from '../../catalog/domain/treatment';
import type {
  AppointmentPort,
  AppointmentRow,
  ScheduleCaller,
  SchedulePort,
} from '../domain/ports';
import { dayOf, daysBetween, depositFor, nearestSlots, slotsOfDay } from '../domain/slots';
import { asRecord, asText, practiceOf, type ClockPort } from './schedule';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Appointments {
  constructor(
    private readonly appointments: AppointmentPort,
    private readonly schedule: SchedulePort,
    private readonly clock: ClockPort,
  ) {}

  async book(input: unknown, caller: Caller, idempotency: IdempotencyRecord): Promise<unknown> {
    const body = asRecord(input);
    const now = this.clock.now();
    const { asking, practiceId, patientId } = await this.whoBooks(caller, body);

    const treatmentId = asText(body.tratamiento_id);
    const zone = body.zona === undefined || body.zona === null ? null : asText(body.zona, 64);
    const patientNote =
      body.nota_de_la_paciente === undefined ? null : asText(body.nota_de_la_paciente, 2000);
    const startsAt = new Date(asText(body.empieza_en));
    if (Number.isNaN(startsAt.getTime())) throw new ContractError('fuera_de_horario');

    const config = await this.schedule.config(asking, practiceId);
    if (config === null) throw new ContractError('fuera_de_horario');

    const facts = await this.appointments.facts(asking, {
      practiceId,
      patientId,
      treatmentId,
      zone,
      promotionId: readUuid(body.promocion_id),
      promotionCode: body.codigo_promocion === undefined ? null : asText(body.codigo_promocion),
      today: dayOf(now, config.timeZone),
    });
    if (facts === 'no_treatment') throw new ContractError('tratamiento_no_existe');
    if (facts === 'no_patient') throw new ContractError('paciente_no_existe');

    // LA REGLA CLÍNICA, otra vez y a propósito: «si la paciente llega aquí con un enlace viejo
    // o una app desactualizada, el muro tiene que estar en los dos sitios».
    if (facts.contraindicated) throw new ContractError('tratamiento_no_disponible');
    if (facts.availableFrom !== null) {
      throw new ContractError('tratamiento_no_disponible', {
        disponible_desde: facts.availableFrom,
      });
    }
    // «Ya tienes una cita el 3 de noviembre para esto», con la salida de verla.
    if (facts.openAppointmentAt !== null) {
      throw new ContractError('ya_tiene_cita', {
        empieza_en: facts.openAppointmentAt.toISOString(),
      });
    }

    const endsAt = new Date(startsAt.getTime() + facts.treatment.durationMinutes * 60_000);
    // `forzar` SOLO de la consulta: «la agenda es de la doctora y ella sabe cuándo puede
    // apretar». Una paciente que lo mande no fuerza nada.
    const forced = !asking.isPatient && body.forzar === true;

    if (!forced) {
      this.checkSlot({
        day: dayOf(startsAt, config.timeZone),
        startsAt,
        // La DURACIÓN DEL TRATAMIENTO y no el paso de la rejilla: con el paso, uno de 40
        // minutos cabría a las 10:40 de una franja que cierra a las 11 y la cita se saldría.
        durationMinutes: facts.treatment.durationMinutes,
        config,
        now,
      });
    }

    const price = this.priceWithPromotion(facts, now, config.timeZone);
    const depositCents = depositFor(price.cents, config);
    const booked = await this.appointments.book(
      asking,
      {
        facts,
        startsAt,
        endsAt,
        zone,
        priceCents: price.cents,
        promotionId: price.promotionId,
        patientNote,
        forced,
        depositCents,
        depositDueAt:
          depositCents === null ? null : new Date(now.getTime() + config.depositHours * 3_600_000),
        idempotency,
        gapMinutes: forced ? 0 : config.gapMinutes,
      },
      (row) => this.view(row, config, price.promotionName),
    );
    if (booked.replay !== null) return booked.replay;

    // El cupo se agotó entre que se leyó y se canjeó: el mismo código y los mismos datos que
    // cuando la promoción no aplica por fecha o por tratamiento, y el precio es el de lista.
    if (booked.outcome === 'promotion_quota') {
      throw new ContractError('promocion_no_aplica', {
        precio: { centavos: facts.treatment.priceCents },
      });
    }

    if (booked.outcome === 'slot_taken') {
      // EL ERROR MÁS IMPORTANTE DEL TRAMO, y su valor está en `datos`: los tres huecos
      // cercanos son lo que hace que la hoja se redibuje en vez de morir.
      const nearby = await this.nearby(asking, practiceId, facts.treatment.durationMinutes, startsAt, config, now);
      throw new ContractError('hueco_ocupado', { huecos_cercanos: nearby });
    }

    return this.view(booked.row!, config, price.promotionName);
  }

  async list(query: Record<string, unknown>, caller: Caller): Promise<unknown> {
    const asking = this.reader(caller);
    const rows = await this.appointments.list(asking, {
      practiceId: asking.practiceId,
      from: query.desde === undefined ? null : asText(query.desde),
      to: query.hasta === undefined ? null : asText(query.hasta),
      status: query.estado === undefined ? null : asText(query.estado),
    });
    return { citas: rows.map((row) => this.shortView(row)) };
  }

  async one(appointmentId: string, caller: Caller): Promise<unknown> {
    const asking = this.reader(caller);
    this.checkUuid(appointmentId);
    const row = await this.appointments.one(asking, appointmentId);
    if (row === null) throw new ContractError('cita_no_existe');
    const config = await this.schedule.config(asking, asking.practiceId ?? row.practiceId);
    return config === null ? this.shortView(row) : this.view(row, config, row.promotionName);
  }

  /** Reagendar vuelve a pasar TODAS las comprobaciones: una cita movida es una cita nueva. */
  async reschedule(appointmentId: string, input: unknown, caller: Caller): Promise<unknown> {
    // Mover una cita es colocarla en un hueco: el permiso es el de crearla. Para la paciente
    // no hay permiso que mirar —mueve la suya, y su política ya lo acota—.
    const asking = this.writer(caller, 'citas:crear');
    this.checkUuid(appointmentId);
    const body = asRecord(input);
    const now = this.clock.now();

    const current = await this.appointments.one(asking, appointmentId);
    if (current === null) throw new ContractError('cita_no_existe');

    // El consulta sale de la FILA de la cita: para la paciente no hay contexto de
    // consulta, y su política ya garantizó que esa cita es suya.
    const practiceId = asking.practiceId ?? current.practiceId;
    const config = await this.schedule.config(asking, practiceId);
    if (config === null) throw new ContractError('cita_no_existe');

    const startsAt =
      body.empieza_en === undefined ? current.startsAt : new Date(asText(body.empieza_en));
    if (Number.isNaN(startsAt.getTime())) throw new ContractError('fuera_de_horario');

    const duration = (current.endsAt.getTime() - current.startsAt.getTime()) / 60_000;

    if (startsAt.getTime() !== current.startsAt.getTime()) {
      // «Para cambiarla con menos de 12 horas, escríbele a tu doctora»: el aviso mínimo también
      // vale hacia atrás, y solo para la paciente — la consulta mueve su agenda cuando quiere.
      if (asking.isPatient) {
        const hoursAhead = (current.startsAt.getTime() - now.getTime()) / 3_600_000;
        if (hoursAhead < config.minNoticeHours) throw new ContractError('reagendar_tarde');
      }
      this.checkSlot({
        day: dayOf(startsAt, config.timeZone),
        startsAt,
        durationMinutes: duration,
        config,
        now,
      });
      // LA REGLA CLÍNICA, y es la razón de que el comentario de arriba diga «todas»: entre que
      // se agendó y hoy la doctora pudo anotar un embarazo o una alergia, y la puerta que la
      // paciente usa sola desde su teléfono era la única sin ese muro. Se mira contra el DÍA
      // NUEVO, que es el que decide el intervalo mínimo.
      //
      // `openAppointmentAt` NO se mira aquí: la cita abierta de ese tratamiento es esta misma.
      await this.checkClinicalRule(asking, practiceId, current, dayOf(startsAt, config.timeZone));
    }

    const moved = await this.appointments.reschedule(asking, appointmentId, {
      startsAt,
      endsAt: new Date(startsAt.getTime() + duration * 60_000),
      zone: body.zona === undefined ? null : asText(body.zona, 64),
      note: body.nota_de_la_paciente === undefined ? null : asText(body.nota_de_la_paciente, 2000),
      gapMinutes: config.gapMinutes,
    });

    if (moved.outcome === 'attended') throw new ContractError('cita_ya_atendida');
    if (moved.outcome === 'cancelled') throw new ContractError('cita_cancelada');
    if (moved.outcome === 'slot_taken') {
      const nearby = await this.nearby(asking, practiceId, duration, startsAt, config, now);
      throw new ContractError('hueco_ocupado', { huecos_cercanos: nearby });
    }
    if (moved.row === null) throw new ContractError('cita_no_existe');
    return this.view(moved.row, config, moved.row.promotionName);
  }

  async cancel(appointmentId: string, caller: Caller): Promise<unknown> {
    // `citas:cancelar`, que es el permiso que la tabla de `_convenciones.md` nombra para esto y
    // que hasta hoy ningún endpoint comprobaba. Cancelar mueve la seña: no es una lectura.
    const asking = this.writer(caller, 'citas:cancelar');
    this.checkUuid(appointmentId);

    const result = await this.appointments.cancel(
      asking,
      appointmentId,
      asking.isPatient ? 'paciente' : 'consulta',
      this.clock.now(),
    );
    if (result.outcome === 'attended') throw new ContractError('cita_ya_atendida');
    if (result.outcome !== 'cancelled') throw new ContractError('cita_no_existe');

    return {
      estado: result.row.status,
      cancelada_en: result.row.cancelledAt?.toISOString() ?? null,
      cancelo: result.row.cancelledBy,
      sena:
        result.deposit === null
          ? null
          : {
              estado: result.deposit.status,
              importe: { centavos: result.row.depositCents, moneda: result.row.currency },
              como: result.deposit.how,
              por_que: result.deposit.why,
            },
      hueco_liberado: true,
      lista_de_espera_avisada: result.waitlisted,
    };
  }

  async claimDeposit(appointmentId: string, input: unknown, caller: Caller): Promise<unknown> {
    const asking = this.reader(caller);
    this.checkUuid(appointmentId);
    const body = asRecord(input);

    const result = await this.appointments.deposit(asking, appointmentId, {
      receiptKey: body.comprobante_clave === undefined ? null : asText(body.comprobante_clave, 256),
      paidAt: body.pagado_en === undefined ? null : new Date(asText(body.pagado_en)),
      now: this.clock.now(),
    });
    return this.depositAnswer(result.outcome, result.row);
  }

  async confirmDeposit(appointmentId: string, caller: Caller): Promise<unknown> {
    const asking = practiceOf(caller, 'cobros:registrar');
    this.checkUuid(appointmentId);
    const result = await this.appointments.confirmDeposit(asking, appointmentId, this.clock.now());
    return this.depositAnswer(result.outcome, result.row);
  }

  async attendance(appointmentId: string, input: unknown, caller: Caller): Promise<unknown> {
    const asking = practiceOf(caller, 'agenda:leer');
    this.checkUuid(appointmentId);
    const attended = asRecord(input).asistio === true;

    const result = await this.appointments.attendance(
      asking,
      appointmentId,
      attended,
      this.clock.now(),
    );
    if (result.outcome === 'cancelled') throw new ContractError('cita_cancelada');
    if (result.row === null) throw new ContractError('cita_no_existe');
    return { estado: result.row.status, asistio: result.row.attended };
  }

  async joinWaitlist(input: unknown, caller: Caller): Promise<unknown> {
    const body = asRecord(input);
    const { asking, practiceId, patientId } = await this.whoBooks(caller, body);
    const result = await this.appointments.waitlist(asking, {
      practiceId,
      patientId,
      treatmentId: asText(body.tratamiento_id),
      from: asText(body.desde),
      to: asText(body.hasta) || asText(body.desde),
    });
    if (result.outcome === 'too_many') throw new ContractError('demasiadas_esperas');
    return { id: result.id };
  }

  async leaveWaitlist(entryId: string, caller: Caller): Promise<unknown> {
    const asking = this.reader(caller);
    this.checkUuid(entryId);
    const left = await this.appointments.leaveWaitlist(asking, entryId);
    if (!left) throw new ContractError('cita_no_existe');
    return { quitado: true };
  }

  // -----------------------------------------------------------------------------------

  /** El hueco, contra el horario de la consulta. Los tres motivos son tres códigos distintos. */
  private checkSlot(p: {
    day: string;
    startsAt: Date;
    durationMinutes: number;
    config: NonNullable<Awaited<ReturnType<SchedulePort['config']>>>;
    now: Date;
  }): void {
    const availability = slotsOfDay({
      day: p.day,
      durationMinutes: p.durationMinutes,
      rules: p.config,
      busy: [],
      now: p.now,
    });
    if (availability.reason === 'fuera_de_plazo') {
      const hoursAhead = (p.startsAt.getTime() - p.now.getTime()) / 3_600_000;
      throw new ContractError(
        hoursAhead < p.config.minNoticeHours ? 'antes_del_aviso_minimo' : 'fuera_de_plazo',
      );
    }
    if (availability.reason === 'feriado' || availability.reason === 'sin_horario') {
      throw new ContractError('fuera_de_horario');
    }
    // El instante pedido tiene que caer en la rejilla de la consulta.
    if (!availability.slots.includes(p.startsAt.toISOString())) {
      const hoursAhead = (p.startsAt.getTime() - p.now.getTime()) / 3_600_000;
      if (hoursAhead < p.config.minNoticeHours) throw new ContractError('antes_del_aviso_minimo');
      throw new ContractError('fuera_de_horario');
    }
  }

  /** Los tres huecos más cercanos, para que la hoja se vuelva a dibujar con ellos. */
  private async nearby(
    asking: ScheduleCaller,
    practiceId: string,
    durationMinutes: number,
    wanted: Date,
    config: NonNullable<Awaited<ReturnType<SchedulePort['config']>>>,
    now: Date,
  ): Promise<readonly string[]> {
    const from = new Date(wanted.getTime() - 2 * 86_400_000);
    const to = new Date(wanted.getTime() + 5 * 86_400_000);
    const busy = await this.schedule.busy(asking, practiceId, from, to);

    const days = daysBetween(dayOf(from, config.timeZone), dayOf(to, config.timeZone)).map((each) =>
      slotsOfDay({ day: each, durationMinutes, rules: config, busy, now }),
    );
    return nearestSlots(days, wanted);
  }

  /**
   * El precio aplicado, con la promoción si de verdad aplica. Se COPIA en la cita y no se
   * vuelve a calcular: subir la tarifa en diciembre no cambia lo que se prometió en noviembre.
   */
  private priceWithPromotion(
    facts: NonNullable<Awaited<ReturnType<AppointmentPort['facts']>>> & object,
    now: Date,
    timeZone: string,
  ): { cents: number; promotionId: string | null; promotionName: string | null } {
    const base = (facts as { treatment: { priceCents: number } }).treatment.priceCents;
    const promotion = (facts as { promotion: BookingPromotion | null }).promotion;
    if (promotion === null) return { cents: base, promotionId: null, promotionName: null };

    const today = dayOf(now, timeZone);
    const covers =
      promotion.treatmentIds.length === 0 ||
      promotion.treatmentIds.includes((facts as { treatment: { id: string } }).treatment.id);
    const live = today >= promotion.startsOn && today <= promotion.endsOn;
    const hasQuota = promotion.quota === null || promotion.redeemed < promotion.quota;

    // «Esa promoción ya no aplica. Puedes reservar sin ella» — y el precio sin descuento viaja
    // en `datos` para que la hoja lo muestre sin volver a preguntar.
    if (!covers || !live || !hasQuota) {
      throw new ContractError('promocion_no_aplica', { precio: { centavos: base } });
    }

    return {
      cents: discounted(base, { type: promotion.discountType, value: promotion.discountValue }),
      promotionId: promotion.id,
      promotionName: promotion.name,
    };
  }

  private async whoBooks(
    caller: Caller,
    body: Record<string, unknown>,
  ): Promise<{ asking: ScheduleCaller; practiceId: string; patientId: string }> {
    if (caller.accountRole === 'paciente') {
      const practiceId = asText(body.practice_id);
      if (practiceId === '') throw new ContractError('vinculo_no_existe');
      const link = await this.schedule.linkedPractice(caller.accountId, practiceId);
      if (link === null) throw new ContractError('vinculo_no_existe');
      if (link === 'invitada') throw new ContractError('vinculo_sin_aceptar');
      return {
        asking: { accountId: caller.accountId, practiceId: null, permissions: [], isPatient: true },
        practiceId,
        // De SU vínculo y nunca del cuerpo: no hay camino por el que un identificador del
        // cliente elija en qué ficha se escribe.
        patientId: link.patientId,
      };
    }
    const asking = practiceOf(caller, 'citas:crear');
    const patientId = asText(body.paciente_id);
    if (!UUID.test(patientId)) throw new ContractError('paciente_no_existe');
    return { asking, practiceId: asking.practiceId!, patientId };
  }

  private reader(caller: Caller): ScheduleCaller {
    if (caller.accountRole === 'paciente') {
      return { accountId: caller.accountId, practiceId: null, permissions: [], isPatient: true };
    }
    return practiceOf(caller, 'agenda:leer');
  }

  /** Igual que `reader()` pero con el permiso de ESCRITURA que nombra la operación. */
  private writer(caller: Caller, permission: string): ScheduleCaller {
    if (caller.accountRole === 'paciente') {
      return { accountId: caller.accountId, practiceId: null, permissions: [], isPatient: true };
    }
    return practiceOf(caller, permission);
  }

  /**
   * Las dos comprobaciones clínicas del alta, vueltas a pasar: la contraindicación de la ficha
   * y el intervalo mínimo del tratamiento. Nada más: lo demás del alta —precio, promoción,
   * seña— se copió en la cita y no se recalcula.
   */
  private async checkClinicalRule(
    asking: ScheduleCaller,
    practiceId: string,
    current: AppointmentRow,
    day: string,
  ): Promise<void> {
    const facts = await this.appointments.facts(asking, {
      practiceId,
      patientId: current.patientId,
      treatmentId: current.treatmentId,
      zone: current.zone,
      promotionId: null,
      promotionCode: null,
      today: day,
    });
    // El tratamiento archivado o la ficha que ya no está no bloquean mover una cita que ya
    // existe: lo que esto vigila es la regla clínica, no el catálogo de hoy.
    if (facts === 'no_treatment' || facts === 'no_patient') return;

    if (facts.contraindicated) throw new ContractError('tratamiento_no_disponible');
    if (facts.availableFrom !== null) {
      throw new ContractError('tratamiento_no_disponible', {
        disponible_desde: facts.availableFrom,
      });
    }
  }

  private depositAnswer(outcome: string, row: AppointmentRow | null): unknown {
    if (outcome === 'not_required') throw new ContractError('sena_no_requerida');
    if (outcome === 'already') throw new ContractError('sena_ya_confirmada');
    if (outcome === 'expired') throw new ContractError('sena_vencida');
    if (row === null) throw new ContractError('cita_no_existe');
    return {
      estado: row.status,
      sena: {
        estado: row.depositStatus,
        importe: { centavos: row.depositCents, moneda: row.currency },
        vence_en: row.depositDueAt?.toISOString() ?? null,
      },
    };
  }

  private checkUuid(id: string): void {
    if (!UUID.test(id)) throw new ContractError('cita_no_existe');
  }

  private shortView(row: AppointmentRow) {
    return {
      id: row.id,
      estado: row.status,
      empieza_en: row.startsAt.toISOString(),
      termina_en: row.endsAt.toISOString(),
      tratamiento: { id: row.treatmentId, nombre: row.treatmentName },
      precio_aplicado: { centavos: row.priceCents, moneda: row.currency },
      forzada: row.forced,
      asistio: row.attended,
    };
  }

  private view(
    row: AppointmentRow,
    config: NonNullable<Awaited<ReturnType<SchedulePort['config']>>>,
    promotionName: string | null,
  ) {
    return {
      ...this.shortView(row),
      promocion_aplicada:
        row.promotionId === null ? null : { id: row.promotionId, nombre: promotionName },
      sena: {
        requerida: row.depositRequired,
        importe:
          row.depositCents === null
            ? null
            : { centavos: row.depositCents, moneda: row.currency },
        estado: row.depositStatus,
        vence_en: row.depositDueAt?.toISOString() ?? null,
        // Cómo pagarle A LA CONSULTA: son sus datos de cobro, no los de la paciente.
        como_pagar: row.depositRequired ? config.payInfo : null,
      },
      // Los pasos `antes` del protocolo, para que el recordatorio funcione SIN CONEXIÓN: uno
      // que depende de que llegue un push es un recordatorio que no llega.
      preparacion: row.preparation.map((step) => ({
        desfase_horas: step.offsetHours,
        texto: step.text,
      })),
      consentimiento_pendiente: row.requiresConsent,
      // «Más de 24 h se devuelve entera»: la hora exacta, para que la app no la calcule mal.
      cancelable_sin_costo_hasta: new Date(
        row.startsAt.getTime() - 24 * 3_600_000,
      ).toISOString(),
    };
  }
}

type BookingPromotion = {
  id: string;
  name: string;
  discountType: string;
  discountValue: number;
  quota: number | null;
  redeemed: number;
  startsOn: string;
  endsOn: string;
  treatmentIds: readonly string[];
};

function readUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}
