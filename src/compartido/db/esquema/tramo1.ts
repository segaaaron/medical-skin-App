// Esquema del tramo 1 · plataforma, acceso y sesión.
//
// Fuentes: docs/diseno/servicios.md §3.3 (qué tablas) y §3.4 (lo no negociable),
// docs/diseno/medskin-design.md §7.3 y §10.2, y los cinco contratos de docs/contratos/.
//
// Un solo archivo a propósito: `practitioner` apunta a `cuenta` y `sesion` apunta a
// `practice`, así que repartirlos en dos módulos crea una importación circular entre
// objetos de tabla que drizzle resuelve mal. Una tabla nueva de otro tramo sí irá a su
// propio archivo: el glob de drizzle.config.ts ya los recoge todos.
//
// Lo que NO está aquí y es deliberado:
//   · Las políticas de RLS, los tres roles y los grants: drizzle-kit no los expresa.
//     Van en la migración, src/compartido/db/migraciones/.
//   · `cuenta` no lleva `practice_id`. La ficha es del inquilino, la cuenta es de la
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
// (§3.2). La alternativa del diseño —índice único sobre lower(correo)— deja el riesgo de
// un `where correo = $1` olvidado, que es justo el error que cuesta un acceso cruzado.
const citext = customType<{ data: string }>({ dataType: () => 'citext' });

const marcaDeTiempo = (nombre: string) => timestamp(nombre, { withTimezone: true, mode: 'string' });

// Toda marca de tiempo viaja como cadena ISO: no entra ni un `Date` de JavaScript.
// El diseño prohíbe librerías de fechas y manda `Temporal` o `Intl` (§2.2, §2.3).
const creadoEn = () => marcaDeTiempo('creado_en').notNull().defaultNow();
const actualizadoEn = () => marcaDeTiempo('actualizado_en').notNull().defaultNow();

const REGIONES = sql`('eu', 'us', 'latam')`;

// ---------------------------------------------------------------------------------------
// practice · es el inquilino. No tiene `practice_id`: lo es (§7.3).
// ---------------------------------------------------------------------------------------

export const practice = pgTable(
  'practice',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nombre: text('nombre').notNull(),
    region: text('region').notNull(),
    pais: text('pais').notNull(),
    zonaHoraria: text('zona_horaria').notNull(),
    moneda: text('moneda').notNull(),

    // El plan y su límite salen del catálogo de la plataforma, nunca del cuerpo de la
    // petición (inquilinos.md · reglas de negocio).
    plan: text('plan').notNull(),
    limitePacientes: integer('limite_pacientes').notNull(),
    planRenuevaEn: date('plan_renueva_en'),

    // `estado` es la pausa de PATCH /v1/plataforma/inquilinos/{id}, no la licencia.
    estado: text('estado').notNull().default('activa'),

    // Los cuatro de «Datos de la consulta» de PrimerDia: nacen vacíos.
    direccion: text('direccion'),
    ciudad: text('ciudad'),
    telefono: text('telefono'),
    logoUrl: text('logo_url'),

    // Solo consola. Nunca sale a la app (inquilinos.md · petición).
    notaInterna: text('nota_interna'),

    // La lista de tres tareas de PrimerDia.dc.html · 1 y 5. Se guardan porque
    // `primer_dia.visible` depende de que la app ya la haya visto una vez más con las
    // tres hechas, y eso no se deduce de ninguna otra tabla.
    primerDiaDatosConsulta: boolean('primer_dia_datos_consulta').notNull().default(false),
    primerDiaHorarios: boolean('primer_dia_horarios').notNull().default(false),
    primerDiaPrimerTratamiento: boolean('primer_dia_primer_tratamiento').notNull().default(false),
    primerDiaCerrada: boolean('primer_dia_cerrada').notNull().default(false),

    creadoEn: creadoEn(),
    actualizadoEn: actualizadoEn(),
  },
  (t) => [
    check('practice_region_ck', sql`${t.region} in ${REGIONES}`),
    check('practice_plan_ck', sql`${t.plan} in ('individual', 'consultorio', 'clinica')`),
    check('practice_estado_ck', sql`${t.estado} in ('activa', 'pausada')`),
    check('practice_pais_ck', sql`${t.pais} ~ '^[A-Z]{2}$'`),
    check('practice_nombre_ck', sql`length(${t.nombre}) between 2 and 120`),
    // Sin índice compuesto: se lee por clave primaria desde la política de RLS
    // (`id = medskin_practice_actual()`), que ya es el índice que empieza por el inquilino.
  ],
);

// ---------------------------------------------------------------------------------------
// licencia · una por consulta. La revisión es a mano (inquilinos.md).
// ---------------------------------------------------------------------------------------

export const licencia = pgTable(
  'licencia',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    practiceId: uuid('practice_id')
      .notNull()
      .references(() => practice.id, { onDelete: 'cascade' }),

    estado: text('estado').notNull().default('sin_enviar'),

    paisEjercicio: text('pais_ejercicio'),
    especialidad: text('especialidad'),
    matricula: text('matricula'),
    // Clave de objeto en el bucket de la región. Ni un byte por la API (§7.1).
    credencialClave: text('credencial_clave'),
    declaracionAceptada: boolean('declaracion_aceptada').notNull().default(false),
    terminosAceptados: boolean('terminos_aceptados').notNull().default(false),

    enviadaEn: marcaDeTiempo('enviada_en'),
    respuestaEstimadaEn: marcaDeTiempo('respuesta_estimada_en'),
    decididaEn: marcaDeTiempo('decidida_en'),
    motivoRechazo: text('motivo_rechazo'),
    // Cuenta de plataforma que decidió. Sin clave foránea: no vive en esta región.
    revisadaPor: uuid('revisada_por'),

    creadoEn: creadoEn(),
    actualizadoEn: actualizadoEn(),
  },
  (t) => [
    // Una consulta, un caso. Un rechazo reabre esta misma fila: el histórico de quién
    // decidió qué vive en `acceso_auditoria`, que no tiene claves foráneas (§12.2.8).
    uniqueIndex('licencia_practice_uq').on(t.practiceId),
    // La cola de revisión de la consola cruza inquilinos a propósito, así que aquí el
    // inquilino NO va delante: la consulta es «qué hay en revisión, por antigüedad».
    index('licencia_cola_revision_idx').on(t.estado, t.enviadaEn),
    check(
      'licencia_estado_ck',
      sql`${t.estado} in ('sin_enviar', 'en_revision', 'verificada', 'rechazada')`,
    ),
    // «400 motivo_rechazo_vacio»: un rechazo sin motivo no se puede guardar. La doctora
    // lo va a leer (inquilinos.md · decision).
    check(
      'licencia_motivo_rechazo_ck',
      sql`${t.estado} <> 'rechazada' or length(${t.motivoRechazo}) between 10 and 300`,
    ),
    check('licencia_matricula_ck', sql`${t.matricula} is null or length(${t.matricula}) between 3 and 40`),
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
    cuentaId: uuid('cuenta_id')
      .notNull()
      .references(() => cuenta.id, { onDelete: 'cascade' }),

    nombre: text('nombre').notNull(),
    apellido: text('apellido').notNull(),
    // El permiso dentro de un inquilino ya resuelto. NO es el rol de autenticación:
    // ese vive en `cuenta.rol` y lo pone el servidor (cuentas.md · POST /v1/equipo).
    rol: text('rol').notNull(),
    estado: text('estado').notNull().default('activa'),

    creadoEn: creadoEn(),
    actualizadoEn: actualizadoEn(),
  },
  (t) => [
    uniqueIndex('practitioner_practice_cuenta_uq').on(t.practiceId, t.cuentaId),
    // Inquilino delante (§7.3, regla 5): «mi equipo activo», que es lo que mira
    // «409 consulta_con_equipo» al borrar la cuenta de la dueña.
    index('practitioner_practice_estado_idx').on(t.practiceId, t.estado),
    // Y uno por cuenta sola, sin inquilino delante a propósito: POST /v1/acceso tiene
    // que averiguar a qué consulta pertenece quien entra ANTES de que exista contexto
    // de inquilino. Es la única consulta del tramo que no puede empezar por él.
    index('practitioner_cuenta_idx').on(t.cuentaId),
    check('practitioner_rol_ck', sql`${t.rol} in ('duena', 'clinico', 'recepcion')`),
    check('practitioner_estado_ck', sql`${t.estado} in ('activa', 'retirada')`),
  ],
);

// ---------------------------------------------------------------------------------------
// cuenta · SIN practice_id, y es deliberado (§12.2.1, _convenciones.md).
// Su aislamiento es por fila: `id = medskin_cuenta_actual()`.
// ---------------------------------------------------------------------------------------

export const cuenta = pgTable(
  'cuenta',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    correo: citext('correo').notNull(),

    // Rol de autenticación. Los dos valores que nombran los contratos: la cuenta del
    // equipo «sigue siendo practitioner» (cuentas.md) y la de la paciente es `paciente`.
    // Nunca llega del cliente: sale del endpoint por el que se creó (_convenciones.md).
    rol: text('rol').notNull(),
    region: text('region').notNull(),

    nombre: text('nombre').notNull(),
    apellido: text('apellido').notNull(),
    // Para llamarla. No sirve para entrar, y no va a servir (cuentas.md).
    celular: text('celular'),

    estado: text('estado').notNull().default('activa'),

    // La pausa por intentos fallidos es del ACCESO, no de la cuenta: con pausa viva se
    // puede recuperar la contraseña (acceso.md, recuperacion.md). El contador por IP vive
    // en Redis, no aquí: no es un dato de la cuenta y caduca solo.
    intentosFallidos: integer('intentos_fallidos').notNull().default(0),
    pausaHasta: marcaDeTiempo('pausa_hasta'),

    borradoEn: marcaDeTiempo('borrado_en'),
    motivoBorrado: text('motivo_borrado'),

    creadoEn: creadoEn(),
    actualizadoEn: actualizadoEn(),
  },
  (t) => [
    // Un despliegue es una región (§7.4), así que el único de la región es el único de
    // la base. citext lo hace insensible a mayúsculas sin índice funcional.
    uniqueIndex('cuenta_correo_uq').on(t.correo),
    check('cuenta_rol_ck', sql`${t.rol} in ('practitioner', 'paciente')`),
    check('cuenta_region_ck', sql`${t.region} in ${REGIONES}`),
    check('cuenta_estado_ck', sql`${t.estado} in ('activa', 'suspendida', 'borrada')`),
  ],
);

// ---------------------------------------------------------------------------------------
// credencial · el hash. Nunca sale de la base (cuentas.md): los grants dan UPDATE del
// hash pero no SELECT, así que la comparación solo puede ser una función SECURITY DEFINER.
// ---------------------------------------------------------------------------------------

export const credencial = pgTable(
  'credencial',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cuentaId: uuid('cuenta_id')
      .notNull()
      .references(() => cuenta.id, { onDelete: 'cascade' }),

    // Argon2id (acceso.md). Una fila por cuenta: acuñar una temporal mata la anterior
    // (cuentas.md · POST /v1/cuentas/{id}/acceso).
    hash: text('hash').notNull(),

    esTemporal: boolean('es_temporal').notNull().default(true),
    temporalCaducaEn: marcaDeTiempo('temporal_caduca_en'),
    temporalUsadaEn: marcaDeTiempo('temporal_usada_en'),
    establecidaEn: marcaDeTiempo('establecida_en'),

    creadoEn: creadoEn(),
    actualizadoEn: actualizadoEn(),
  },
  (t) => [
    uniqueIndex('credencial_cuenta_uq').on(t.cuentaId),
    // Una temporal sin fecha de caducidad vive para siempre en la bandeja de correo, y
    // eso es justo lo que las 72 h cierran (acceso.md).
    check(
      'credencial_temporal_caduca_ck',
      sql`${t.esTemporal} = false or ${t.temporalCaducaEn} is not null`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------
// sesion · un dispositivo. No lleva practice_id como inquilino propio: lo lleva como
// copia del reclamo del token, para que la consola pueda contar versiones de app.
// Una doctora NO ve las sesiones de sus pacientes (acceso.md).
// ---------------------------------------------------------------------------------------

export const sesion = pgTable(
  'sesion',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cuentaId: uuid('cuenta_id')
      .notNull()
      .references(() => cuenta.id, { onDelete: 'cascade' }),
    // Nulo para una paciente: no es de ningún inquilino (_convenciones.md).
    practiceId: uuid('practice_id').references(() => practice.id, { onDelete: 'cascade' }),

    alcance: text('alcance').notNull(),

    // Cadena opaca, hasheada: un volcado de la base no da sesiones vivas (sesion.md).
    refrescoHash: text('refresco_hash'),
    refrescoCaducaEn: marcaDeTiempo('refresco_caduca_en'),
    refrescoRotadoEn: marcaDeTiempo('refresco_rotado_en'),
    // El refresco inmediatamente anterior se conserva para distinguir
    // «401 refresco_reutilizado» de «401 refresco_no_valido», que son dos frases
    // distintas a propósito y significan dos cosas distintas para quien las lee.
    // Guarda una generación: un replay de tres generaciones atrás cae en
    // `refresco_no_valido`, que expulsa igual pero con la frase menos alarmante.
    refrescoAnteriorHash: text('refresco_anterior_hash'),
    // La ventana de gracia de 20 s NO está aquí: el contrato dice «guardado en caché»,
    // y una caché de 20 s no es una fila de base de datos.
    revocadaEn: marcaDeTiempo('revocada_en'),
    revocadaMotivo: text('revocada_motivo'),

    // X-MedSkin-Dispositivo. Identifica la sesión en «sesiones activas»; no es un
    // identificador publicitario (_convenciones.md · cabeceras).
    dispositivoId: text('dispositivo_id').notNull(),
    dispositivo: text('dispositivo'),
    sistema: text('sistema'),
    appVersion: text('app_version'),
    plataforma: text('plataforma'),
    // La ciudad resuelta de la IP y nada más fino: sirve para reconocer «esto no fui yo»
    // y una dirección exacta es un dato de localización de quien va a una clínica.
    ciudad: text('ciudad'),

    entroEn: marcaDeTiempo('entro_en').notNull().defaultNow(),
    ultimaVez: marcaDeTiempo('ultima_vez').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sesion_refresco_uq').on(t.refrescoHash).where(sql`refresco_hash is not null`),
    index('sesion_refresco_anterior_idx')
      .on(t.refrescoAnteriorHash)
      .where(sql`refresco_anterior_hash is not null`),
    // «Sesiones activas» de mi cuenta, lo más reciente primero.
    index('sesion_cuenta_activas_idx')
      .on(t.cuentaId, t.ultimaVez.desc())
      .where(sql`revocada_en is null`),
    // Inquilino delante (§7.3, regla 5): `versiones_app` de la consola.
    index('sesion_practice_idx')
      .on(t.practiceId, t.ultimaVez.desc())
      .where(sql`practice_id is not null`),
    check(
      'sesion_alcance_ck',
      sql`${t.alcance} in ('contrasena_temporal', 'recuperacion', 'segundo_factor', 'completo', 'suplantacion')`,
    ),
    check(
      'sesion_plataforma_ck',
      sql`${t.plataforma} is null or ${t.plataforma} in ('ios', 'android', 'server')`,
    ),
    // La sesión restringida no tiene refresco y no se puede prolongar, solo terminar
    // eligiendo la contraseña (acceso.md). Con `siguiente_paso` solo, un cliente escrito
    // a mano se la salta; con esto, no.
    check(
      'sesion_alcance_sin_refresco_ck',
      sql`${t.alcance} = 'completo' or ${t.refrescoHash} is null`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------
// codigo_recuperacion · hasheado con Argon2id, 10 min, un solo uso, 5 intentos.
// Ningún rol de aplicación lee esta tabla nunca (recuperacion.md): no hay grant para
// app_doctora ni para app_plataforma, y la única vía es una función SECURITY DEFINER.
// ---------------------------------------------------------------------------------------

export const codigoRecuperacion = pgTable(
  'codigo_recuperacion',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cuentaId: uuid('cuenta_id')
      .notNull()
      .references(() => cuenta.id, { onDelete: 'cascade' }),

    codigoHash: text('codigo_hash').notNull(),
    caducaEn: marcaDeTiempo('caduca_en').notNull(),
    intentos: integer('intentos').notNull().default(0),

    usadaEn: marcaDeTiempo('usada_en'),
    anuladaEn: marcaDeTiempo('anulada_en'),
    anuladaMotivo: text('anulada_motivo'),

    creadoEn: creadoEn(),
  },
  (t) => [
    // «Solo hay uno vivo por cuenta»: pedir otro anula el anterior (recuperacion.md).
    // El índice parcial lo garantiza en la base, no en el código.
    uniqueIndex('codigo_recuperacion_vivo_uq')
      .on(t.cuentaId)
      .where(sql`usada_en is null and anulada_en is null`),
    index('codigo_recuperacion_cuenta_idx').on(t.cuentaId, t.creadoEn.desc()),
    check(
      'codigo_recuperacion_anulada_ck',
      sql`${t.anuladaMotivo} is null or ${t.anuladaMotivo} in ('intentos', 'codigo_nuevo', 'usado')`,
    ),
    check('codigo_recuperacion_intentos_ck', sql`${t.intentos} between 0 and 5`),
  ],
);

// ---------------------------------------------------------------------------------------
// clave_idempotencia · (clave, cuenta que llama, cuerpo hasheado) 24 h, y repite la
// respuesta original byte a byte (_convenciones.md).
// El inquilino de la fila es «el de quien llama» (§3.3): practice_id para la doctora,
// cuenta_id para la paciente y para la plataforma.
// ---------------------------------------------------------------------------------------

export const claveIdempotencia = pgTable(
  'clave_idempotencia',
  {
    clave: text('clave').notNull(),
    cuentaId: uuid('cuenta_id').notNull(),
    practiceId: uuid('practice_id'),

    cuerpoHash: text('cuerpo_hash').notNull(),
    // Nulos mientras la operación está en vuelo. Con respuesta, se repite tal cual.
    estadoHttp: integer('estado_http'),
    respuesta: jsonb('respuesta'),

    creadoEn: creadoEn(),
    caducaEn: marcaDeTiempo('caduca_en').notNull(),
  },
  (t) => [
    // La clave es del cliente y se guarda por cuenta que llama: la misma clave de dos
    // cuentas distintas son dos operaciones distintas.
    primaryKey({ columns: [t.cuentaId, t.clave] }),
    // Inquilino delante (§7.3, regla 5) para la política de app_doctora.
    index('clave_idempotencia_practice_idx')
      .on(t.practiceId, t.caducaEn)
      .where(sql`practice_id is not null`),
    index('clave_idempotencia_purga_idx').on(t.caducaEn),
  ],
);

// ---------------------------------------------------------------------------------------
// service_failure · §10.2 del diseño, verbatim.
// Los nombres de columna están en inglés porque el diseño publica su DDL así y «si algo
// contradice al diseño, gana el diseño» (servicios.md, encabezado). Cambiarlos
// desincronizaría la tabla de su especificación.
// Sin claves foráneas: la fila sobrevive al borrado de lo que describe (§12.2.8).
// Sin particionar todavía: §3.5 pone la partición como respuesta al volumen, no como
// requisito del día uno, y el índice ya empieza por el inquilino.
// ---------------------------------------------------------------------------------------

export const serviceFailure = pgTable(
  'service_failure',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    occurredAt: marcaDeTiempo('occurred_at').notNull().defaultNow(),

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
    resolvedAt: marcaDeTiempo('resolved_at'),
    resolution: text('resolution'),
  },
  (t) => [
    index('service_failure_occurred_idx').on(t.occurredAt.desc()),
    index('service_failure_operacion_idx').on(t.service, t.operation, t.occurredAt.desc()),
    index('service_failure_codigo_idx').on(t.errorCode, t.occurredAt.desc()),
    // Inquilino delante (§7.3, regla 5): es lo que lee la doctora de lo que la afecta.
    index('service_failure_practice_idx').on(t.practiceId, t.occurredAt.desc()),
    index('service_failure_trace_idx').on(t.traceId),
    check('service_failure_severity_ck', sql`${t.severity} in ('warning', 'error', 'critical')`),
  ],
);

// ---------------------------------------------------------------------------------------
// acceso_auditoria · la bitácora. Inmutable: no hay política de UPDATE ni de DELETE para
// ningún rol, así que no se puede reescribir ni borrar desde la aplicación.
// Sin claves foráneas (§12.2.8): un registro que desaparece con lo que describe no sirve.
// La exigen ya tres contratos del tramo: la decisión de licencia «va a audit_log con
// quién la tomó» (inquilinos.md), la entrega de la contraseña temporal «queda en
// audit_log con quién la pidió» y las dos acciones de consola también (cuentas.md).
// ---------------------------------------------------------------------------------------

export const accesoAuditoria = pgTable(
  'acceso_auditoria',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    ocurrioEn: marcaDeTiempo('ocurrio_en').notNull().defaultNow(),

    practiceId: uuid('practice_id'),
    actorCuentaId: uuid('actor_cuenta_id'),
    // El nombre de quien entró, que es lo que la bitácora de accesos promete mostrar
    // (DoctorAjustes). Se copia porque la fila sobrevive al borrado de la cuenta.
    actorEtiqueta: text('actor_etiqueta'),

    accion: text('accion').notNull(),
    sujetoTipo: text('sujeto_tipo'),
    sujetoId: uuid('sujeto_id'),
    // Nunca dato clínico ni personal: identificadores sí, contenido no (§10.3, regla 1).
    datos: jsonb('datos'),
    region: text('region'),
  },
  (t) => [
    // Inquilino delante (§7.3, regla 5): la bitácora de accesos de una consulta.
    index('acceso_auditoria_practice_idx').on(t.practiceId, t.ocurrioEn.desc()),
    index('acceso_auditoria_actor_idx').on(t.actorCuentaId, t.ocurrioEn.desc()),
    index('acceso_auditoria_accion_idx').on(t.accion, t.ocurrioEn.desc()),
  ],
);
