// Lo que el catálogo necesita de fuera. Sin NestJS, sin Fastify, sin `pg`.

import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import type {
  Contraindication,
  PriceRow,
  ProtocolStep,
  PromotionDraft,
  TrafficLight,
  TreatmentDraft,
} from './treatment';

/** Quién escribe el catálogo. Sale del token; el inquilino nunca de la URL. */
export type CatalogWriter = {
  accountId: string;
  practiceId: string;
  permissions: readonly string[];
};

export type TreatmentRow = {
  id: string;
  name: string;
  category: string;
  description: string | null;
  durationMinutes: number;
  plannedSessions: number;
  minIntervalDays: number | null;
  requiresConsent: boolean;
  visibleToPatients: boolean;
  status: string;
  appliedCount: number;
  cents: number;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
  supplies: readonly { productId: string; units: number }[];
};

export type PromotionRow = {
  id: string;
  name: string;
  discountType: string;
  discountValue: number;
  startsOn: string;
  endsOn: string;
  quota: number | null;
  redeemed: number;
  code: string | null;
  segmentKey: string;
  segmentValue: number | null;
  stackable: boolean;
  published: boolean;
  currency: string;
  treatmentIds: readonly string[];
};

export type Protocol = {
  steps: readonly ProtocolStep[];
  trafficLight: readonly TrafficLight[];
};

export interface CatalogPort {
  list(caller: CatalogWriter, includeArchived: boolean): Promise<readonly TreatmentRow[]>;
  create(
    caller: CatalogWriter,
    draft: TreatmentDraft,
    idempotency: IdempotencyRecord,
    /** La MISMA vista de la respuesta: lo que se recuerda es lo que el cliente recibio. */
    render: (row: TreatmentRow) => unknown,
  ): Promise<{
    outcome: 'created' | 'duplicate_name' | 'no_product';
    row: TreatmentRow | null;
    replay: unknown;
  }>;
  edit(
    caller: CatalogWriter,
    treatmentId: string,
    edit: Partial<TreatmentDraft>,
  ): Promise<{
    outcome: 'edited' | 'no_treatment' | 'duplicate_name' | 'no_product' | 'needs_interval';
    row: TreatmentRow | null;
  }>;
  archive(
    caller: CatalogWriter,
    treatmentId: string,
    archived: boolean,
  ): Promise<{ outcome: 'done' | 'no_treatment' | 'duplicate_name'; row: TreatmentRow | null }>;
  protocol(caller: CatalogWriter, treatmentId: string): Promise<Protocol | null>;
  saveProtocol(
    caller: CatalogWriter,
    treatmentId: string,
    protocol: Protocol,
  ): Promise<Protocol | null>;
  contraindications(
    caller: CatalogWriter,
    treatmentId: string,
  ): Promise<readonly Contraindication[] | null>;
  saveContraindications(
    caller: CatalogWriter,
    treatmentId: string,
    list: readonly Contraindication[],
  ): Promise<readonly Contraindication[] | null>;
  prices(caller: CatalogWriter): Promise<{ rows: readonly PriceRow[]; currency: string }>;
  savePrices(
    caller: CatalogWriter,
    rows: readonly PriceRow[],
  ): Promise<{ outcome: 'saved' | 'no_treatment'; rows: readonly PriceRow[]; currency: string }>;
  promotions(caller: CatalogWriter): Promise<readonly PromotionRow[]>;
  createPromotion(
    caller: CatalogWriter,
    draft: PromotionDraft,
    idempotency: IdempotencyRecord,
    render: (row: PromotionRow) => unknown,
  ): Promise<{
    outcome: 'created' | 'duplicate_code' | 'no_treatment';
    row: PromotionRow | null;
    replay: unknown;
  }>;
  editPromotion(
    caller: CatalogWriter,
    promotionId: string,
    edit: { published?: boolean; quota?: number | null },
  ): Promise<PromotionRow | null>;
}

// ---------------------------------------------------------------------------------------
// El catálogo de la PACIENTE · `GET /v1/catalog`
// ---------------------------------------------------------------------------------------

/** Lo que el servidor necesita para decidir `disponible`, y que nunca viaja en la respuesta. */
export type PatientFacts = {
  practiceName: string;
  currency: string;
  /** Su ficha, para cruzar contraindicaciones. Ni un campo de esto sale en la respuesta. */
  history: {
    hasAllergies: boolean | null;
    allergies: readonly string[];
    takesMedication: boolean | null;
    medication: readonly string[];
    pregnancyOrLactation: string | null;
    phototype: number | null;
    pastConditions: readonly string[];
  };
  birthDate: string;
  treatments: readonly CatalogTreatment[];
};

export type CatalogTreatment = {
  id: string;
  name: string;
  category: string;
  description: string | null;
  durationMinutes: number;
  minIntervalDays: number | null;
  cents: number;
  contraindications: readonly Contraindication[];
  /** La última sesión suya de este tratamiento. Tramo 5: hoy siempre nula. */
  lastSessionOn: string | null;
  promotion: {
    id: string;
    name: string;
    endsOn: string;
    discountType: string;
    discountValue: number;
  } | null;
};

export interface PatientCatalogPort {
  /** `null` si ese `practice_id` no es de sus vínculos; `'invitada'` si todavía no aceptó. */
  read(accountId: string, practiceId: string): Promise<PatientFacts | 'invitada' | null>;
}
