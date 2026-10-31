// Los puertos de los endpoints de consola de `consultas.md` —el alta, la ficha y la
// búsqueda—. Viven en el dominio y este archivo no importa NestJS, ni Fastify, ni Drizzle, ni
// `pg`.
//
// Son puertos aparte de los de la doctora y no métodos más en los suyos: cambian por
// motivos distintos —una pantalla interna de soporte contra la app de la consulta— y el
// doble de prueba de cada caso de uso no tiene que implementar lo que no llama.

import type { ConsoleSearch } from './console-search';
import type { ConsoleLicenseDraft } from './rules';
import type { Region } from '../../../shared/contract/session';

/**
 * Quien llama desde la consola, reducido a lo que la base necesita. Es el `PlatformCaller`
 * del token sin sus permisos: el permiso lo comprobó el guardia por lista blanca de rutas y
 * repetirlo aquí sería una segunda autorización que puede desacordarse con la primera.
 *
 * `subject` es un `uuid` y es lo que se fija en `medskin.account_id` —la política de
 * `idempotency_key` lo compara— y lo que viaja a `access_audit.actor_account_id`. **No hay
 * fila en `account` detrás**, y por eso esa columna no tiene clave foránea.
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
  /**
   * OPCIONAL, E.164. Es el único dato de contacto que no depende del correo: si el correo de
   * bienvenida no sale —el caso que `service_failure` y «reenviar acceso» existen para
   * cubrir— hoy no hay forma de avisarle a la doctora de que su cuenta existe.
   *
   * No sirve para entrar, igual que el de la paciente: se entra con correo y contraseña.
   */
  phone: string | null;
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
    /**
     * Los tres datos de la licencia que recogió la consola, o `null`. Van en la MISMA
     * transacción que el alta: si se escribieran después, un fallo entre las dos dejaría una
     * consulta creada con el formulario de su doctora a medio prellenar y nadie se enteraría.
     * No cambian el `status`, que sigue en `sin_enviar`.
     */
    license: ConsoleLicenseDraft | null;
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
  /**
   * LO QUE EL DOCTOR DECLARÓ, y nada más: sin `status`, porque nadie lo aprueba (0072).
   * Soporte lo necesita para poder mirar qué declaró alguien cuando llama por teléfono, que
   * es el único uso que esto tiene y es un uso real.
   */
  license: {
    practiceCountry: string | null;
    specialty: string | null;
    licenseNumber: string | null;
    /** `license.updated_at`. Nulo mientras no haya declarado nada. */
    declaredAt: Date | null;
  };
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

// ---------------------------------------------------------------------------------------
// GET /v1/platform/tenants · buscar · `consultas.md`, 30 oct 2026
//
// Devuelve MÁS DE UNA fila, que es lo que la hace distinta de la ficha: un error de campo en
// la ficha expone la consulta que ya se estaba mirando; aquí expondría el padrón. Por eso el
// renglón es un subconjunto EXACTO de la ficha, y una prueba lo fija comparando las claves.
//
// **AQUÍ VIVÍA TAMBIÉN `GET /v1/platform/licenses`**, la bandeja de lo que esperaba revisión,
// con su `LicenseRow` y su clave de credencial para firmar un enlace de cinco minutos. Se
// escribió y se borró el mismo día: MedSkin no revisa licencias, así que no hay bandeja.
// ---------------------------------------------------------------------------------------

/** Un renglón de la búsqueda. Ni un campo que la ficha no tenga. */
export type TenantRow = {
  id: string;
  name: string;
  region: string;
  createdOn: string;
  plan: string;
  /**
   * SOLO EL CORREO, y es lo que la consola puede leer: `app_platform` tiene `SELECT` sobre
   * cinco columnas de `account` y NINGUNA sobre `practitioner`, que es donde vive el nombre.
   * La ficha tampoco lo devuelve, por lo mismo. Prometerlo aquí habría sido prometer un campo
   * que la base niega — lo cazó la prueba contra la base con «permission denied».
   */
  ownerEmail: string | null;
  /** Para el cursor. No sale en la respuesta. */
  createdAt: Date;
};

export interface ConsoleSearchPort {
  /** Devuelve `perPage + 1` filas: la de más es cómo se sabe que hay siguiente página. */
  searchTenants(p: { actor: PlatformActor; search: ConsoleSearch }): Promise<readonly TenantRow[]>;
}
