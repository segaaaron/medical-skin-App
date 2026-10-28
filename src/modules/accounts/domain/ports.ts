// Los puertos de las cuentas. Dominio: sin NestJS, sin Fastify, sin `pg`.

import type { AccountRole, Region } from '../../../shared/contract/session';
import type { DeliveryFacts, TeamDeliveryFacts } from './access-delivery';
import type { AssignableTeamRole } from './team';

/** Quién pregunta, siempre del token. Nunca un `cuenta_id` del cuerpo ni de la URL. */
export type AccountOwner = {
  accountId: string;
  practiceId: string | null;
  accountRole: AccountRole;
  sessionId: string;
};

export interface OwnCredentialPort {
  /**
   * El hash de quien ya está dentro, por `medskin_current_credential()`. El hash NUNCA
   * sale de la base por una consulta: no hay `GRANT SELECT (hash)` para ningún rol, así
   * que la única vía es esa función `SECURITY DEFINER` declarada `STABLE` (§7.3, regla 3),
   * y la comparación es Argon2id en Node.
   */
  readMine(owner: AccountOwner): Promise<{ hash: string } | null>;

  /**
   * La contraseña nueva MÁS la revocación de las demás sesiones, en UNA transacción.
   * «Cambiar la contraseña siempre revoca las demás sesiones y deja viva solo la que lo
   * hizo», y si fueran dos llamadas, un fallo entre ellas dejaría la contraseña nueva con
   * las sesiones viejas abiertas, que es justo lo que alguien intenta cortar.
   */
  replace(p: { owner: AccountOwner; hash: string }): Promise<{ sessionsRevoked: number }>;
}

/** El contador del `429` de este endpoint: «5 fallos de `actual` en 15 min». */
export interface PasswordAttemptsPort {
  /** Lee sin tocar, antes de comparar nada. */
  spent(accountId: string): Promise<number>;
  recordFailure(accountId: string): Promise<void>;
  clear(accountId: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// El acceso de SU paciente · `POST /v1/cuentas/{cuenta_id}/acceso`.
//
// La autorización no es un `if` del código: es la política de `patient_link` sobre
// `practice_id` más la función `SECURITY DEFINER` que empieza buscando ese vínculo. Un
// `cuenta_id` de otra consulta no devuelve fila, y esa es la respuesta.
// ---------------------------------------------------------------------------------------

/** Lo que hace falta para escribir el mensaje, y nada más. Ni un dato clínico. */
export type PatientForDelivery = {
  firstName: string;
  email: string;
  phone: string | null;
  /** El nombre con el que la doctora se presenta: «Dra. Andrea Paz». */
  practitionerName: string;
  /**
   * `patient_link.access_sent_at` ANTES de acuñar, y no es un dato del mensaje: es lo que
   * hace falta para poder DESHACER la marca si el envío falla. Se lee aquí porque esta
   * lectura ya pasa por la política del inquilino y acuñar la sobreescribe: después ya no
   * hay de dónde sacarla. Nulo cuando nunca se le mandó, que es el caso de la primera vez.
   */
  accessSentAt: Date | null;
};

export type ResendOutcome = 'acceso_renovado' | 'ya_eligio_su_contrasena' | 'paciente_no_existe';

export interface PatientAccessPort {
  /**
   * La ficha de esa cuenta en ESTA consulta, bajo la política de `patient_link`. `null`
   * cuando no hay vínculo, que es la misma respuesta que un `cuenta_id` inventado.
   */
  forDelivery(owner: AccountOwner, accountId: string): Promise<PatientForDelivery | null>;

  /**
   * `medskin_resend_patient_access()`: acuña la temporal nueva, mata la anterior y marca
   * el envío. Devuelve el veredicto, nunca la fila.
   */
  resend(p: {
    owner: AccountOwner;
    accountId: string;
    hash: string;
    expiresAt: Date;
    via: string;
  }): Promise<{ outcome: ResendOutcome; expiresAt: Date | null }>;

  /**
   * Deshace la marca de envío devolviéndole SU VALOR ANTERIOR. Existe porque la función
   * escribe `access_sent_at = now()` AL ACUÑAR y el envío pasa después, así que un relé
   * caído dejaba en la base la afirmación «ya se le mandó» siendo falsa.
   *
   * `previous` y no nulo a secas: compensar es deshacer lo que esta llamada escribió, no
   * borrar la historia. Si el correo salió el día 1 y el reenvío falla el día 5, poner nulo
   * haría que la consola leyera «nunca se le mandó» de una paciente que sí lo recibió, que
   * es el mismo defecto en la otra dirección. Nulo solo cuando nulo era lo que había.
   *
   * `access_sent_at` solo puede afirmar un envío que ocurrió (`cuentas.md`). El intento no
   * se pierde: vive en `access_audit`, que es donde va un intento.
   */
  restoreAccessSentAt(owner: AccountOwner, accountId: string, previous: Date | null): Promise<void>;
}

/** El contador del `429 demasiados_reenvios`: «más de 3 en una hora para la misma cuenta». */
export interface ResendLimitPort {
  count(accountId: string): Promise<{ tooMany: boolean }>;
}

/**
 * El correo del acceso, que es la OTRA MITAD de `via: "correo"`: por ahí la temporal no
 * viaja en la respuesta —«el correo lo manda MedSkin»—, así que si nadie lo manda, acuñar
 * mata la que la paciente tenía y no le llega ninguna. Puerto pequeño: un solo verbo, y
 * añadir otro canal es otra implementación y no un `switch`.
 *
 * Lanza si no se pudo entregar. Un `void` silencioso aquí sería el defecto otra vez.
 */
export interface PatientAccessMailPort {
  sendAccess(facts: DeliveryFacts): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// GET /v1/cuentas/mia · quién soy, qué rol tengo y qué pantalla toca.
//
// Todo sale del CONTEXTO: `account` y `credential` por las políticas `*_own` sobre
// `medskin_current_account()`, y los vínculos por `account_id`. No hay un solo
// identificador del cliente en estas consultas (OWASP A01).
// ---------------------------------------------------------------------------------------

/** Una doctora de la lista `doctoras`, tal y como la guarda `patient_link`. */
export type LinkedPractice = {
  practiceId: string;
  /** Copias denormalizadas desde la 0006: `app_patient` no tiene política en `practice`. */
  practiceName: string;
  practitionerName: string;
  status: string;
  /** `AAAA-MM-DD`, ya en la zona del despliegue: es una etiqueta de día, no un instante. */
  since: string;
};

export type OwnProfile = {
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  status: string;
  region: Region;
  /** `credential.is_temporary`. El hash no entra aquí: no hay `GRANT SELECT (hash)`. */
  passwordIsTemporary: boolean;
  doctoras: readonly LinkedPractice[];
};

export interface OwnProfilePort {
  /**
   * La cuenta de quien pregunta, su credencial —sin el hash— y, si se piden, sus vínculos.
   * Todo en UNA transacción: es la pantalla de arranque de las dos apps y abrir dos
   * transacciones para dos lecturas del mismo contexto es pagar dos veces el viaje.
   *
   * `withLinks` lo decide el caso de uso y no esta consulta, porque es una regla de
   * negocio: la lista de doctoras es de una paciente. Para una cuenta de equipo sale
   * siempre vacía y está escrito en el contrato con su motivo —`app_practitioner` lee
   * `patient_link` por `practice_id`, así que preguntar por ella desde una cuenta de equipo
   * devolvería las fichas de la consulta y no las suyas—.
   *
   * `restricted` es el alcance del token, y lo que decide es el ROL DE BASE: una sesión que
   * todavía no eligió su contraseña corre con `app_account`, que llega a `account`,
   * `credential` y `patient_link` por cuenta y a nada más.
   */
  readProfile(p: {
    owner: AccountOwner;
    restricted: boolean;
    withLinks: boolean;
  }): Promise<OwnProfile | null>;
}

// ---------------------------------------------------------------------------------------
// DELETE /v1/cuentas/mia · `medskin_delete_own_account()`.
//
// La función no recibe la cuenta: sale del contexto. Con un argumento, cualquiera con
// sesión podría borrar la de cualquiera, y la de una doctora se lleva su consulta entera.
// ---------------------------------------------------------------------------------------

export type DeletionVerdict =
  | 'deleted'
  | 'already_deleted'
  | 'no_account'
  | 'not_allowed'
  | 'practice_has_team'
  | 'practice_has_patients'
  | 'subscription_active';

export type DeletionResult = {
  verdict: DeletionVerdict;
  /** El del borrado DE VERDAD, no el de este reintento: el 200 repetido dice lo mismo. */
  deletedAt: Date | null;
  /** Solo en `practice_has_patients`: la frase lo lleva dentro («tiene 148 pacientes»). */
  patientCount: number | null;
  /** Solo en `subscription_active`, y como texto `AAAA-MM-DD`: es una columna `date`. */
  planRenewsOn: string | null;
};

export interface AccountDeletionPort {
  /**
   * El borrado entero en una transacción, con la línea de `access_audit` que la propia
   * función escribe. `retentionUntil` llega calculado por quien llama —el plazo es
   * configuración del despliegue— y queda en la bitácora como el hecho histórico de ESTE
   * borrado.
   */
  deleteMine(p: {
    owner: AccountOwner;
    retentionUntil: string;
    reason: string | null;
  }): Promise<DeletionResult>;
}

// ---------------------------------------------------------------------------------------
// POST /v1/equipo · `medskin_create_team_member()`.
//
// El `practice_id` sale del contexto y la autorización es SER LA DUEÑA, comprobada en la
// función y no en el controlador. Un correo que ya tiene cuenta no se reusa, y el veredicto
// es uno solo: dos serían el oráculo del padrón que §12.2.1 cierra.
// ---------------------------------------------------------------------------------------

export type TeamVerdict = 'created' | 'role_not_assignable' | 'not_owner' | 'email_taken';

export type TeamMemberCreation = {
  verdict: TeamVerdict;
  accountId: string | null;
  practitionerId: string | null;
  /** El nombre de la consulta del contexto, que es lo que el correo del acceso dice. */
  practiceName: string | null;
};

export interface TeamPort {
  create(p: {
    owner: AccountOwner;
    email: string;
    firstName: string;
    lastName: string;
    role: AssignableTeamRole;
    hash: string;
    expiresAt: Date;
  }): Promise<TeamMemberCreation>;
}

// ---------------------------------------------------------------------------------------
// POST /v1/equipo/{miembro_id}/acceso · `medskin_resend_team_access()`.
//
// Puerto aparte del alta y no un tercer verbo en `TeamPort`: quien reenvía un acceso no
// crea a nadie, y al revés. Los implementa la misma clase, que es otra cosa (la I de
// SOLID: puertos pequeños, no clases pequeñas).
// ---------------------------------------------------------------------------------------

/** Lo que hace falta ANTES de acuñar, y nada más. Ni un dato clínico, ni el correo. */
export type TeamMemberForDelivery = {
  /**
   * La cuenta del miembro, y se lee para dos cosas: el contador de «3 por hora para la
   * misma cuenta» —la MISMA clave de Redis que el reenvío de pacientes, así que las tres
   * cuentan igual— y el `subject_id` de la línea de bitácora.
   */
  accountId: string;
  firstName: string;
  /** El nombre de la consulta, que es lo que el correo del acceso dice. */
  practiceName: string;
};

export type TeamResendOutcome =
  | 'acceso_renovado'
  | 'not_owner'
  | 'member_not_found'
  | 'ya_eligio_su_contrasena';

export interface TeamAccessPort {
  /**
   * El miembro de ESTA consulta, activo y que no es quien llama. `null` cuando no hay fila,
   * que es la misma respuesta que un `miembro_id` inventado. La política de `practitioner`
   * sobre `practice_id` es la que acota; el `miembro_id` de la URL es criterio de búsqueda
   * dentro del inquilino del token y no autoriza nada (OWASP A01).
   */
  forDelivery(owner: AccountOwner, practitionerId: string): Promise<TeamMemberForDelivery | null>;

  /**
   * `medskin_resend_team_access()`: acuña la temporal nueva y mata la anterior. Devuelve el
   * veredicto y, solo en `acceso_renovado`, **el correo al que hay que escribir**, que es el
   * único dato que `app_practitioner` no puede leer de `account`. En los otros tres
   * veredictos vuelve nulo: no se filtra el correo de nadie por un 403 ni por un 404.
   */
  resend(p: {
    owner: AccountOwner;
    practitionerId: string;
    /** El de `forDelivery`, para la bitácora. La función no lo recibe: lo resuelve ella. */
    accountId: string;
    hash: string;
    expiresAt: Date;
  }): Promise<{ outcome: TeamResendOutcome; email: string | null }>;
}

/**
 * El correo del acceso del equipo. Puerto propio y de un solo verbo —no un segundo verbo en
 * el de la paciente— porque quien da de alta al equipo no manda accesos de pacientes (la I
 * de SOLID). El MECANISMO es el mismo `MailPort` de siempre: lo que cambia es la plantilla.
 *
 * Lanza si no se pudo entregar: por aquí la temporal no viaja en la respuesta, así que un
 * `void` silencioso dejaría a alguien con cuenta y sin contraseña y a nadie enterado.
 */
export interface TeamAccessMailPort {
  sendTeamAccess(facts: TeamDeliveryFacts): Promise<void>;
}
