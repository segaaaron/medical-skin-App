// Los puertos de `consultas.md` · los dos endpoints de la doctora. Viven en el dominio y
// este archivo no importa NestJS, ni Fastify, ni Drizzle, ni `pg`: los casos de uso se
// prueban sin levantar nada.
//
// Puertos pequeños y dos, no uno con cinco métodos: leer la consulta y guardar lo que el
// doctor declara de su matrícula no cambian por el mismo motivo, y el doble de prueba de cada
// caso de uso no tiene que implementar lo que no llama.

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

/**
 * LO QUE EL DOCTOR DECLARÓ, y los cuatro campos son nulos hasta que lo declara. No hay
 * `status`, no hay `submittedAt`, no hay `rejectionReason`: MedSkin no revisa licencias
 * (migración 0072), así que no hay estado que servir ni rechazo que explicar.
 *
 * `declaredAt` es `license.updated_at`. No hay columna propia porque en esa tabla solo se
 * escriben las tres columnas declaradas: la última escritura ES la declaración, y una columna
 * más que dijera lo mismo sería un segundo estado que puede desacordarse.
 */
export type LicenseSnapshot = {
  practiceCountry: string | null;
  specialty: string | null;
  licenseNumber: string | null;
  declaredAt: Date | null;
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
// POST /v1/tenants/mine/license · «el doctor declara su matrícula»
//
// LO QUE ESTE PUERTO ERA Y YA NO: `Submission` con ocho veredictos —`already_in_review`,
// `already_verified`, `invalid_transition`, `incomplete`…— era la máquina de estados de la
// revisión manual, y `medskin_license_to_review()` la que la movía. No queda nada de eso: es
// un formulario, el último `POST` gana, y lo único que puede salir mal aparte de un fallo del
// servidor es el cupo de cinco al día.
// ---------------------------------------------------------------------------------------

/** Los tres campos del formulario, ya validados. */
export type LicenseForm = {
  practiceCountry: string;
  specialty: string;
  licenseNumber: string;
};

/**
 * Tres, y ninguno más: la máquina de ocho veredictos de la revisión manual se fue entera
 * (migración 0072).
 *
 * · `saved` · se escribió.
 * · `too_many` · el `429` de los cinco guardados en 24 h. Se cuenta sobre `access_audit` —no
 *   sobre Redis (decisión 39)— y DENTRO de la misma transacción, así que viaja con el
 *   resultado.
 * · `not_owner` · quien llama no es la dueña de esa consulta. **Lo dice la base**, porque es
 *   lo único que lo sabe: el `WHERE` del `UPDATE` compara contra `practice.owner_account_id`
 *   y cero filas es esto. El token no lleva «soy la dueña» y no se le va a añadir: sería un
 *   dato de autorización viajando fuera de la base.
 */
export type SubmissionVerdict = 'saved' | 'too_many' | 'not_owner';

export type Submission = {
  verdict: SubmissionVerdict;
  /** La hora que quedó escrita. Nula solo en `too_many`, que no escribe nada. */
  declaredAt: Date | null;
};

/** Lo que se guarda para repetir, o `null` si ese veredicto no se repite. */
export type RememberedResponse = { status: number; response: unknown } | null;

export interface LicenseSubmissionPort {
  /**
   * El recuento del `429`, el `UPDATE` de las tres columnas y la fila de `access_audit`, en
   * UNA transacción y **sin función de base**: el doctor ya tiene
   * `GRANT UPDATE (practice_country, specialty, license_number, updated_at)` sobre `license` y
   * su política de `UPDATE` lo acota a su consulta. La `SECURITY DEFINER` existía porque no
   * tenía el grant de `status`; sin `status` sobra, y una menos es superficie menos.
   */
  submit(p: {
    owner: PracticeOwner;
    form: LicenseForm;
    /**
     * La clave de la petición, OBLIGATORIA. Se comprueba al abrir la transacción y se guarda
     * al cerrarla, en `idempotency_key` y no en Redis: una fila escrita después del `COMMIT`
     * no es idempotencia, porque un fallo entre las dos devuelve un 500 que miente y un
     * reintento que vuelve a ejecutar. Y aquí además protege el cupo: un reintento no gasta
     * uno de los cinco del día.
     */
    idempotency: IdempotencyRecord;
    /**
     * La respuesta que hay que guardar, construida DENTRO de la transacción por quien sabe
     * su forma. Devuelve `null` para `too_many`: un `429` no es una respuesta que repetir, y
     * el reintento tiene que poder volver a intentarlo de verdad.
     */
    respond: (submission: Submission) => RememberedResponse;
  }): Promise<{ submission: Submission; replay: { status: number; response: unknown } | null }>;
}

/** El reloj, visto desde estos dos casos de uso. Lo demás del reloj no hace falta aquí. */
export interface ClockPort {
  now(): Date;
}
