// Las colas · BullMQ sobre el mismo Redis de los contadores.
//
// Lo que va a una cola es «lo que puede tardar o reintentarse»: aquí, el correo del código
// de recuperación. Lo que NO va es nada que el ciclo de la petición necesite para
// responder, y en este tramo hay una razón añadida: el 202 de `POST /v1/recuperacion` tiene
// que tardar lo mismo exista o no el correo, y acuñar un código no tarda lo mismo.
//
// Este archivo es solo la plumbería: el nombre de la cola y la política de reintentos. El
// trabajo lo hace un caso de uso del módulo (`SendRecoveryCode`), porque un procesador con
// reglas de negocio dentro es una regla que vive fuera de su capa.

import { Queue, Worker, type ConnectionOptions, type JobsOptions, type Processor } from 'bullmq';
import type { Redis } from 'ioredis';

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
} as const;

/**
 * Retroceso exponencial con tope y cola de fallidos que se puede mirar.
 *
 * `removeOnComplete` deja los últimos cien y `removeOnFail` NO borra: un trabajo fallido es
 * justo el que alguien tiene que ver. Y `attempts: 3` con 2 s de base da ~2 s, 4 s y 8 s,
 * que es lo que tarda un relé de correo en volver sin que la paciente deje de esperar.
 */
export const JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: 100,
  removeOnFail: false,
};

/**
 * BullMQ exige `maxRetriesPerRequest: null` en la conexión del `Worker`, porque su bloqueo
 * de lectura dura más que cualquier reintento. La conexión de la aplicación está puesta al
 * contrario a propósito —un contador que espera en vez de fallar no es un contador—, así
 * que la cola usa un duplicado con su propia política y no la de los contadores.
 */
export function queueConnection(redis: Redis): ConnectionOptions {
  return redis.duplicate({ maxRetriesPerRequest: null, enableOfflineQueue: true });
}

export function createQueue(name: string, redis: Redis): Queue {
  return new Queue(name, { connection: queueConnection(redis), defaultJobOptions: JOB_OPTIONS });
}

export function createWorker(name: string, redis: Redis, run: Processor): Worker {
  return new Worker(name, run, { connection: queueConnection(redis) });
}
