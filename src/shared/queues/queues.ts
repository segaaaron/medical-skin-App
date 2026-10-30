// Las colas · BullMQ sobre POSTGRES, no sobre Redis.
//
// BullMQ 6 trae un backend de PostgreSQL con la MISMA API de `Queue` y `Worker`: reclama los
// trabajos con `FOR UPDATE SKIP LOCKED` y espera con `LISTEN/NOTIFY`, así que no sondea. Se
// cambió porque Redis se había quedado sin trabajo propio: el estado de la cola —la carga del
// aviso, el arrendamiento, el retroceso— ya vivía en `notification_outbox` y sus funciones, y
// lo único que quedaba en Redis era el reloj. Una dependencia entera, con su servicio, su
// memoria y su modo de fallo, para disparar un tic.
//
// Y hay una razón de fondo que pesa más que el ahorro: un trabajo encolado y el hecho que lo
// origina ahora pueden confirmarse en la MISMA base. Con Redis, «se guardó la cita» y «se
// encoló su recordatorio» eran dos sistemas que podían discrepar.
//
// Lo que va a una cola es «lo que puede tardar o reintentarse»: aquí, el correo del código
// de recuperación. Lo que NO va es nada que el ciclo de la petición necesite para
// responder, y en este tramo hay una razón añadida: el 202 de `POST /v1/recovery` tiene
// que tardar lo mismo exista o no el correo, y acuñar un código no tarda lo mismo.
//
// Este archivo es solo la plumbería: el nombre de la cola y la política de reintentos. El
// trabajo lo hace un caso de uso del módulo (`SendRecoveryCode`), porque un procesador con
// reglas de negocio dentro es una regla que vive fuera de su capa.

import { createPostgresBackend, withBackend, type JobsOptions, type Processor } from 'bullmq';

/**
 * Los constructores LIGADOS al backend de Postgres. `withBackend` existe para esto: sin él,
 * `Queue` y `Worker` a secas llevan los tipos del backend de Redis y TypeScript rechaza la
 * conexión —el error es real, no cosmético: delata que estarías mezclando los dos—.
 */
const { Queue, Worker } = withBackend(createPostgresBackend);

// Con guion y no con dos puntos: BullMQ rechaza el `:` en el nombre de una cola, porque lo
// usa él para componer sus propias claves de Redis («Queue name cannot contain :»). Las
// claves de los CONTADORES sí llevan `:`, que es la forma que fija `_convenciones.md`, y
// son otras claves.
export const QUEUE_NAMES = {
  /** El correo del código de recuperación. Lleva a quién escribirle, no qué escribirle. */
  recoveryMail: 'recuperacion-correo',
  /**
   * El barrido de `idempotency_key`, cada hora. No lleva datos: la función de la base sabe
   * qué borrar («lo caducado») y el trabajo solo decide cuándo y cuántas veces.
   */
  idempotencySweep: 'idempotencia-barrido',
  /**
   * LOS TRES DE LOS AVISOS (0045 · hallazgo H-01). Lo que va en el trabajo es «mira la bandeja»
   * y nada más: ni a quién avisar, ni de qué. La carga de un aviso vive en
   * `notification_outbox`, que es una tabla con RLS forzada, y no en Redis —que no tiene
   * políticas, no tiene consultas y guarda sus claves en disco sin cifrar—. Es la misma razón
   * por la que el código de recuperación no viaja en su trabajo.
   */
  notificationsSend: 'avisos-enviar',
  notificationsSchedule: 'avisos-programar',
  notificationsHygiene: 'avisos-higiene',
  /** «Armar la exportación · al pedirla» (`negocio.md`). Lo que viaja es «mira la tabla». */
  dataExport: 'exportacion-datos',
  /** «Purga por retención legal · diario» (`negocio.md`). El plazo que el borrado prometió. */
  retentionSweep: 'retencion-barrido',
} as const;

/**
 * Retroceso exponencial con tope, y las DOS colas acotadas.
 *
 * `removeOnComplete: 100` deja los últimos cien. Y `removeOnFail: 2_000` —no `false`, que era
 * «no borres nunca»— por una razón medida: Redis es de 100 MB en esta VPS (`servicios.md`
 * §6.3: «una cola que nunca se limpia es una fuga de disco lenta»), el trabajador de fotos
 * reintenta hasta su tope sobre el mismo Redis, y una cola de fallidos sin cota crece hasta
 * que el `maxmemory` empieza a rechazar escrituras. Cuando eso pasa, lo que deja de funcionar
 * son los CONTADORES —el límite de intentos de acceso—, que viven en el mismo Redis.
 *
 * Dos mil trabajos fallidos son muchísimos más de los que alguien va a mirar, y son los dos
 * mil MÁS RECIENTES: lo que se pierde al rebasar es el fallo más viejo, que ya está en
 * `service_failure` con su causa —esa tabla es la que de verdad guarda el diagnóstico, y tiene
 * su propia retención—.
 *
 * Y `attempts: 3` con 2 s de base da ~2 s, 4 s y 8 s, que es lo que tarda un relé de correo en
 * volver sin que la paciente deje de esperar.
 */
export const JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: 100,
  removeOnFail: 2_000,
};

/**
 * BullMQ exige `maxRetriesPerRequest: null` en la conexión del `Worker`, porque su bloqueo
 * de lectura dura más que cualquier reintento. La conexión de la aplicación está puesta al
 * contrario a propósito —un contador que espera en vez de fallar no es un contador—, así
 * que la cola usa un duplicado con su propia política y no la de los contadores.
 */
export type QueueConnection = { connectionString: string; schema: string };

/** Las tablas de BullMQ viven en su propio esquema, fuera de las 54 del dominio. */
export const QUEUE_SCHEMA = 'bullmq';

/**
 * `{ connectionString, schema }` y NO un `pg.Pool` nuestro, a propósito: con un pool ya
 * construido BullMQ **no puede fijar el `search_path`** y sus consultas sin cualificar no
 * encuentran sus tablas. Dándole la cadena, lo construye él y el `schema` surte efecto.
 *
 * Y que sea un pool aparte es además lo que se quiere: el nuestro va con `SET ROLE` por petición
 * (`withTenantContext`), y las colas no tienen consulta.
 */
export function queueConnection(databaseUrl: string): QueueConnection {
  return { connectionString: databaseUrl, schema: QUEUE_SCHEMA };
}

export function createQueue(name: string, connection: QueueConnection) {
  return new Queue(name, { connection, defaultJobOptions: JOB_OPTIONS });
}

export function createWorker(name: string, connection: QueueConnection, run: Processor) {
  return new Worker(name, run, { connection });
}

/** Lo que devuelven los dos de arriba, para quien tenga que guardarlos en una lista. */
export type AppQueue = ReturnType<typeof createQueue>;
export type AppWorker = ReturnType<typeof createWorker>;
