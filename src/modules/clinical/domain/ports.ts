// Lo que el expediente necesita de fuera. Sin NestJS, sin Fastify, sin `pg`.

import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import type {
  AdverseEventDraft,
  ConsentDraft,
  LotDraft,
  NoteConflict,
  SessionDraft,
} from './session';

export type ClinicalCaller = {
  accountId: string;
  practiceId: string;
  permissions: readonly string[];
  /** La nota la firma SOLO la doctora: lo decide el rol, no el permiso. */
  isDoctor: boolean;
};

export type SessionRow = {
  id: string;
  patientId: string;
  appointmentId: string;
  status: string;
  startedAt: Date;
  endedAt: Date;
  observations: string | null;
  note: {
    fields: Record<string, { value: string; at: string; by: string }>;
    conflicts: readonly NoteConflict[];
    signedAt: Date | null;
    signedBy: string | null;
  } | null;
  consentRequired: boolean;
  consentSigned: boolean;
  stock: readonly { lotId: string; units: number; left: number }[];
};

export interface ClinicalPort {
  create(
    caller: ClinicalCaller,
    draft: SessionDraft,
    idempotency: IdempotencyRecord,
    /** La MISMA vista de la respuesta: lo que se recuerda es lo que el cliente recibio. */
    render: (row: SessionRow) => unknown,
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
  }>;
  one(caller: ClinicalCaller, sessionId: string): Promise<SessionRow | null>;
  saveDraft(
    caller: ClinicalCaller,
    sessionId: string,
    p: { incoming: Record<string, unknown>; seenAt: Date | null; author: string; now: Date },
  ): Promise<
    | { outcome: 'saved'; saved: readonly string[]; conflicts: readonly NoteConflict[] }
    | { outcome: 'no_session' | 'signed' | 'voided' }
  >;
  sign(
    caller: ClinicalCaller,
    sessionId: string,
    now: Date,
  ): Promise<{
    outcome:
      | 'signed'
      | 'no_session'
      | 'empty'
      | 'conflicts'
      | 'no_consent'
      | 'stale_consent'
      | 'no_practitioner'
      | 'voided';
    row: SessionRow | null;
    aftercare: number;
  }>;
  correct(
    caller: ClinicalCaller,
    sessionId: string,
    p: { text: string; reason: string },
  ): Promise<{ outcome: 'added' | 'no_session' | 'not_signed'; id: string | null }>;
  adverseEvent(
    caller: ClinicalCaller,
    sessionId: string,
    draft: AdverseEventDraft,
    idempotency: IdempotencyRecord,
  ): Promise<{ outcome: 'added' | 'no_session' | 'no_lot'; id: string | null; replay: unknown }>;
  voidSession(
    caller: ClinicalCaller,
    sessionId: string,
    reason: string,
    now: Date,
  ): Promise<{ outcome: 'voided' | 'no_session' | 'signed'; row: SessionRow | null }>;
}

export type LotRow = {
  id: string;
  productId: string;
  productName: string;
  code: string;
  expiresOn: string;
  units: number;
  unitsLeft: number;
  costCents: number | null;
};

export interface LotPort {
  list(caller: ClinicalCaller): Promise<readonly LotRow[]>;
  create(
    caller: ClinicalCaller,
    draft: LotDraft,
    idempotency: IdempotencyRecord,
    /** La MISMA vista de la respuesta: lo que se recuerda es lo que el cliente recibio. */
    render: (row: LotRow) => unknown,
  ): Promise<{
    outcome: 'created' | 'duplicate_code' | 'no_product';
    row: LotRow | null;
    replay: unknown;
  }>;
  /** La consulta de retiro: dado un lote, a qué pacientes se les aplicó. */
  patients(
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
  >;
}

export type ConsentText = {
  treatmentId: string;
  version: string;
  body: string;
  /** Las preguntas SIN la respuesta correcta: su columna no la lee el rol de la paciente. */
  questions: readonly { id: string; texto: string; opciones: readonly string[] }[];
};

export interface ConsentPort {
  text(
    caller: { accountId: string; practiceId: string | null; isPatient: boolean },
    treatmentId: string,
  ): Promise<ConsentText | null>;
  sign(
    caller: { accountId: string; practiceId: string | null; isPatient: boolean },
    draft: ConsentDraft,
    idempotency: IdempotencyRecord,
  ): Promise<{
    outcome: 'signed' | 'wrong_answers' | 'stale_version' | 'already' | 'no_text';
    id: string | null;
    wrong: readonly string[];
    replay: unknown;
  }>;
}
