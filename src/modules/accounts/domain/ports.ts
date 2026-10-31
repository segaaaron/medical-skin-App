// Los puertos de las cuentas. Dominio: sin NestJS, sin Fastify, sin `pg`.

import type { AccountRole, Region } from '../../../shared/contract/session';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import type {
  DeliveryFacts,
  LinkNoticeFacts,
  PlatformDeliveryFacts,
} from './access-delivery';
import type { HistoryDraft, HistoryField, PatientFicha } from './patient-registration';

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
// El acceso de SU paciente · `POST /v1/accounts/{account_id}/access`.
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
   * lectura ya pasa por la política de la consulta y acuñar la sobreescribe: después ya no
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
// GET /v1/accounts/mine · quién soy, qué rol tengo y qué pantalla toca.
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
// DELETE /v1/accounts/mine · `medskin_delete_own_account()`.
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
// POST /v1/patients · el alta de una paciente. LA ÚNICA PUERTA DE UNA PACIENTE AL SISTEMA.
//
// Un solo verbo y UNA SOLA TRANSACCIÓN, y no es comodidad: el alta es «su ficha y su
// cuenta, en un solo acto». Repartida en dos llamadas, un fallo entre ellas deja una cuenta
// sin ficha —invisible para la doctora, que no tiene política de `SELECT` sobre `account`—
// o una ficha sin vínculo, que es una paciente a la que nadie puede mandarle su acceso.
//
// La autorización no es un `if`: son las políticas de `patient`, `patient_link` y
// `medical_history` sobre `practice_id`, más una función `SECURITY DEFINER` que NO recibe
// `account_id` —con uno, una doctora podría acuñar una temporal sobre la cuenta de
// cualquiera— y que saca la consulta y la región del contexto.
// ---------------------------------------------------------------------------------------

/**
 * Quién la refirió, su plan y el duplicado: todo de la consulta del contexto.
 *
 * **`license_unverified` ya no está** (30 oct 2026): era «tu licencia todavía no está
 * verificada», y se fue con la revisión manual. MedSkin no verifica licencias.
 */
export type PatientRegistrationVerdict =
  | 'created'
  | 'plan_limit'
  | 'duplicate_email'
  | 'referrer_not_found'
  // La función se niega a reusar la cuenta de una practicante (migración 0021), y el
  // veredicto es OPACO: si dijera el motivo, el alta sería un directorio del personal de
  // MedSkin consultable de uno en uno.
  | 'email_unavailable'
  // Esta misma petición ya se atendió: su respuesta está en `idempotency_key` y se repite
  // tal como se guardó. Lo decide la MISMA transacción que crearía, que es lo que impide que un
  // reintento acabe en dos fichas de la misma persona.
  | 'replayed';

/** La ficha de esta consulta que ya tiene ese correo. La frase la nombra y la app la abre. */
export type DuplicatePatient = {
  patientId: string;
  fullName: string;
  /** Cuándo la dieron de alta. La frase dice «de alta el 3 de agosto». */
  createdAt: Date;
};

export type PatientRegistration = {
  verdict: PatientRegistrationVerdict;
  patientId: string | null;
  accountId: string | null;
  /**
   * «Si la cuenta ya existe en la región, el alta REUSA la cuenta»: no se le acuña ninguna
   * temporal —ya tiene la suya— y la respuesta vale `via: "ya_tiene_cuenta"`. Es lo único
   * que la respuesta revela de la existencia de una cuenta, y se lo revela a la doctora que
   * acaba de escribir el correo de su propia paciente.
   */
  accountAlreadyExisted: boolean;
  /** Solo en `plan_limit`: la frase lleva el número del plan dentro. */
  patientLimit: number | null;
  /** Solo en `duplicate_email`: lo que la frase interpola y lo que la app necesita abrir. */
  duplicate: DuplicatePatient | null;
  /** Solo en `created`: con qué nombre se presenta la doctora en el mensaje del acceso. */
  practitionerName: string | null;
  /** Solo en `replayed`: la respuesta original, tal y como se guardó. */
  replay: { status: number; response: unknown } | null;
};

export interface PatientRegistrationPort {
  /**
   * La ficha, el vínculo, los antecedentes, la cuenta y su temporal, en una transacción.
   * `hash` llega ya calculado y `expiresAt` también: la función exige Argon2id y 72 h.
   */
  register(p: {
    owner: AccountOwner;
    /**
     * La clave de la petición, OBLIGATORIA. Se comprueba al abrir la transacción y se reserva
     * al cerrarla, así que o la ficha y la clave existen las dos, o no existe ninguna.
     */
    idempotency: IdempotencyRecord;
    ficha: PatientFicha;
    history: HistoryDraft;
    /** Los campos que la doctora contestó: cada uno guarda `fuente: doctora`. */
    written: readonly HistoryField[];
    hash: string;
    expiresAt: Date;
    confirmDuplicate: boolean;
    /** `correo | whatsapp | ninguna`, solo para la línea de la bitácora. */
    via: string;
  }): Promise<PatientRegistration>;

  /**
   * La marca de envío de un vínculo RECIÉN CREADO, que es el único caso en que nulo es
   * «nunca se le mandó» de verdad. Se escribe al entregar el correo y se deshace si el relé
   * falla: `patient_link.access_sent_at` solo puede afirmar un envío que ocurrió, y es la
   * columna que la consola lee para decidir si hay que reenviar.
   */
  markAccessSent(owner: AccountOwner, patientId: string, sentAt: Date | null): Promise<void>;

}

/**
 * El cierre de la clave de idempotencia, cuando la respuesta ya es verdad. Puerto propio y de
 * un solo verbo porque lo comparten dos altas que no se parecen en nada más —la de una
 * paciente y la del equipo—, y porque el cierre no es parte de ninguna de las dos
 * operaciones: es lo que las hace repetibles.
 *
 * Por qué no va dentro de la transacción de la operación: estos dos endpoints mandan un
 * correo y `enviado` dice si el relé lo aceptó, así que la respuesta no es definitiva hasta
 * después del `COMMIT`. Y el relé no puede correr dentro de la transacción sin pinchar una
 * conexión del pooler mientras el SMTP piensa. Lo que sostiene la idempotencia es la RESERVA,
 * que sí va dentro.
 */
export interface IdempotencyCompletionPort {
  complete(p: {
    owner: AccountOwner;
    record: IdempotencyRecord;
    status: number;
    response: unknown;
  }): Promise<void>;
}

/**
 * El contador del `429 demasiadas_altas`: «más de 60 altas en una hora». Puerto propio y no
 * un segundo verbo en el del reenvío: son dos límites que protegen cosas distintas —ese, que
 * una doctora no acuñe temporales en bucle sobre la cuenta de su paciente; este, el ritmo de
 * altas de una consulta— y el día que uno cambie, el otro no tiene por qué moverse.
 */
export interface PatientCreationLimitPort {
  count(practiceId: string): Promise<{ tooMany: boolean }>;
}

/**
 * EL AVISO A QUIEN YA TIENE CUENTA. Puerto propio y de un solo verbo, no un segundo verbo en
 * el del acceso: quien manda un acceso con contraseña no manda este aviso, y al revés —de
 * hecho el reenvío no puede mandarlo nunca—. Los implementa la misma clase, que es otra cosa
 * (la I de SOLID: puertos pequeños, no clases pequeñas).
 *
 * Lanza si no se pudo entregar. Aquí no hay contraseña que perder, pero sí una persona que no
 * se enteró de que la vincularon, y eso no se calla.
 */
export interface PatientLinkNoticeMailPort {
  sendLinkNotice(facts: LinkNoticeFacts): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// LA CONSOLA INTERNA · las dos acciones de `cuentas.md` · `Consola.dc.html` · 2, las dos
// marcadas «Seguro» en la pantalla porque no tocan ningún dato clínico.
//
// QUIEN LLAMA NO TIENE CUENTA EN ESTA REGIÓN. No hay `AccountOwner` que construir: la
// identidad de la plataforma vive fuera y lo único que llega del token es el `sub`, la
// etiqueta y la región (`plataforma-acceso.md`). De ahí un actor propio y no un `Caller` con
// nulos: un tipo que miente sobre lo que trae acaba leído como si trajera algo.
//
// El `cuenta_id` viene de la RUTA, y aquí no hay consulta que lo acote: lo que lo acota es
// que las dos operaciones devuelven el MISMO 404 para una cuenta que no existe, una borrada y
// una de otra región, y que las dos dejan su línea en `access_audit` con quién las ejecutó.
// ---------------------------------------------------------------------------------------

/**
 * Quien ejecuta desde la consola. `subject` es un uuid y es lo único del token que entra en
 * la base —a `medskin.account_id` y a `access_audit.actor_account_id`—; `label` es el nombre
 * legible de esa persona y **no entra en ninguna comparación**: va a la bitácora y nada más.
 */
export type ConsoleActor = {
  subject: string;
  label: string;
  region: Region;
};

export type PlatformResendOutcome = 'acceso_renovado' | 'cuenta_no_existe' | 'ya_eligio_su_contrasena';

export interface PlatformAccessPort {
  /**
   * `medskin_platform_resend_access()`: acuña la temporal nueva, mata la anterior y revoca
   * las sesiones de esa cuenta (0020). **Devuelve dos columnas y ninguna es la contraseña**,
   * y eso no es una omisión: «Va a su propio correo. Soporte no la ve» tiene que ser verdad
   * en la base y no en el controlador.
   *
   * `email` vuelve **solo** en `acceso_renovado` —es a dónde hay que escribir— y nulo en los
   * otros dos: no se filtra el correo de nadie por un 404 ni por un 409.
   */
  resend(p: {
    actor: ConsoleActor;
    accountId: string;
    hash: string;
    expiresAt: Date;
  }): Promise<{ outcome: PlatformResendOutcome; expiresAt: Date | null; email: string | null }>;

  /**
   * «Levantar la pausa por intentos · Vuelve a poder entrar. No cambia su contraseña.» Sin
   * función `SECURITY DEFINER`: `app_platform` tiene el `GRANT UPDATE` de esas tres columnas
   * y su política, así que es una sentencia y no hace falta más. **No toca `credential`**, que
   * es lo que la pantalla promete y lo que este rol no puede tocar ni queriendo: esa tabla no
   * tiene ninguna política para él.
   *
   * `false` cuando no hay fila que levantar, que es el `404` y es el mismo para una cuenta
   * inventada, una borrada y una de otra región.
   */
  liftPause(actor: ConsoleActor, accountId: string): Promise<boolean>;
}

/**
 * El correo del reenvío de la consola. Puerto propio y de un solo verbo: su plantilla no se
 * presenta en nombre de ninguna doctora —soporte no puede leer quién es— y esta ruta sirve
 * también a una cuenta de practicante.
 *
 * Lanza si no se pudo entregar: por aquí la contraseña NO viaja en la respuesta, así que un
 * `void` silencioso dejaría a una persona con una temporal nueva que nadie recibió y con la
 * anterior ya muerta.
 */
export interface PlatformAccessMailPort {
  sendAccess(facts: PlatformDeliveryFacts): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// GET /v1/platform/accounts?correo= · `cuentas.md`, 31 de octubre de 2026
// ---------------------------------------------------------------------------------------

/**
 * Un renglón de la búsqueda, con las columnas que `app_platform` puede leer de `account`.
 *
 * **El teléfono NO está aunque este rol ya pueda leerlo** (migración 0075): esta lectura barre
 * `account` por correo, así que puede devolver la fila de una paciente, y un campo de más aquí
 * es un campo de más sobre ella. El teléfono viaja en la ficha de la consulta, que es de la
 * dueña y es donde soporte lo necesita.
 */
export type ConsoleAccountRow = {
  id: string;
  email: string;
  role: string;
  status: string;
  lockedUntil: Date | null;
};

export interface ConsoleAccountSearchPort {
  /**
   * Correo EXACTO, comparado como `citext`: cero filas o una, nunca más —lo garantiza
   * `account_email_uq`—. No es un `ilike` a propósito: un `%paz%` sobre `account` devolvería un
   * listado de personas de MedSkin con dos caracteres, y ahí dentro hay pacientes.
   */
  findByEmail(p: { actor: ConsoleActor; email: string }): Promise<readonly ConsoleAccountRow[]>;
}
