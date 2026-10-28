// Esquema del tramo 2 · la ficha, el vínculo y los antecedentes.
//
// Fuentes: docs/contratos/pacientes.md (completo), docs/contratos/cuentas.md
// (`POST /v1/pacientes` y `POST /v1/cuentas/{cuenta_id}/acceso`), §12.1 y §12.2 del diseño.
//
// Archivo aparte del tramo 1 porque lo dice el comentario de `stage1.ts`: una tabla de
// otro tramo va a su propio archivo y el glob de `drizzle.config.ts` los recoge todos.
// Estas tres apuntan a `practice`, `account` y `patient` y nadie del tramo 1 apunta a
// ellas, así que no hay importación circular.
//
// Lo que NO está aquí y es deliberado: las políticas de RLS, los grants por columna, el
// dominio `medskin_history_source`, las dos extensiones y las dos funciones
// `SECURITY DEFINER`. Nada de eso lo expresa drizzle-kit: va en la migración.
//
// LAS TRES DECISIONES DE FORMA DE ESTE ARCHIVO
//
// 1. `patient_link` COPIA el nombre de la consulta, el de la doctora y la ciudad. Es la
//    respuesta a la pregunta 7: `app_patient` no tiene política en `practice` ni en
//    `practitioner`, y dársela abriría TODOS los inquilinos para poder leer uno. El coste
//    está aceptado y escrito en `pacientes.md`: renombrar una consulta actualiza las copias
//    de sus propios vínculos en la misma transacción.
// 2. Los antecedentes guardan la PROCEDENCIA EN COLUMNAS, dos por campo (`…_source` y
//    `…_source_at`), y no en un `jsonb` de fuentes. Un `jsonb` no tiene restricciones: el
//    día que alguien escriba `{"alergias":{"quien":"asistente"}}` la base lo acepta y la
//    regla «la doctora gana» se queda sin suelo. Con columnas, el dominio
//    `medskin_history_source` las valida todas de una vez, y la regla del `PUT` de la
//    paciente —«solo si está vacío o lo escribió ella»— se escribe como lo que es: un
//    predicado por columna (`… is null or … = 'paciente'`), parametrizado, sin capa mágica.
// 3. `null` y `false` NO son lo mismo, y por eso los dos booleanos clínicos admiten nulo:
//    `false` es «se le preguntó y no tiene», `null` es «nadie preguntó». Una ficha que los
//    confunde guarda un dato falso (pacientes.md · la decisión más importante de la forma).

import { sql, type SQL } from 'drizzle-orm';
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
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { account, practice } from './stage1';

const citext = customType<{ data: string }>({ dataType: () => 'citext' });

// El dominio de la migración: `doctora` | `paciente`, y nada más. Un dominio y no siete
// `CHECK` idénticos porque es el mismo tipo repetido catorce veces entre esta tabla y su
// auditoría, y porque el día que una tercera tabla lo necesite ya está definido.
const historySource = customType<{ data: 'doctora' | 'paciente' }>({
  dataType: () => 'medskin_history_source',
});

const timestampTz = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
const createdAt = () => timestampTz('created_at').notNull().defaultNow();
const updatedAt = () => timestampTz('updated_at').notNull().defaultNow();

// ---------------------------------------------------------------------------------------
// patient · la ficha. Es del INQUILINO, no de la persona (§12.2.1): dos doctoras que
// atienden a la misma paciente tienen dos fichas que no comparten nada.
// ---------------------------------------------------------------------------------------

export const patient = pgTable(
  'patient',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    practiceId: uuid('practice_id')
      .notNull()
      .references(() => practice.id, { onDelete: 'cascade' }),

    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    birthDate: date('birth_date').notNull(),

    // El correo DE LA FICHA: por dónde la doctora le escribe. No es el de la cuenta, con
    // el que ella entra, y cambiar este no cambia aquel (pacientes.md · PATCH, y el
    // `aviso_correo: true` que la app tiene que mostrar).
    email: citext('email').notNull(),
    // Para llamarla y recordarle la cita. No sirve para entrar (cuentas.md).
    phone: text('phone'),
    hasWhatsapp: boolean('has_whatsapp').notNull().default(false),
    remindersVia: text('reminders_via').notNull().default('app'),

    howArrived: text('how_arrived').notNull(),
    // Quién la refirió, de esta misma consulta. `set null` y no `cascade`: que se archive
    // o se borre la que refirió no borra a la referida.
    referredBy: uuid('referred_by').references((): AnyPgColumn => patient.id, {
      onDelete: 'set null',
    }),

    // Archivar no borra nada del expediente: sale de la lista, deja de recibir avisos y no
    // se le puede agendar. Y no toca su cuenta ni su acceso (pacientes.md).
    status: text('status').notNull().default('activa'),
    archivedAt: timestampTz('archived_at'),

    // La búsqueda de `GET /v1/pacientes`: nombre, apellido, correo y celular en una sola
    // cadena, en minúsculas, mantenida por el motor. Columna generada y no expresión en el
    // índice para que la consulta sea legible y para que `backend-senior` tenga un nombre
    // que nombrar: `where search_text % $1`, con el patrón también en minúsculas.
    searchText: text('search_text').generatedAlwaysAs(
      (): SQL => sql`lower(${patient.firstName} || ' ' || ${patient.lastName} || ' ' ||
             coalesce(${patient.email}::text, '') || ' ' || coalesce(${patient.phone}, ''))`,
    ),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Inquilino delante (§7.3, regla 5; §12.2.9). Es la lista por omisión: las activas, las
    // últimas primero, y es también el recuento del `409 limite_del_plan`.
    // `.nullsFirst()` y no el `DESC NULLS LAST` que drizzle pone por omisión, Y NO ES
    // COSMÉTICO: `order by created_at desc` significa NULLS FIRST, así que con un índice
    // NULLS LAST el orden no coincide, el motor NO puede leer las 50 primeras por el
    // índice y acaba ordenando las 8 000 filas del inquilino. Medido con
    // `EXPLAIN (ANALYZE, BUFFERS)`: 2,6 ms y 515 bloques contra 0,1 ms y 7. La columna es
    // `not null`, así que los nulos no existen: lo único que cambia es que el plan encaja.
    index('patient_practice_status_idx').on(t.practiceId, t.status, t.createdAt.desc().nullsFirst()),
    // El duplicado del alta es POR CONSULTA, no global: «que ese correo tenga ficha en otra
    // clínica no es cosa de esta doctora ni se le dice» (cuentas.md, §12.2.1). Por eso NO
    // es único: «Es otra persona» crea la segunda ficha a propósito.
    index('patient_practice_email_idx').on(t.practiceId, t.email),
    check('patient_status_ck', sql`${t.status} in ('activa', 'archivada')`),
    check('patient_reminders_via_ck', sql`${t.remindersVia} in ('app', 'whatsapp', 'ambas')`),
    // Una ficha archivada sin fecha de archivado no se puede contar en ningún sitio, y la
    // respuesta del endpoint devuelve `archivada_en`.
    check('patient_archived_ck', sql`${t.status} <> 'archivada' or ${t.archivedAt} is not null`),
    check('patient_referred_by_ck', sql`${t.referredBy} is null or ${t.referredBy} <> ${t.id}`),
  ],
);

// ---------------------------------------------------------------------------------------
// patient_link · lo que une la ficha del inquilino con la cuenta de la persona (§12.2.2).
// Una fila por ficha. Es la ÚNICA tabla con dos caras de política: por `practice_id` para
// la doctora y por `account_id` para la paciente, porque es la única lectura del sistema
// que cruza inquilinos —y cruza solo las fichas de quien pregunta—.
//
// NO lleva `codigo`. El código de vinculación de seis caracteres está muerto: lo que prueba
// el alta es la contraseña temporal (cuentas.md, `Vinculacion.dc.html`).
// ---------------------------------------------------------------------------------------

export const patientLink = pgTable(
  'patient_link',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    practiceId: uuid('practice_id')
      .notNull()
      .references(() => practice.id, { onDelete: 'cascade' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patient.id, { onDelete: 'cascade' }),
    // Admite nulo y es `set null` a propósito: el expediente es de la consulta y sobrevive
    // al borrado de la cuenta de la persona (cuentas.md · DELETE /v1/cuentas/mia).
    accountId: uuid('account_id').references(() => account.id, { onDelete: 'set null' }),

    // `invitada` es un estado NORMAL, no un error (§12.2.2). `revocada` es «no, gracias»:
    // no borra la ficha y no se le notifica a la doctora (pacientes.md).
    status: text('status').notNull().default('invitada'),

    // El correo del ACCESO: con el que se creó o se reusó la cuenta. Es lo que la doctora
    // puede saber del acceso de su paciente, y es lo de su propia ficha.
    email: citext('email').notNull(),
    accessSentAt: timestampTz('access_sent_at'),

    // Las tres copias de la pregunta 7. `city` admite nulo porque `practice.city` lo admite.
    practiceName: text('practice_name').notNull(),
    practitionerName: text('practitioner_name').notNull(),
    city: text('city'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Una fila por ficha (§12.1: `patient_link 1`). Una sola columna, así que la regla 5 no
    // la alcanza: no hay índice compuesto que pudiera empezar por el inquilino.
    uniqueIndex('patient_link_patient_uq').on(t.patientId),
    // Inquilino delante: es la autorización literal de `POST /v1/cuentas/{cuenta_id}/acceso`
    // —`EXISTS (SELECT 1 FROM patient_link WHERE account_id = $1)` bajo la política de
    // `practice_id`— y la que distingue «no es tuya» de «no existe» sin decir cuál.
    index('patient_link_practice_account_idx').on(t.practiceId, t.accountId),
    // Y uno por cuenta sola, SIN inquilino delante y a propósito: es `GET /v1/vinculos` y
    // los `doctoras[]` de `GET /v1/cuentas/mia`, la única lectura que cruza inquilinos. No
    // hay `practice_id` que poner delante porque quien pregunta no tiene uno.
    index('patient_link_account_idx').on(t.accountId),
    check('patient_link_status_ck', sql`${t.status} in ('invitada', 'vinculada', 'revocada')`),
  ],
);

// ---------------------------------------------------------------------------------------
// medical_history · UNA FILA POR FICHA, no por persona (§12.1). Una paciente de dos
// doctoras llena dos veces, y es correcto: son dos expedientes de dos responsables.
//
// Los dos booleanos admiten nulo y es la decisión más importante de la tabla.
// `app_platform` no tiene ni política ni grant aquí: soporte no lee antecedentes ni
// queriendo (_convenciones.md, `Consola.dc.html`).
// ---------------------------------------------------------------------------------------

export const medicalHistory = pgTable(
  'medical_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    practiceId: uuid('practice_id')
      .notNull()
      .references(() => practice.id, { onDelete: 'cascade' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patient.id, { onDelete: 'cascade' }),

    // `null` = nadie preguntó · `false` = se le preguntó y no tiene.
    hasAllergies: boolean('has_allergies'),
    allergies: text('allergies').array().notNull().default(sql`'{}'::text[]`),
    allergiesSource: historySource('allergies_source'),
    allergiesSourceAt: timestampTz('allergies_source_at'),

    takesMedication: boolean('takes_medication'),
    medication: text('medication').array().notNull().default(sql`'{}'::text[]`),
    medicationSource: historySource('medication_source'),
    medicationSourceAt: timestampTz('medication_source_at'),

    // Existe porque condiciona contraindicaciones, y `no_aplica` es un valor de la lista.
    pregnancyOrLactation: text('pregnancy_or_lactation'),
    pregnancyOrLactationSource: historySource('pregnancy_or_lactation_source'),
    pregnancyOrLactationSourceAt: timestampTz('pregnancy_or_lactation_source_at'),

    // Fitzpatrick, 1-6 y nada más. Sin texto libre: es lo que usan las contraindicaciones.
    phototype: integer('phototype'),
    phototypeSource: historySource('phototype_source'),
    phototypeSourceAt: timestampTz('phototype_source_at'),

    pastConditions: text('past_conditions').array().notNull().default(sql`'{}'::text[]`),
    pastConditionsSource: historySource('past_conditions_source'),
    pastConditionsSourceAt: timestampTz('past_conditions_source_at'),

    previousTreatments: text('previous_treatments').array().notNull().default(sql`'{}'::text[]`),
    previousTreatmentsSource: historySource('previous_treatments_source'),
    previousTreatmentsSourceAt: timestampTz('previous_treatments_source_at'),

    // El cuaderno de la doctora. La paciente no lo escribe, y eso es un grant por columna.
    notes: text('notes'),
    notesSource: historySource('notes_source'),
    notesSourceAt: timestampTz('notes_source_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('medical_history_patient_uq').on(t.patientId),
    // Inquilino delante: la `alerta` ámbar de la lista de pacientes se resuelve por
    // inquilino, sin tocar la ficha de nadie más.
    index('medical_history_practice_idx').on(t.practiceId, t.patientId),
    check(
      'medical_history_pregnancy_ck',
      sql`${t.pregnancyOrLactation} is null or ${t.pregnancyOrLactation} in ('ninguno', 'embarazo', 'lactancia', 'no_sabe', 'no_aplica')`,
    ),
    check(
      'medical_history_phototype_ck',
      sql`${t.phototype} is null or ${t.phototype} between 1 and 6`,
    ),
    // `tiene: true` sin `cuales` es `400 alergias_sin_cuales`, y la base no lo deja entrar
    // ni por otra puerta. Con `false` o `null` la lista tiene que estar vacía: una alergia
    // listada bajo un «no tiene» es un dato que se contradice solo.
    check(
      'medical_history_allergies_ck',
      sql`case when ${t.hasAllergies} then array_length(${t.allergies}, 1) > 0
                else ${t.allergies} = '{}'::text[] end`,
    ),
    check(
      'medical_history_medication_ck',
      sql`case when ${t.takesMedication} then array_length(${t.medication}, 1) > 0
                else ${t.medication} = '{}'::text[] end`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------
// medical_history_audit · «Nada se borra: un campo que cambia deja su valor anterior en la
// auditoría, con quién y cuándo» (pacientes.md). Son antecedentes médicos: el valor de ayer
// puede ser lo que explique una reacción de mañana.
//
// POR QUÉ UNA TABLA PROPIA Y NO `access_audit`: `access_audit` tiene una política de
// `SELECT` para `app_platform` sobre TODAS sus filas, así que un valor clínico anterior
// metido en su `data` lo leería soporte. Y eso es lo único que `_convenciones.md` prohíbe
// sin excepción: «en `patient`, `medical_history`… no hay ninguna política que lo admita».
// Esta tabla no tiene ninguna política de plataforma, igual que la tabla que audita.
//
// Sin claves foráneas, como las otras dos bitácoras (§12.2.8): tiene que sobrevivir al
// borrado de lo que describe. Y sin `UPDATE` ni `DELETE` para nadie: lo que se puede
// reescribir no es una bitácora.
// ---------------------------------------------------------------------------------------

export const medicalHistoryAudit = pgTable(
  'medical_history_audit',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    occurredAt: timestampTz('occurred_at').notNull().defaultNow(),

    practiceId: uuid('practice_id').notNull(),
    patientId: uuid('patient_id').notNull(),

    // El nombre del campo que cambió, de lista cerrada: una bitácora con nombres de campo
    // libres no se puede consultar ni auditar.
    field: text('field').notNull(),
    // El valor ANTERIOR, con la forma que tenga ese campo: un booleano y su lista, un
    // entero, una cadena o una lista. `jsonb` aquí no es un sitio donde cabe cualquier
    // cosa: es el valor de UN campo cuyo tipo depende de `field`, nunca se consulta dentro
    // y nunca se vuelve a escribir. Guardarlo en columnas tipadas serían siete columnas
    // vacías en cada fila para llenar siempre una.
    previousValue: jsonb('previous_value'),
    previousSource: historySource('previous_source'),
    previousSourceAt: timestampTz('previous_source_at'),

    // Quién lo cambió: la cuenta y en calidad de qué. `actor_account_id` sin clave foránea,
    // como el resto de la fila.
    actorAccountId: uuid('actor_account_id'),
    actorSource: historySource('actor_source').notNull(),
  },
  (t) => [
    // Inquilino delante: «qué cambió en esta ficha y cuándo», que es como se lee.
    index('medical_history_audit_practice_idx').on(
      t.practiceId,
      t.patientId,
      t.occurredAt.desc().nullsFirst(),
    ),
    check(
      'medical_history_audit_field_ck',
      sql`${t.field} in ('alergias', 'medicacion', 'embarazo_o_lactancia', 'fototipo',
                         'antecedentes', 'tratamientos_previos', 'notas')`,
    ),
  ],
);
