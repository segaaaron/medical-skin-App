// Los puertos del acceso. Viven en el dominio; las implementaciones, en infraestructura.
// Este archivo no importa NestJS, ni Fastify, ni Drizzle, ni `pg`: los casos de uso se
// prueban sin levantar nada.

import type {
  AccountRole,
  Claims,
  PractitionerRole,
  Region,
  Scope,
} from '../../../shared/contract/session';

// ---------------------------------------------------------------------------------------
// Credencial · lo que devuelve `medskin_access_credential()`, que SIEMPRE devuelve una
// fila y SIEMPRE un `hash` que verificar: el de la cuenta, o el del señuelo. `accountId`
// nulo significa señuelo, y eso lo sabe el proceso y nunca la respuesta HTTP.
// ---------------------------------------------------------------------------------------
export type AccessCredential = {
  accountId: string | null;
  accountRole: AccountRole | null;
  accountStatus: string | null;
  region: Region | null;
  /** El hash real o el del señuelo. Nunca nulo: sin él no hay «mismo tiempo». */
  hash: string;
  isTemporary: boolean;
  tempExpiresAt: Date | null;
  tempUsedAt: Date | null;
  practiceId: string | null;
  practitionerRole: PractitionerRole | null;
  permissions: readonly string[] | null;
};

export type SavePasswordVerdict = 'saved' | 'already_chosen' | 'no_code' | 'no_credential';

export interface CredentialPort {
  /** `medskin_access_credential()` con `app_anonymous`. */
  read(email: string): Promise<AccessCredential>;
  /** `medskin_access_attempt()`: mueve `failed_attempts` y la pausa de la cuenta. */
  recordAttempt(email: string, matched: boolean): Promise<void>;
  /** `medskin_current_credential()`: el hash de quien ya está dentro, por contexto. */
  readMine(accountId: string, practiceId: string | null): Promise<AccessCredential | null>;
  /**
   * `medskin_set_final_password()` MÁS el ascenso de la sesión que llama, en UNA sola
   * transacción: guardar la contraseña, consumir la temporal, anular el código, revocar
   * las demás sesiones y convertir esta en una de alcance `completo` con su refresco.
   * Las cinco cosas o ninguna: repartidas, un fallo entre dos deja a alguien fuera de su
   * propia cuenta sin salida, que es lo que el 500 de este endpoint promete que no pasa.
   *
   * Los tres nulos son la entrada por RECUPERACIÓN, no un descuido: su token no lleva rol
   * ni sesión (`RecoveryClaims`), así que no hay sesión que ascender —se abre después, con
   * el rol que esta misma llamada devuelve— y el rol de cuenta todavía no se conoce.
   */
  saveFinalPassword(p: {
    accountId: string;
    practiceId: string | null;
    /** Nulo si se llegó por recuperación: lo devuelve la base. */
    accountRole: AccountRole | null;
    hash: string;
    via: 'temporal' | 'recuperacion';
    /** Nulo si se llegó por recuperación: no hay sesión todavía. */
    currentSessionId: string | null;
    refreshDigest: string | null;
    refreshExpiresAt: Date | null;
  }): Promise<SavedPassword>;
}

export type SavedPassword = {
  verdict: SavePasswordVerdict;
  /** Lo lee la base de `account.role`. Es lo que decide el rol de base de lo que viene. */
  accountRole: AccountRole | null;
  practiceId: string | null;
  permissions: readonly string[] | null;
};

// ---------------------------------------------------------------------------------------
// Contraseñas · Argon2id en Node. El MISMO coste en los dos caminos, el real y el señuelo:
// si el señuelo se verificara más rápido, el cronómetro sería el oráculo que el
// `401 acceso_no_coincide` existe para cerrar.
// ---------------------------------------------------------------------------------------
export interface PasswordHasher {
  verify(hash: string, password: string): Promise<boolean>;
  hash(password: string): Promise<string>;
}

// ---------------------------------------------------------------------------------------
// La pausa · Redis, no filas. Tiene que poder contar para un correo que NO tiene cuenta
// (_convenciones.md · «Los contadores»), y un fallo de Redis no abre la puerta: quien lo
// implementa lanza `ServiceFailure`, nunca devuelve «no bloqueado».
// ---------------------------------------------------------------------------------------
export type PauseState = {
  paused: boolean;
  /** Cuándo se levanta. Solo cuando `paused`. */
  pausedUntil: Date | null;
  attemptsLeft: number;
};

export interface AccessPausePort {
  /** Se consulta ANTES de verificar nada. Paso 2 del orden del contrato. */
  peek(email: string, ip: string): Promise<PauseState>;
  recordFailure(email: string, ip: string): Promise<PauseState>;
  /** «se limpia al entrar bien». */
  clear(email: string, ip: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// Token · `sesion.md` · «La forma del token».
// ---------------------------------------------------------------------------------------
export interface TokenPort {
  sign(claims: Claims): Promise<{ token: string; expiresAt: Date }>;
  /** El refresco en claro para el cliente y su resumen determinista para la base. */
  mintRefresh(): { refresh: string; digest: string };
}

// ---------------------------------------------------------------------------------------
// Sesiones.
// ---------------------------------------------------------------------------------------
export type Device = {
  deviceId: string;
  model: string | null;
  os: string | null;
  appVersion: string | null;
  platform: 'ios' | 'android' | 'server' | null;
  city: string | null;
};

export type SessionOpening = {
  accountId: string;
  accountRole: AccountRole;
  practiceId: string | null;
  scope: Scope;
  refreshDigest: string | null;
  refreshExpiresAt: Date | null;
  device: Device;
  region: Region;
  /** Para la bitácora de accesos: el nombre sobrevive al borrado de la cuenta. */
  actorLabel: string | null;
};

/**
 * El estado del inquilino que decide `siguiente_paso`, MÁS las dos cosas que solo se
 * pueden leer con el contexto de ese inquilino puesto: el `practitioner.role` de esta
 * consulta y su lista explícita de permisos. Van juntas porque se leen en la misma
 * consulta y porque quien necesita una necesita las otras: el `rol` que viaja al cliente
 * sale del `practitioner.role`, no de `account.role` (`_convenciones.md`).
 */
export type NextStepFacts = {
  licenseStatus: string | null;
  firstDayDone: boolean;
  /** Nulo para una paciente, y también para una cuenta `practitioner` sin fila activa. */
  practitionerRole: PractitionerRole | null;
  /** `practitioner.permissions`. Nulo en el 100 % de las filas de la primera entrega. */
  permissions: readonly string[] | null;
};

/**
 * Lo que la apertura devuelve, y por qué va junto: `siguiente_paso` depende del estado de
 * la licencia y de la lista del primer día, y eso se lee en LA MISMA transacción que
 * inserta la sesión y la línea de auditoría. Entrar es un solo acto.
 */
export type OpenedSession = NextStepFacts & { sessionId: string };

export type ActiveSession = {
  id: string;
  model: string | null;
  os: string | null;
  appVersion: string | null;
  city: string | null;
  signedInAt: Date;
  lastSeenAt: Date;
};

/** Quién pregunta, siempre del token y nunca del cuerpo ni de la URL. */
export type OwnerOfSessions = {
  accountId: string;
  practiceId: string | null;
  accountRole: AccountRole;
};

export interface SessionPort {
  open(opening: SessionOpening): Promise<OpenedSession>;
  /** El estado que decide `siguiente_paso` sin abrir sesión nueva. */
  nextStepFacts(owner: OwnerOfSessions): Promise<NextStepFacts>;
  list(owner: OwnerOfSessions): Promise<readonly ActiveSession[]>;
  /** Cierra una por id. `false` si no es de esta cuenta o ya estaba cerrada. */
  revokeOne(owner: OwnerOfSessions, sessionId: string): Promise<boolean>;
  /** Cierra todas menos la actual y devuelve cuántas. */
  revokeOthers(owner: OwnerOfSessions, currentSessionId: string): Promise<number>;
}

// ---------------------------------------------------------------------------------------
// Reloj · para que las pruebas no dependan de la hora de la máquina.
// ---------------------------------------------------------------------------------------
export interface ClockPort {
  now(): Date;
  /**
   * «a las 10:29» en la hora del despliegue. La zona sale de la configuración de la región
   * y no de la fila del inquilino: cuando esta frase se escribe —una pausa de acceso— no
   * hay inquilino todavía, y la respuesta tiene que ser idéntica exista o no la cuenta.
   */
  localTime(moment: Date): string;
}
