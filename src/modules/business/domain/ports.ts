// Lo que el negocio necesita de fuera. Sin NestJS, sin Fastify, sin `pg`.

import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import type { MovementDraft, PaymentDraft } from './business';

export type BusinessCaller = {
  accountId: string;
  practiceId: string | null;
  permissions: readonly string[];
  isPatient: boolean;
  /** Los márgenes y los informes son SOLO de la dueña. */
  isDoctor: boolean;
};

export type PaymentRow = {
  id: string;
  patientId: string;
  sessionId: string | null;
  concept: string;
  cents: number;
  /** Nulo cuando pregunta la paciente: su rol no lee esta columna. */
  method: string | null;
  creditUsedCents: number;
  reference: string | null;
  chargedAt: Date;
  voidedAt: Date | null;
};

export type MarginRow = {
  treatment: string;
  sessions: number;
  chargedCents: number;
  costCents: number;
  marginCents: number;
  marginPercent: number | null;
  units: number;
};

export type PlanRow = {
  plan: string;
  patientLimit: number;
  patients: number;
  photoBytes: number;
  renewsOn: string | null;
};

export interface BusinessPort {
  charge(
    caller: BusinessCaller,
    draft: PaymentDraft,
    idempotency: IdempotencyRecord,
    /** La MISMA vista de la respuesta: lo que se recuerda es lo que el cliente recibio. */
    render: (row: PaymentRow) => unknown,
  ): Promise<{
    outcome: 'charged' | 'no_session' | 'already' | 'no_credit';
    row: PaymentRow | null;
    credit: number;
    replay: unknown;
  }>;
  payments(
    caller: BusinessCaller,
    p: { patientId: string | null; from: string | null; to: string | null },
  ): Promise<readonly PaymentRow[]>;
  voidPayment(
    caller: BusinessCaller,
    paymentId: string,
    reason: string,
  ): Promise<{ outcome: 'voided' | 'no_payment'; id: string | null }>;
  margins(
    caller: BusinessCaller,
    p: { from: string | null; to: string | null },
  ): Promise<{ rows: readonly MarginRow[]; withoutCost: number; currency: string }>;
  inventory(caller: BusinessCaller): Promise<
    readonly {
      productId: string;
      name: string;
      unitsLeft: number;
      lots: readonly { id: string; code: string; expiresOn: string; unitsLeft: number }[];
    }[]
  >;
  addProduct(
    caller: BusinessCaller,
    p: { name: string; unit: string },
    idempotency: IdempotencyRecord,
  ): Promise<{ id: string | null; replay: unknown }>;
  move(
    caller: BusinessCaller,
    draft: MovementDraft,
    idempotency: IdempotencyRecord,
  ): Promise<{ outcome: 'moved' | 'no_lot' | 'negative'; left: number; replay: unknown }>;
  report(
    caller: BusinessCaller,
    p: { kind: string; from: string | null; to: string | null },
  ): Promise<{ suppressed: boolean; rows: readonly Record<string, unknown>[] }>;
  plan(caller: BusinessCaller): Promise<PlanRow | null>;
  requestPlan(caller: BusinessCaller, wanted: string, note: string | null): Promise<string | null>;
  requestExport(
    caller: BusinessCaller,
    idempotency: IdempotencyRecord,
    /** La MISMA vista de la respuesta: lo que se recuerda es lo que el cliente recibio. */
    render: (id: string) => unknown,
  ): Promise<{ outcome: 'queued' | 'too_soon'; id: string | null; replay: unknown }>;
  exportStatus(
    caller: BusinessCaller,
    exportId: string,
  ): Promise<{ status: string; expiresAt: Date | null } | null>;
}
