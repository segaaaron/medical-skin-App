// Los puertos de los TRES endpoints de consola de `consultas.md`. Viven en el dominio y
// este archivo no importa NestJS, ni Fastify, ni Drizzle, ni `pg`.
//
// Son puertos aparte de los de la doctora y no métodos más en los suyos: cambian por
// motivos distintos —una pantalla interna de soporte contra la app de la consulta— y el
// doble de prueba de cada caso de uso no tiene que implementar lo que no llama.

import type { Region } from '../../../shared/contract/session';

/**
 * Quien llama desde la consola, reducido a lo que la base necesita. Es el `PlatformCaller`
 * del token sin sus permisos: el permiso lo comprobó el guardia por lista blanca de rutas y
 * repetirlo aquí sería una segunda autorización que puede desacordarse con la primera.
 *
 * `subject` es un `uuid` y es lo que se fija en `medskin.account_id` —la política de
 * `idempotency_key` lo compara— y lo que viaja a `access_audit.actor_account_id` y a
 * `license.reviewed_by`. **No hay fila en `account` detrás**, y por eso esas columnas no
 * tienen clave foránea.
 *
 * `label` es el nombre legible y NO entra en ninguna comparación: solo en
 * `access_audit.actor_label`, que la bitácora exige por escrito.
 */
export type PlatformActor = {
  subject: string;
  label: string;
  region: Region;
};

/** `(Idempotency-Key, cuenta que llama, cuerpo hasheado)` de `_convenciones.md`. */
export type IdempotencyRecord = {
  key: string;
  bodyHash: string;
};

/** Lo que se sirvió: una respuesta nueva, o la que se guardó la primera vez. */
export type Served<T> = {
  /** `true` cuando sale de `idempotency_key` y no de la operación. */
  replayed: boolean;
  status: number;
  response: T;
};

// ---------------------------------------------------------------------------------------
// POST /v1/platform/tenants · el alta
// ---------------------------------------------------------------------------------------

/** Las columnas de `practice` que escribe el alta. `patient_limit` sale del plan. */
export type NewPractice = {
  name: string;
  region: Region;
  country: string;
  timeZone: string;
  currency: string;
  plan: string;
  patientLimit: number;
  /** «Solo consola, nunca sale a la app»: la doctora no tiene el grant de esa columna. */
  internalNote: string | null;
};

export type NewOwner = {
  firstName: string;
  lastName: string;
  email: string;
  /** Argon2id. La función de la base rechaza cualquier cosa que no empiece por `$argon2id$`. */
  hash: string;
  expiresAt: Date;
};

/** Los cuatro veredictos de `medskin_create_practice_owner()` (migraciones 0002 y 0015). */
export type AdmissionVerdict =
  'created' | 'email_taken' | 'practice_has_owner' | 'practice_not_found';

/** Lo que la base acaba de crear, para armar el 201 DENTRO de la misma transacción. */
export type CreatedTenant = {
  practiceId: string;
  accountId: string;
  createdAt: Date;
};

export type Admission<T> =
  | { verdict: 'created'; served: Served<T> }
  | { verdict: Exclude<AdmissionVerdict, 'created'>; served: null };

export interface TenantAdmissionPort {
  /**
   * El `INSERT` de `practice`, la función del alta de la dueña y la fila de idempotencia, en
   * UNA transacción. **La fila de `license` la crea la función** (0015): si se insertara
   * aquí reventaría contra `license_practice_uq`, y si no la creara nadie la dueña se
   * quedaría sin poder enviar su licencia y nadie se enteraría.
   *
   * Un veredicto que no es `created` deshace el `INSERT` de `practice`: una consulta sin
   * dueña no existe, así que no se queda una fila huérfana que la consola vería como una
   * consulta real.
   *
   * `respond` se ejecuta DENTRO de la transacción, con lo que la base acaba de crear: es lo
   * que permite guardar la respuesta EXACTA —contraseña temporal incluida— en el mismo acto
   * que la crea. Si se guardara después, un fallo entre las dos dejaría un alta que ningún
   * reintento puede recuperar: la clave natural le respondería `email_taken`.
   */
  create<T>(p: {
    actor: PlatformActor;
    idempotency: IdempotencyRecord;
    practice: NewPractice;
    owner: NewOwner;
    respond: (created: CreatedTenant) => T;
  }): Promise<Admission<T>>;
}

// ---------------------------------------------------------------------------------------
// GET /v1/platform/tenants/{id} · la ficha de la consola
// ---------------------------------------------------------------------------------------

/**
 * «Soporte ve metadatos y estados, nunca contenido de pacientes.» No hay un solo campo de
 * paciente aquí, y no es un filtro del código: `app_platform` no tiene ni un grant ni una
 * política sobre `patient`, `medical_history`, `session_note`, `photo` ni `message`.
 */
export type TenantFile = {
  id: string;
  name: string;
  plan: string;
  patientLimit: number;
  /** De `medskin_platform_practice_stats()`: tres números y ni una fila. */
  activePatients: number;
  region: string;
  createdOn: string;
  license: { status: string; decidedAt: Date | null };
  appVersions: { ios: string | null; android: string | null };
  /** Nulo solo si la consulta no tiene dueña, que el alta hace imposible. */
  owner: {
    accountId: string;
    email: string;
    status: string;
    lockedUntil: Date | null;
    liveSessions: number;
  } | null;
};

export interface TenantFilePort {
  /** Nulo cuando no hay consulta con ese `id`: `404 consulta_no_existe`. */
  read(p: { actor: PlatformActor; practiceId: string }): Promise<TenantFile | null>;
}

// ---------------------------------------------------------------------------------------
// POST /v1/platform/tenants/{id}/license/decision
// ---------------------------------------------------------------------------------------

export type Decision = {
  status: 'verificada' | 'rechazada';
  /** Obligatorio con `rechazada`, de 10 a 300. La 0016 lo fuerza además con un `CHECK`. */
  rejectionReason: string | null;
};

/**
 * Los cuatro resultados que la base distingue, y los cuatro están en el contrato desde el
 * 28 de octubre: sin fila → `404`, `sin_enviar` → `409 licencia_sin_enviar`, ya decidida →
 * `409 licencia_ya_decidida`, y `decided`.
 */
export type DecisionOutcome = 'decided' | 'no_license' | 'not_submitted' | 'already_decided';

export type DecidedLicense = {
  status: string;
  decidedAt: Date;
  /** Para `puede`: el cupo del plan en el momento de la decisión. */
  activePatients: number;
  patientLimit: number;
};

export type DecisionResult<T> =
  | { outcome: 'decided'; served: Served<T> }
  | { outcome: Exclude<DecisionOutcome, 'decided'>; served: null };

export interface LicenseDecisionPort {
  /**
   * `SELECT ... FOR UPDATE` → `UPDATE ... WHERE status = 'en_revision'` → la fila de
   * `access_audit`, en UNA transacción y **sin función**: `app_platform` ya tiene `UPDATE`
   * de tabla entera sobre `license` y su política lo admite. La función de la doctora existe
   * porque ella NO tiene el grant de `status`; aquí es el caso contrario, y una
   * `SECURITY DEFINER` sería una capa que hay que leer para entender un `UPDATE`.
   *
   * El `WHERE ... AND status = 'en_revision'` ES la validación de la transición: cero filas
   * es el `409`.
   */
  decide<T>(p: {
    actor: PlatformActor;
    practiceId: string;
    decision: Decision;
    idempotency: IdempotencyRecord;
    respond: (decided: DecidedLicense) => T;
  }): Promise<DecisionResult<T>>;
}

/** El correo del alta. Puerto pequeño: lo que falla aquí no deshace el alta. */
export interface WelcomeMailPort {
  sendOwnerWelcome(facts: {
    firstName: string;
    email: string;
    practiceName: string;
    temporaryPassword: string;
    expiryText: string;
  }): Promise<void>;
}
