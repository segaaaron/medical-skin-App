// Lo que la lista y la ficha necesitan de fuera. Sin NestJS, sin Fastify, sin `pg`.

import type { HistoryRow } from './history-view';
import type { PatientEdit } from './editing';
import type { HistoryDraft } from '../../accounts/domain/patient-registration';

/** Quién pregunta. Sale del token; ni la consulta ni la cuenta vienen de la URL. */
export type PracticeCaller = {
  accountId: string;
  practiceId: string;
  permissions: readonly string[];
};

/** Lo que vale en `?estado=`. `todas` incluye las archivadas (`pacientes.md`). */
export type PatientStatusFilter = 'activa' | 'archivada' | 'todas';

/** Lo que vale en `?vinculo=`, los tres estados de `patient_link`. */
export type LinkStatus = 'invitada' | 'vinculada' | 'revocada';

export type PatientQuery = {
  search: string | null;
  status: PatientStatusFilter;
  link: LinkStatus | null;
  page: number;
  perPage: number;
};

/** Una fila de la lista, tal como la base la devuelve. La forma de la API se arma arriba. */
export type PatientRow = {
  id: string;
  firstName: string;
  lastName: string;
  birthDate: string;
  phone: string | null;
  linkStatus: LinkStatus;
  hasAllergies: boolean | null;
  pregnancyOrLactation: string | null;
};

export type PatientPage = {
  total: number;
  rows: readonly PatientRow[];
};

/** La ficha. `referredBy` viene resuelto a nombre por la misma consulta. */
export type PatientFileRow = {
  id: string;
  firstName: string;
  lastName: string;
  birthDate: string;
  email: string;
  phone: string | null;
  hasWhatsapp: boolean;
  remindersVia: string;
  howArrived: string;
  referredById: string | null;
  referredByName: string | null;
  status: string;
  createdAt: Date;
  link: {
    status: LinkStatus;
    email: string;
    accessSentAt: Date | null;
    accountId: string | null;
  } | null;
  /** Los antecedentes, en la misma lectura: la ficha los lleva dentro. */
  history: HistoryRow | null;
};

/** `vinculo.ya_eligio_contrasena`, que sale de una función y nunca de `credential`. */
export type AccessState = {
  linked: boolean;
  passwordChosen: boolean | null;
};

export interface PatientReadPort {
  list(caller: PracticeCaller, query: PatientQuery): Promise<PatientPage>;
  /**
   * La ficha y, en la misma transacción, su línea de auditoría: «abrir una ficha queda en la
   * auditoría, y eso no tiene interruptor» (`pacientes.md`). Van juntas para que no exista el
   * estado en que la ficha se sirvió y el rastro no se escribió.
   */
  file(caller: PracticeCaller, patientId: string): Promise<PatientFileRow | null>;
  accessState(caller: PracticeCaller, accountId: string): Promise<AccessState>;
}

// ---------------------------------------------------------------------------------------
// Las escrituras de la ficha
// ---------------------------------------------------------------------------------------

export type EditResult = {
  outcome: 'edited' | 'no_patient' | 'archived' | 'no_referrer';
  /** Si la ficha tiene cuenta detrás: decide el `aviso_correo` del `PATCH`. */
  linked: boolean;
};

export type ArchiveResult = {
  outcome: 'done' | 'no_patient' | 'future_appointment';
  status: string;
  archivedAt: Date | null;
};

export interface PatientWritePort {
  edit(caller: PracticeCaller, patientId: string, edit: PatientEdit): Promise<EditResult>;
  archive(caller: PracticeCaller, patientId: string, archived: boolean): Promise<ArchiveResult>;
}

// ---------------------------------------------------------------------------------------
// Los vínculos · el lado de la paciente
// ---------------------------------------------------------------------------------------

export type LinkRow = {
  id: string;
  status: LinkStatus;
  /** Copias que guarda `patient_link`: `app_patient` no lee `practice` ni `practitioner`. */
  practiceName: string;
  practitionerName: string;
  city: string | null;
  createdAt: Date;
  /** Si algún campo de sus antecedentes ya lo escribió ella. */
  historyWrittenByPatient: boolean;
};

export type LinkDecision =
  | { outcome: 'decided'; row: LinkRow }
  | { outcome: 'no_link' }
  | { outcome: 'already_resolved' };

export interface PatientLinkPort {
  list(accountId: string): Promise<readonly LinkRow[]>;
  decide(accountId: string, linkId: string, accept: boolean): Promise<LinkDecision>;
}

export type HistoryWriteResult = {
  outcome: 'written' | 'no_link' | 'not_accepted';
  /** Los campos que se guardaron, con el nombre que viaja a la app. */
  saved: readonly string[];
  /** Los que no, porque los escribió la doctora. Es la pieza honesta del endpoint. */
  skipped: readonly string[];
};

export interface PatientHistoryWritePort {
  write(accountId: string, linkId: string, draft: HistoryDraft): Promise<HistoryWriteResult>;
}
