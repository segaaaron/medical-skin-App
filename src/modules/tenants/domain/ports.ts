// Los puertos de `consultas.md` · los dos endpoints de la doctora. Viven en el dominio y
// este archivo no importa NestJS, ni Fastify, ni Drizzle, ni `pg`: los casos de uso se
// prueban sin levantar nada.
//
// Puertos pequeños y dos, no uno con cinco métodos: leer la consulta y mandar la licencia a
// revisión no cambian por el mismo motivo, y el doble de prueba de cada caso de uso no
// tiene que implementar lo que no llama.

import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';

/**
 * Quién pregunta, resuelto del TOKEN y de nada más (OWASP A01). No hay `practice_id` en
 * ningún cuerpo ni en ninguna URL de estos dos endpoints: la ruta es `/mio`.
 */
export type PracticeOwner = {
  accountId: string;
  /** Nunca nulo aquí: una paciente no llega a estos dos casos de uso. */
  practiceId: string;
};

/**
 * Lo que `GET /v1/tenants/mine` necesita de la base y nada más. `internal_note` NO está,
 * y no es una omisión del código: `app_practitioner` no tiene ese `GRANT SELECT` de columna
 * («solo consola, nunca sale a la app»), así que pedirla sería «permiso denegado».
 */
export type PracticeSnapshot = {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  logoUrl: string | null;
  region: string;
  timeZone: string;
  currency: string;
  /** `individual` | `consultorio` | `clinica`. La etiqueta la pone el borde. */
  plan: string;
  patientLimit: number;
  /** `date` de Postgres: ya viene como `2026-11-14`, sin hora que convertir. */
  planRenewsOn: string | null;
  /** Fichas `activa`. Las archivadas NO cuentan contra el límite del plan (decisión 38). */
  activePatients: number;
  license: LicenseSnapshot;
  firstDay: FirstDaySnapshot;
};

export type LicenseSnapshot = {
  /** `sin_enviar` | `en_revision` | `verificada` | `rechazada`. */
  status: string;
  submittedAt: Date | null;
  responseEstimatedAt: Date | null;
  rejectionReason: string | null;
};

export type FirstDaySnapshot = {
  practiceData: boolean;
  schedule: boolean;
  firstTreatment: boolean;
  /** La lista que ella ya cerró. De aquí sale `primer_dia.visible`. */
  dismissed: boolean;
};

export interface OwnPracticePort {
  /**
   * Nulo cuando la consulta del token no tiene fila que servir: lo decide la política de
   * `practice` sobre `id`, no un `where` nuestro.
   */
  read(owner: PracticeOwner): Promise<PracticeSnapshot | null>;
}

// ---------------------------------------------------------------------------------------
// POST /v1/tenants/mine/license
// ---------------------------------------------------------------------------------------

/** Las seis columnas del formulario, ya validadas. */
export type LicenseForm = {
  practiceCountry: string;
  specialty: string;
  licenseNumber: string;
  credentialKey: string;
};

/**
 * Los veredictos de `medskin_license_to_review()` (migración 0002), más `too_many`, que es
 * el único que no sale de ella: el `429` de los 5 envíos en 24 h se cuenta sobre
 * `access_audit` —no sobre Redis (decisión 39)— y se cuenta DENTRO de la misma transacción,
 * así que viaja con los suyos.
 */
export type SubmissionVerdict =
  | 'submitted'
  | 'not_owner'
  | 'already_in_review'
  | 'already_verified'
  | 'incomplete'
  | 'invalid_transition'
  | 'no_license'
  | 'too_many';

export type Submission = {
  verdict: SubmissionVerdict;
  status: string | null;
  submittedAt: Date | null;
  responseEstimatedAt: Date | null;
};

/** Lo que se guarda para repetir, o `null` si ese veredicto no se repite. */
export type RememberedResponse = { status: number; response: unknown } | null;

export interface LicenseSubmissionPort {
  /**
   * El `UPDATE` del formulario, el recuento del `429` y la llamada a la función, en UNA
   * transacción. El estado NO se escribe desde aquí: la doctora no tiene `UPDATE` sobre
   * `license.status` y es deliberado —la transición la valida la función, que además deja
   * su fila de auditoría—.
   *
   * `responseEstimatedAt` lo calcula el llamador: los feriados de una región no son dato de
   * esta base.
   */
  submit(p: {
    owner: PracticeOwner;
    form: LicenseForm;
    responseEstimatedAt: Date;
    /**
     * La clave de la petición, OBLIGATORIA. Se comprueba al abrir la transacción y se guarda
     * al cerrarla, en `idempotency_key` y no en Redis: una fila escrita después del `COMMIT`
     * no es idempotencia, porque un fallo entre las dos devuelve un 500 que miente y un
     * reintento que vuelve a ejecutar.
     */
    idempotency: IdempotencyRecord;
    /**
     * La respuesta que hay que guardar, construida DENTRO de la transacción por quien sabe
     * su forma. Devuelve `null` para los veredictos que no se repiten —un `409` o un `429` no
     * son una respuesta que repetir, y el reintento tiene que poder volver a intentarlo—.
     */
    respond: (submission: Submission) => RememberedResponse;
  }): Promise<{ submission: Submission; replay: { status: number; response: unknown } | null }>;
}

/** El reloj, visto desde estos dos casos de uso. Lo demás del reloj no hace falta aquí. */
export interface ClockPort {
  now(): Date;
}
