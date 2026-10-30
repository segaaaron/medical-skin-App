// El adaptador de BullMQ para la cola del correo de recuperación, y el trabajador que la
// consume. La plumbería está en `shared/queues`; el trabajo, en `SendRecoveryCode`.
//
// LO QUE SE ENCOLA ES EL CORREO Y LA HORA DE CADUCIDAD, Y NADA MÁS. El código en claro no
// viaja en el trabajo porque cuando el trabajo se encola el código todavía no existe
// (`recuperacion.md`): «la cola recibe a quién escribirle, no qué escribirle».


import { FailureLog } from '../../../shared/failures/service-failure';
import {
  QUEUE_NAMES,
  createQueue,
  createWorker,
  type QueueConnection,
  type AppQueue,
  type AppWorker,
} from '../../../shared/queues/queues';
import type { SendRecoveryCode } from '../application/send-code';
import type { RecoveryMailJob, RecoveryQueuePort } from '../domain/ports';

/** Lo que viaja en Redis. `expiresAt` en ISO porque un `Date` no sobrevive al JSON. */
type JobData = { email: string; expiresAt: string };

export class RecoveryQueue implements RecoveryQueuePort {
  private readonly queue: AppQueue;

  constructor(queues: QueueConnection) {
    this.queue = createQueue(QUEUE_NAMES.recoveryMail, queues);
  }

  async enqueue(job: RecoveryMailJob): Promise<void> {
    const data: JobData = { email: job.email, expiresAt: job.expiresAt.toISOString() };
    // Sin `jobId` fijo, y es la decisión que el contrato pide: «el botón "Enviarme otro
    // código" tiene que acuñar otro», así que dos peticiones son dos trabajos. La
    // idempotencia que importa la da acuñar, que anula el código anterior: por más veces
    // que se corra, lo que queda vivo es un solo código, el último.
    await this.queue.add(QUEUE_NAMES.recoveryMail, data);
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/**
 * El trabajador. Vive en el mismo proceso que la API en esta entrega: con un correo por
 * recuperación no hay volumen que justifique un despliegue más, y mover esto a su propio
 * proceso es cambiar quién llama a `startRecoveryWorker()`, no reescribir nada.
 *
 * Un fallo del trabajo va a `service_failure` con su causa real y al reintento de BullMQ.
 * NUNCA se registra el código: el único sitio donde el código en claro existe es la
 * variable del caso de uso y el cuerpo del correo.
 */
export function startRecoveryWorker(
  queues: QueueConnection,
  send: SendRecoveryCode,
  failures: FailureLog,
): AppWorker {
  const worker = createWorker(QUEUE_NAMES.recoveryMail, queues, async (job) => {
    const data = job.data as JobData;
    await send.run({ email: data.email, expiresAt: new Date(data.expiresAt) });
  });

  worker.on('failed', (job, cause) => {
    void failures.record({
      service: 'worker',
      operation: QUEUE_NAMES.recoveryMail,
      // Mientras queden reintentos es un aviso; agotados, es que ese correo no se mandó.
      severity: (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1) ? 'error' : 'warning',
      errorCode: 'fallo_de_servicio',
      cause,
      traceId: job?.id ?? 'sin-traza',
      requestId: job?.id ?? 'sin-peticion',
      appVersion: null,
      platform: null,
      region: null,
      context: null,
    });
  });

  return worker;
}
