// Lo que la agenda necesita de fuera. Sin NestJS, sin Fastify, sin `pg`.

import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import type { SlotRules, Window } from './slots';

/** Quién llama a la agenda. Para una paciente, `practiceId` es nulo: no es de ninguna consulta. */
export type ScheduleCaller = {
  accountId: string;
  practiceId: string | null;
  permissions: readonly string[];
  isPatient: boolean;
};

export type ScheduleConfig = SlotRules & {
  depositPercent: number;
  depositMinCents: number | null;
  depositHours: number;
  payInfo: Record<string, unknown>;
  holidayReasons: readonly { from: string; to: string; reason: string | null }[];
};

export type AppointmentRow = {
  id: string;
  /** El consulta de la cita. La paciente no lo tiene en el contexto: sale de aquí. */
  practiceId: string;
  patientId: string;
  treatmentId: string;
  treatmentName: string;
  zone: string | null;
  startsAt: Date;
  endsAt: Date;
  status: string;
  priceCents: number;
  currency: string;
  promotionId: string | null;
  promotionName: string | null;
  patientNote: string | null;
  forced: boolean;
  depositRequired: boolean;
  depositCents: number | null;
  depositStatus: string | null;
  depositDueAt: Date | null;
  attended: boolean | null;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  requiresConsent: boolean;
  /** Los pasos `antes` del protocolo: la app los agenda como aviso local, sin conexión. */
  preparation: readonly { offsetHours: number; text: string }[];
};

/** Lo que hace falta para decidir si una reserva procede, leído dentro de su transacción. */
export type BookingFacts = {
  patientId: string;
  practiceId: string;
  treatment: {
    id: string;
    name: string;
    durationMinutes: number;
    minIntervalDays: number | null;
    requiresConsent: boolean;
    priceCents: number;
    currency: string;
  };
  /** `null` si no hay promoción pedida; el veredicto lo pone el caso de uso. */
  promotion: {
    id: string;
    name: string;
    discountType: string;
    discountValue: number;
    quota: number | null;
    redeemed: number;
    startsOn: string;
    endsOn: string;
    treatmentIds: readonly string[];
  } | null;
  /** Si ya tiene una cita sin atender de ese mismo tratamiento. */
  openAppointmentAt: Date | null;
  contraindicated: boolean;
  availableFrom: string | null;
};

export interface SchedulePort {
  config(caller: ScheduleCaller, practiceId: string): Promise<ScheduleConfig | null>;
  saveConfig(
    caller: ScheduleCaller,
    config: {
      rules: readonly { weekday: number; startsAt: string; endsAt: string }[];
      holidays: readonly { from: string; to: string; reason: string | null }[];
      gapMinutes: number;
      slotMinutes: number;
      minNoticeHours: number;
      maxBookingDays: number;
    },
  ): Promise<{ outcome: 'saved' | 'holiday_with_appointments'; conflicts: readonly string[] }>;
  busy(caller: ScheduleCaller, practiceId: string, from: Date, to: Date): Promise<readonly Window[]>;
  /** El consulta de la paciente sale de SU vínculo, nunca del parámetro. */
  linkedPractice(accountId: string, practiceId: string): Promise<{ patientId: string } | 'invitada' | null>;
  /** La duración del tratamiento, que es lo que decide qué es un hueco. */
  treatmentDuration(caller: ScheduleCaller, treatmentId: string): Promise<number | null>;
}

export interface AppointmentPort {
  facts(
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
  ): Promise<BookingFacts | 'no_treatment' | 'no_patient'>;
  book(
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
      /** Para rechazar el hueco tomado entre que lo vio y confirmó. */
      gapMinutes: number;
    },
    /** La MISMA vista de la respuesta: lo que se recuerda es lo que el cliente recibio. */
    render: (row: AppointmentRow) => unknown,
  ): Promise<{
    outcome: 'booked' | 'slot_taken' | 'promotion_quota';
    row: AppointmentRow | null;
    replay: unknown;
  }>;
  list(
    caller: ScheduleCaller,
    p: { practiceId: string | null; from: string | null; to: string | null; status: string | null },
  ): Promise<readonly AppointmentRow[]>;
  one(caller: ScheduleCaller, appointmentId: string): Promise<AppointmentRow | null>;
  reschedule(
    caller: ScheduleCaller,
    appointmentId: string,
    p: { startsAt: Date; endsAt: Date; zone: string | null; note: string | null; gapMinutes: number },
  ): Promise<{ outcome: 'moved' | 'slot_taken' | 'attended' | 'cancelled'; row: AppointmentRow | null }>;
  cancel(
    caller: ScheduleCaller,
    appointmentId: string,
    by: 'paciente' | 'consulta',
    now: Date,
  ): Promise<
    | { outcome: 'cancelled'; row: AppointmentRow; deposit: { status: string; how: string; why: string } | null; waitlisted: number }
    | { outcome: 'attended' | 'already' }
  >;
  deposit(
    caller: ScheduleCaller,
    appointmentId: string,
    p: { receiptKey: string | null; paidAt: Date | null; now: Date },
  ): Promise<{ outcome: 'claimed' | 'not_required' | 'already' | 'expired'; row: AppointmentRow | null }>;
  confirmDeposit(
    caller: ScheduleCaller,
    appointmentId: string,
    now: Date,
  ): Promise<{ outcome: 'confirmed' | 'not_required' | 'already' | 'expired'; row: AppointmentRow | null }>;
  attendance(
    caller: ScheduleCaller,
    appointmentId: string,
    attended: boolean,
    now: Date,
  ): Promise<{ outcome: 'marked' | 'cancelled'; row: AppointmentRow | null }>;
  waitlist(
    caller: ScheduleCaller,
    p: { practiceId: string; patientId: string; treatmentId: string; from: string; to: string },
  ): Promise<{ outcome: 'added' | 'too_many'; id: string | null }>;
  leaveWaitlist(caller: ScheduleCaller, entryId: string): Promise<boolean>;
}
