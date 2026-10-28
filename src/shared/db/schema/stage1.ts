// Esquema del tramo 1 · plataforma, acceso y sesión.
//
// Fuentes: docs/diseno/servicios.md §3.3 (qué tablas) y §3.4 (lo no negociable),
// docs/diseno/medskin-design.md §7.3 y §10.2, y los cinco contratos de docs/contratos/.
//
// Los identificadores van en INGLÉS y los comentarios en español: norma del dueño del 27
// de octubre de 2026. El formato de la API —campos JSON y códigos de error— sigue en
// español porque lo fija el contrato y la app de iOS ya lo consume, así que el mapeo
// nombre-de-columna → campo-de-JSON lo hace el adaptador de HTTP, no esta tabla.
//
// Un solo archivo a propósito: `practitioner` apunta a `account` y `session` apunta a
// `practice`, así que repartirlos en dos módulos crea una importación circular entre
// objetos de tabla que drizzle resuelve mal. Una tabla nueva de otro tramo sí irá a su
// propio archivo: el glob de drizzle.config.ts ya los recoge todos.
//
// Lo que NO está aquí y es deliberado:
//   · Las políticas de RLS, los cuatro roles y los grants: drizzle-kit no los expresa.
//     Van en la migración, src/shared/db/migrations/.
//   · `account` no lleva `practice_id`. La ficha es del inquilino, la cuenta es de la
//     persona (§12.2.1). Su aislamiento es por fila, no por inquilino.

import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Correo insensible a mayúsculas sin tener que acordarse de `lower()` en cada consulta
// (§3.2). La alternativa del diseño —índice único sobre lower(email)— deja el riesgo de
// un `where email = $1` olvidado, que es justo el error que cuesta un acceso cruzado.
const citext = customType<{ data: string }>({ dataType: () => 'citext' });

const timestampTz = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

// Toda marca de tiempo viaja como cadena ISO: no entra ni un `Date` de JavaScript.
// El diseño prohíbe librerías de fechas y manda `Temporal` o `Intl` (§2.2, §2.3).
const createdAt = () => timestampTz('created_at').notNull().defaultNow();
const updatedAt = () => timestampTz('updated_at').notNull().defaultNow();

const REGIONS = sql`('eu', 'us', 'latam')`;

// ---------------------------------------------------------------------------------------
// practice · es el inquilino. No tiene `practice_id`: lo es (§7.3).
// ---------------------------------------------------------------------------------------

export const practice = pgTable(
  'practice',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    region: text('region').notNull(),
    country: text('country').notNull(),
    timeZone: text('time_zone').notNull(),
    currency: text('currency').notNull(),

    // El plan y su límite salen del catálogo de la plataforma, nunca del cuerpo de la
    // petición (inquilinos.md · reglas de negocio).
    plan: text('plan').notNull(),
    patientLimit: integer('patient_limit').notNull(),
    planRenewsOn: date('plan_renews_on'),

    // `status` es la pausa de PATCH /v1/plataforma/inquilinos/{id}, no la licencia.
    status: text('status').notNull().default('activa'),

    // Los cuatro de «Datos de la consulta» de PrimerDia: nacen vacíos.
    address: text('address'),
    city: text('city'),
    phone: text('phone'),
    logoUrl: text('logo_url'),

    // Solo consola. Nunca sale a la app (inquilinos.md · petición).
    internalNote: text('internal_note'),

    // La dueña de la consulta. Vive aquí, y no como un `role` de `practitioner`, porque la
    // consola necesita el vínculo consulta↔dueña y NO tiene políticas de `practitioner`
    // (decisión 5 del 27 oct). `practice` ya es tabla de plataforma, así que el vínculo
    // cabe sin abrirle una tabla más.
    ownerAccountId: uuid('owner_account_id').references(() => account.id, { onDelete: 'set null' }),

    // La lista de tres tareas de PrimerDia.dc.html · 1 y 5. Se guardan porque
    // `primer_dia.visible` depende de que la app ya la haya visto una vez más con las
    // tres hechas, y eso no se deduce de ninguna otra tabla.
    firstDayPracticeData: boolean('first_day_practice_data').notNull().default(false),
    firstDaySchedule: boolean('first_day_schedule').notNull().default(false),
    firstDayFirstTreatment: boolean('first_day_first_treatment').notNull().default(false),
    firstDayDismissed: boolean('first_day_dismissed').notNull().default(false),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('practice_region_ck', sql`${t.region} in ${REGIONS}`),
    check('practice_plan_ck', sql`${t.plan} in ('individual', 'consultorio', 'clinica')`),
    check('practice_status_ck', sql`${t.status} in ('activa', 'pausada')`),
    check('practice_country_ck', sql`${t.country} ~ '^[A-Z]{2}$'`),
    check('practice_name_ck', sql`length(${t.name}) between 2 and 120`),
    // Sin índice compuesto: se lee por clave primaria desde la política de RLS
    // (`id = medskin_current_practice()`), que ya es el índice que empieza por el inquilino.
    //
    // Este sí es por cuenta y NO empieza por el inquilino, igual que
    // `practitioner_account_idx` y por el mismo motivo: la consola pregunta «qué consulta
    // es de esta cuenta» y eso cruza inquilinos a propósito (§7.3, regla 5 habla de las
    // rutas calientes dentro de un inquilino). Parcial: la gran mayoría de las filas la
    // tienen puesta, pero el nulo no se indexa porque nadie lo busca.
    index('practice_owner_account_idx').on(t.ownerAccountId).where(sql`owner_account_id is not null`),
  ],
);

// ---------------------------------------------------------------------------------------
// license · una por consulta. La revisión es a mano (inquilinos.md).
// ---------------------------------------------------------------------------------------

export const license = pgTable(
  'license',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    practiceId: uuid('practice_id')
      .notNull()
      .references(() => practice.id, { onDelete: 'cascade' }),

    status: text('status').notNull().default('sin_enviar'),

    practiceCountry: text('practice_country'),
    specialty: text('specialty'),
    licenseNumber: text('license_number'),
    // Clave de objeto en el bucket de la región. Ni un byte por la API (§7.1).
    credentialKey: text('credential_key'),
    declarationAccepted: boolean('declaration_accepted').notNull().default(false),
    termsAccepted: boolean('terms_accepted').notNull().default(false),

    submittedAt: timestampTz('submitted_at'),
    responseEstimatedAt: timestampTz('response_estimated_at'),
    decidedAt: timestampTz('decided_at'),
    rejectionReason: text('rejection_reason'),
    // Cuenta de plataforma que decidió. Sin clave foránea: no vive en esta región.
    reviewedBy: uuid('reviewed_by'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Una consulta, un caso. Un rechazo reabre esta misma fila: el histórico de quién
    // decidió qué vive en `access_audit`, que no tiene claves foráneas (§12.2.8).
    uniqueIndex('license_practice_uq').on(t.practiceId),
    // La cola de revisión de la consola cruza inquilinos a propósito, así que aquí el
    // inquilino NO va delante: la consulta es «qué hay en revisión, por antigüedad».
    index('license_review_queue_idx').on(t.status, t.submittedAt),
    check(
      'license_status_ck',
      sql`${t.status} in ('sin_enviar', 'en_revision', 'verificada', 'rechazada')`,
    ),
    // «400 motivo_rechazo_vacio»: un rechazo sin motivo no se puede guardar. La doctora
    // lo va a leer (inquilinos.md · decision).
    check(
      'license_rejection_reason_ck',
      sql`${t.status} <> 'rechazada' or length(${t.rejectionReason}) between 10 and 300`,
    ),
    check(
      'license_number_ck',
      sql`${t.licenseNumber} is null or length(${t.licenseNumber}) between 3 and 40`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------
// practitioner · la doctora y su equipo, dentro de un inquilino.
// ---------------------------------------------------------------------------------------

export const practitioner = pgTable(
  'practitioner',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    practiceId: uuid('practice_id')
      .notNull()
      .references(() => practice.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),

    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    // El permiso dentro de un inquilino ya resuelto. NO es el rol de autenticación:
    // ese vive en `account.role` y lo pone el servidor (cuentas.md · POST /v1/equipo).
    role: text('role').notNull(),
    // Nulo = «los de su `role`», y es lo que tendrá el 100 % de las filas de la primera
    // entrega (decisión 11 del 27 oct). La lista explícita la escribe «Equipo y permisos»
    // cuando la dueña la edite de una en una. `GET /v1/sesion` devuelve siempre la lista
    // resuelta, nunca el rol: la app no deduce permisos (sesion.md).
    permissions: text('permissions').array(),
    status: text('status').notNull().default('activa'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('practitioner_practice_account_uq').on(t.practiceId, t.accountId),
    // Inquilino delante (§7.3, regla 5): «mi equipo activo», que es lo que mira
    // «409 consulta_con_equipo» al borrar la cuenta de la dueña.
    index('practitioner_practice_status_idx').on(t.practiceId, t.status),
    // Y uno por cuenta sola, sin inquilino delante a propósito: POST /v1/acceso tiene
    // que averiguar a qué consulta pertenece quien entra ANTES de que exista contexto
    // de inquilino. Es la única consulta del tramo que no puede empezar por él.
    index('practitioner_account_idx').on(t.accountId),
    // Decisión 12 del 27 oct. `paciente` no es rol de `practitioner`: vive en `account`.
    // Y `duena` ya no es un rol: la dueña es `practice.owner_account_id` (decisión 5),
    // que es un hecho de la consulta y no un permiso dentro de ella.
    check('practitioner_role_ck', sql`${t.role} in ('doctora', 'recepcion', 'asistente_clinico')`),
    check('practitioner_status_ck', sql`${t.status} in ('activa', 'retirada')`),
    // Una lista vacía no significa nada: o es nula (los de su rol) o tiene permisos.
    check(
      'practitioner_permissions_ck',
      sql`${t.permissions} is null or array_length(${t.permissions}, 1) > 0`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------
// account · SIN practice_id, y es deliberado (§12.2.1, _convenciones.md).
// Su aislamiento es por fila: `id = medskin_current_account()`.
// ---------------------------------------------------------------------------------------

export const account = pgTable(
  'account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull(),

    // Rol de autenticación. Los dos valores que nombran los contratos: la cuenta del
    // equipo «sigue siendo practitioner» (cuentas.md) y la de la paciente es `paciente`.
    // Nunca llega del cliente: sale del endpoint por el que se creó (_convenciones.md).
    role: text('role').notNull(),
    region: text('region').notNull(),

    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    // Para llamarla. No sirve para entrar, y no va a servir (cuentas.md).
    phone: text('phone'),

    status: text('status').notNull().default('activa'),

    // La pausa por intentos fallidos es del ACCESO, no de la cuenta: con pausa viva se
    // puede recuperar la contraseña (acceso.md, recuperacion.md). El contador por IP vive
    // en Redis, no aquí: no es un dato de la cuenta y caduca solo.
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestampTz('locked_until'),

    deletedAt: timestampTz('deleted_at'),
    deletionReason: text('deletion_reason'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Un despliegue es una región (§7.4), así que el único de la región es el único de
    // la base. citext lo hace insensible a mayúsculas sin índice funcional.
    uniqueIndex('account_email_uq').on(t.email),
    check('account_role_ck', sql`${t.role} in ('practitioner', 'paciente')`),
    check('account_region_ck', sql`${t.region} in ${REGIONS}`),
    check('account_status_ck', sql`${t.status} in ('activa', 'suspendida', 'borrada')`),
  ],
);

// ---------------------------------------------------------------------------------------
// credential · el hash. Nunca sale de la base (cuentas.md): los grants dan UPDATE del
// hash pero no SELECT, así que la comparación solo puede ser una función SECURITY DEFINER.
// ---------------------------------------------------------------------------------------

export const credential = pgTable(
  'credential',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),

    // Argon2id (acceso.md). Una fila por cuenta: acuñar una temporal mata la anterior
    // (cuentas.md · POST /v1/cuentas/{id}/acceso).
    hash: text('hash').notNull(),

    isTemporary: boolean('is_temporary').notNull().default(true),
    tempExpiresAt: timestampTz('temp_expires_at'),
    // Dos marcas, y hacen falta las dos (ver la 0002 · sección 1). `tempFirstUsedAt` es la
    // PRIMERA entrada con la temporal y es lo que habilita la recuperación por correo;
    // `tempUsedAt` es el consumo, al guardar la definitiva (decisión 2). Con una sola, la
    // paciente que entra y se le cierra la app en «Crea tu contraseña» se queda sin
    // recuperación y sin forma de enterarse, porque el 202 es idéntico siempre.
    tempFirstUsedAt: timestampTz('temp_first_used_at'),
    tempUsedAt: timestampTz('temp_used_at'),
    setAt: timestampTz('set_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('credential_account_uq').on(t.accountId),
    // Una temporal sin fecha de caducidad vive para siempre en la bandeja de correo, y
    // eso es justo lo que las 72 h cierran (acceso.md).
    check(
      'credential_temp_expires_ck',
      sql`${t.isTemporary} = false or ${t.tempExpiresAt} is not null`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------
// access_decoy · UNA fila, un hash de Argon2id de una contraseña aleatoria que nadie
// conoce. Es lo que `medskin_access_credential()` devuelve cuando el correo no existe,
// para que el camino de «no existe» ejecute el MISMO verificado de Argon2id que el de
// «contraseña mal» y tarde lo mismo (acceso.md: «Sin eso, la respuesta inmediata del caso
// "no existe" es el oráculo que la frase niega»).
//
// No es dato de inquilino y no hace falta que lo sea: no tiene un solo GRANT para ningún
// rol de aplicación. Lo lee la función del acceso y nadie más. Está en una tabla en vez de
// dentro de la función para poder volver a sembrarlo sin una migración el día que cambien
// los parámetros de Argon2id del servidor: si divergen, el señuelo tarda distinto y el
// oráculo vuelve por la puerta del reloj.
// ---------------------------------------------------------------------------------------

export const accessDecoy = pgTable(
  'access_decoy',
  {
    // Una fila y solo una: la clave primaria es un booleano que solo puede ser `true`.
    onlyRow: boolean('only_row').primaryKey().default(true),
    hash: text('hash').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [check('access_decoy_only_row_ck', sql`${t.onlyRow}`)],
);

// ---------------------------------------------------------------------------------------
// session · un dispositivo. No lleva practice_id como inquilino propio: lo lleva como
// copia del reclamo del token, para que la consola pueda contar versiones de app.
// Una doctora NO ve las sesiones de sus pacientes (acceso.md).
// ---------------------------------------------------------------------------------------

export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    // Nulo para una paciente: no es de ningún inquilino (_convenciones.md).
    practiceId: uuid('practice_id').references(() => practice.id, { onDelete: 'cascade' }),

    scope: text('scope').notNull(),

    // Cadena opaca, hasheada: un volcado de la base no da sesiones vivas (sesion.md).
    refreshHash: text('refresh_hash'),
    refreshExpiresAt: timestampTz('refresh_expires_at'),
    refreshRotatedAt: timestampTz('refresh_rotated_at'),
    // El refresco inmediatamente anterior se conserva para distinguir
    // «401 refresco_reutilizado» de «401 refresco_no_valido», que son dos frases
    // distintas a propósito y significan dos cosas distintas para quien las lee.
    // Guarda una generación: un replay de tres generaciones atrás cae en
    // `refresco_no_valido`, que expulsa igual pero con la frase menos alarmante.
    previousRefreshHash: text('previous_refresh_hash'),
    // La ventana de gracia de 20 s NO está aquí: el contrato dice «guardado en caché»,
    // y una caché de 20 s no es una fila de base de datos.
    revokedAt: timestampTz('revoked_at'),
    revokedReason: text('revoked_reason'),

    // X-MedSkin-Dispositivo. Identifica la sesión en «sesiones activas»; no es un
    // identificador publicitario (_convenciones.md · cabeceras).
    deviceId: text('device_id').notNull(),
    device: text('device'),
    os: text('os'),
    appVersion: text('app_version'),
    platform: text('platform'),
    // La ciudad resuelta de la IP y nada más fino: sirve para reconocer «esto no fui yo»
    // y una dirección exacta es un dato de localización de quien va a una clínica.
    city: text('city'),

    signedInAt: timestampTz('signed_in_at').notNull().defaultNow(),
    lastSeenAt: timestampTz('last_seen_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('session_refresh_uq').on(t.refreshHash).where(sql`refresh_hash is not null`),
    index('session_previous_refresh_idx')
      .on(t.previousRefreshHash)
      .where(sql`previous_refresh_hash is not null`),
    // «Sesiones activas» de mi cuenta, lo más reciente primero.
    index('session_account_active_idx')
      .on(t.accountId, t.lastSeenAt.desc())
      .where(sql`revoked_at is null`),
    // Inquilino delante (§7.3, regla 5): `versiones_app` de la consola.
    index('session_practice_idx')
      .on(t.practiceId, t.lastSeenAt.desc())
      .where(sql`practice_id is not null`),
    check(
      'session_scope_ck',
      sql`${t.scope} in ('contrasena_temporal', 'recuperacion', 'segundo_factor', 'completo', 'suplantacion')`,
    ),
    check(
      'session_platform_ck',
      sql`${t.platform} is null or ${t.platform} in ('ios', 'android', 'server')`,
    ),
    // La sesión restringida no tiene refresco y no se puede prolongar, solo terminar
    // eligiendo la contraseña (acceso.md). Con `siguiente_paso` solo, un cliente escrito
    // a mano se la salta; con esto, no.
    check(
      'session_scope_without_refresh_ck',
      sql`${t.scope} = 'completo' or ${t.refreshHash} is null`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------
// recovery_code · hasheado con Argon2id, 10 min, un solo uso, 5 intentos.
// Ningún rol de aplicación lee esta tabla nunca (recuperacion.md): no hay grant para
// app_practitioner ni para app_platform, y la única vía es una función SECURITY DEFINER.
// ---------------------------------------------------------------------------------------

export const recoveryCode = pgTable(
  'recovery_code',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),

    codeHash: text('code_hash').notNull(),
    expiresAt: timestampTz('expires_at').notNull(),
    attempts: integer('attempts').notNull().default(0),

    usedAt: timestampTz('used_at'),
    voidedAt: timestampTz('voided_at'),
    voidedReason: text('voided_reason'),

    createdAt: createdAt(),
  },
  (t) => [
    // «Solo hay uno vivo por cuenta»: pedir otro anula el anterior (recuperacion.md).
    // El índice parcial lo garantiza en la base, no en el código.
    uniqueIndex('recovery_code_live_uq')
      .on(t.accountId)
      .where(sql`used_at is null and voided_at is null`),
    index('recovery_code_account_idx').on(t.accountId, t.createdAt.desc()),
    check(
      'recovery_code_voided_ck',
      sql`${t.voidedReason} is null or ${t.voidedReason} in ('intentos', 'codigo_nuevo', 'usado')`,
    ),
    check('recovery_code_attempts_ck', sql`${t.attempts} between 0 and 5`),
  ],
);

// ---------------------------------------------------------------------------------------
// idempotency_key · (clave, cuenta que llama, cuerpo hasheado) 24 h, y repite la
// respuesta original byte a byte (_convenciones.md).
// El inquilino de la fila es «el de quien llama» (§3.3): practice_id para la doctora,
// account_id para la paciente y para la plataforma.
// ---------------------------------------------------------------------------------------

export const idempotencyKey = pgTable(
  'idempotency_key',
  {
    key: text('key').notNull(),
    accountId: uuid('account_id').notNull(),
    practiceId: uuid('practice_id'),

    bodyHash: text('body_hash').notNull(),
    // Nulos mientras la operación está en vuelo. Con respuesta, se repite tal cual.
    httpStatus: integer('http_status'),
    response: jsonb('response'),

    createdAt: createdAt(),
    expiresAt: timestampTz('expires_at').notNull(),
  },
  (t) => [
    // La clave es del cliente y se guarda por cuenta que llama: la misma clave de dos
    // cuentas distintas son dos operaciones distintas.
    primaryKey({ columns: [t.accountId, t.key] }),
    // Inquilino delante (§7.3, regla 5) para la política de app_practitioner.
    index('idempotency_key_practice_idx')
      .on(t.practiceId, t.expiresAt)
      .where(sql`practice_id is not null`),
    index('idempotency_key_purge_idx').on(t.expiresAt),
  ],
);

// ---------------------------------------------------------------------------------------
// service_failure · §10.2 del diseño, verbatim. Ya estaba en inglés porque el diseño
// publica su DDL así y «si algo contradice al diseño, gana el diseño» (servicios.md).
// Sin claves foráneas: la fila sobrevive al borrado de lo que describe (§12.2.8).
// Sin particionar todavía: §3.5 pone la partición como respuesta al volumen, no como
// requisito del día uno, y el índice ya empieza por el inquilino.
// ---------------------------------------------------------------------------------------

export const serviceFailure = pgTable(
  'service_failure',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    occurredAt: timestampTz('occurred_at').notNull().defaultNow(),

    service: text('service').notNull(),
    operation: text('operation').notNull(),
    severity: text('severity').notNull(),

    errorCode: text('error_code').notNull(),
    // El mensaje real del origen, sin recortar y sin reemplazar (§10.3, regla 2).
    errorMessage: text('error_message').notNull(),
    causeChain: jsonb('cause_chain'),
    stack: text('stack'),
    externalStatus: integer('external_status'),
    externalBody: jsonb('external_body'),

    practiceId: uuid('practice_id'),
    actorId: uuid('actor_id'),
    subjectType: text('subject_type'),
    // El objeto afectado, por id. NUNCA su contenido (§10.3, regla 1).
    subjectId: uuid('subject_id'),

    traceId: text('trace_id').notNull(),
    spanId: text('span_id'),
    requestId: text('request_id'),
    inputDigest: text('input_digest'),
    appVersion: text('app_version'),
    platform: text('platform'),
    region: text('region'),

    attempt: integer('attempt').notNull().default(1),
    willRetry: boolean('will_retry').notNull(),
    resolvedAt: timestampTz('resolved_at'),
    resolution: text('resolution'),
  },
  (t) => [
    index('service_failure_occurred_idx').on(t.occurredAt.desc()),
    index('service_failure_operation_idx').on(t.service, t.operation, t.occurredAt.desc()),
    index('service_failure_code_idx').on(t.errorCode, t.occurredAt.desc()),
    // Inquilino delante (§7.3, regla 5): es lo que lee la doctora de lo que la afecta.
    index('service_failure_practice_idx').on(t.practiceId, t.occurredAt.desc()),
    index('service_failure_trace_idx').on(t.traceId),
    check('service_failure_severity_ck', sql`${t.severity} in ('warning', 'error', 'critical')`),
  ],
);

// ---------------------------------------------------------------------------------------
// access_audit · la bitácora. Inmutable: no hay política de UPDATE ni de DELETE para
// ningún rol, así que no se puede reescribir ni borrar desde la aplicación.
// Sin claves foráneas (§12.2.8): un registro que desaparece con lo que describe no sirve.
// La exigen ya tres contratos del tramo: la decisión de licencia «va a audit_log con
// quién la tomó» (inquilinos.md), la entrega de la contraseña temporal «queda en
// audit_log con quién la pidió» y las dos acciones de consola también (cuentas.md).
// ---------------------------------------------------------------------------------------

export const accessAudit = pgTable(
  'access_audit',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    occurredAt: timestampTz('occurred_at').notNull().defaultNow(),

    practiceId: uuid('practice_id'),
    actorAccountId: uuid('actor_account_id'),
    // El nombre de quien entró, que es lo que la bitácora de accesos promete mostrar
    // (DoctorAjustes). Se copia porque la fila sobrevive al borrado de la cuenta.
    actorLabel: text('actor_label'),

    action: text('action').notNull(),
    subjectType: text('subject_type'),
    subjectId: uuid('subject_id'),
    // Nunca dato clínico ni personal: identificadores sí, contenido no (§10.3, regla 1).
    data: jsonb('data'),
    region: text('region'),
  },
  (t) => [
    // Inquilino delante (§7.3, regla 5): la bitácora de accesos de una consulta.
    index('access_audit_practice_idx').on(t.practiceId, t.occurredAt.desc()),
    index('access_audit_actor_idx').on(t.actorAccountId, t.occurredAt.desc()),
    index('access_audit_action_idx').on(t.action, t.occurredAt.desc()),
  ],
);
