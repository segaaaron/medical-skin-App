// El cableado de los avisos, y las tres programaciones que los mueven.
//
// LOS REMITENTES SE CONSTRUYEN SOLO SI HAY CREDENCIAL. En desarrollo no hay `.p8` de Apple ni
// cuenta de servicio de Google, así que la lista de remitentes queda vacía y la pasada de
// envío no toca ninguna fila: los avisos se ENCOLAN igual —que es lo que las pruebas
// comprueban— y esperan. Inventar un remitente de mentira que «envía» a la nada sería volver a
// tener una respuesta que afirma un aviso que no sale, que es justo el defecto que esto cierra.

import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import { SystemClock } from '../../shared/clock';
import type { Config } from '../../shared/config/config';
import { FailureLog } from '../../shared/failures/service-failure';
import { SmtpMail } from '../../shared/mail/mailer';
import { QUEUE_NAMES, createQueue, createWorker } from '../../shared/queues/queues';
import { CONFIG, POOL, REDIS } from '../../shared/shared.module';
import { Notifications } from './application/notifications';
import type { PushPort } from './domain/ports';
import { ApnsPush } from './infrastructure/apns';
import { FcmPush } from './infrastructure/fcm';
import { NotificationsRepository } from './infrastructure/notifications.repository';

/** Cada minuto la bandeja, cada cinco los recordatorios, cada día la higiene. */
const SEND_EVERY_MS = 60 * 1000;
const SCHEDULE_EVERY_MS = 5 * 60 * 1000;

/**
 * LA DIARIA VA POR RELOJ, no por intervalo. Un `{ every: 24h }` cuenta desde que la
 * programación se escribió, así que la hora a la que corre la higiene la decidía el último
 * despliegue: si el proceso arrancaba a las siete de la tarde, el barrido de tokens y la purga
 * de la bandeja —miles de filas— caían a las siete de la tarde todos los días, en medio de la
 * consulta. Con un patrón corre siempre a la misma hora y reiniciar no la mueve.
 *
 * Y LA ZONA VA ESCRITA, medida y no supuesta: BullMQ resuelve el patrón con la zona DEL PROCESO
 * cuando no se le dice ninguna. Comprobado arrancando la API: con `20 7 * * *` a secas, el
 * próximo disparo quedó en `1793359200000` —las 07:20 de La Paz, 11:20 UTC—, o sea la hora del
 * portátil. En el servidor, que va en UTC, la misma línea habría corrido a otra hora: la purga
 * de la bandeja cambiando de hora según dónde esté desplegada es justo lo que un patrón venía a
 * quitar. Con `tz` puesto son las 07:20 UTC en los dos sitios, que son las 03:20 en Bolivia
 * (UTC−4 todo el año, no cambia la hora): la franja vacía.
 */
const HYGIENE_AT = { pattern: '20 7 * * *', tz: 'UTC' } as const;

const NOTIFICATION_WORKERS = Symbol('NOTIFICATION_WORKERS');

export function pushSendersOf(cfg: Config): readonly PushPort[] {
  const senders: PushPort[] = [];
  if (cfg.APNS_KEY_PATH && cfg.APNS_KEY_ID && cfg.APNS_TEAM_ID && cfg.APNS_TOPIC) {
    senders.push(
      new ApnsPush({
        keyPath: cfg.APNS_KEY_PATH,
        keyId: cfg.APNS_KEY_ID,
        teamId: cfg.APNS_TEAM_ID,
        topic: cfg.APNS_TOPIC,
        host: cfg.APNS_HOST,
      }),
    );
  }
  if (cfg.FCM_CUENTA_SERVICIO_PATH) {
    senders.push(new FcmPush({ serviceAccountPath: cfg.FCM_CUENTA_SERVICIO_PATH }));
  }
  return senders;
}

type Running = { queues: readonly Queue[]; workers: readonly Worker[] };

/**
 * Las tres colas con su trabajo repetible. `upsertJobScheduler` por lo mismo que el barrido de
 * idempotencia: es la forma viva en BullMQ 6 y arrancar dos veces el proceso no deja dos
 * programaciones.
 *
 * `attempts: 1` en los tres: lo que reintenta es la FILA, con su propio retroceso en
 * `send_after`, no el trabajo. Un trabajo que reintenta tres veces en catorce segundos vuelve a
 * leer la misma bandeja y manda lo mismo otra vez.
 */
export function startNotifications(
  redis: Redis,
  notifications: Notifications,
  failures: FailureLog,
): Running {
  const plan = [
    { name: QUEUE_NAMES.notificationsSend, every: SEND_EVERY_MS, run: () => notifications.send() },
    {
      name: QUEUE_NAMES.notificationsSchedule,
      every: SCHEDULE_EVERY_MS,
      run: () => notifications.remind(),
    },
    {
      name: QUEUE_NAMES.notificationsHygiene,
      // Las tres pasadas van INDEPENDIENTES, y eso se decide en `Notifications.hygiene()`:
      // aquí solo vive el cableado.
      at: HYGIENE_AT,
      run: () => notifications.hygiene(),
    },
  ] as const;

  const queues: Queue[] = [];
  const workers: Worker[] = [];

  for (const job of plan) {
    const queue = createQueue(job.name, redis);
    queue
      .upsertJobScheduler(
        job.name,
        'at' in job ? job.at : { every: job.every },
        { name: job.name, opts: { attempts: 1, removeOnFail: 1_000 } },
      )
      .catch((cause: unknown) => record(failures, job.name, cause, 'programacion'));

    const worker = createWorker(job.name, redis, job.run);
    worker.on('failed', (bullJob, cause) => {
      void record(failures, job.name, cause, bullJob?.id);
    });
    queues.push(queue);
    workers.push(worker);
  }

  return { queues, workers };
}

async function record(
  failures: FailureLog,
  operation: string,
  cause: unknown,
  jobId?: string,
): Promise<void> {
  await failures.record({
    service: 'worker',
    operation,
    severity: 'error',
    errorCode: 'fallo_de_servicio',
    cause,
    traceId: jobId ?? 'sin-traza',
    requestId: jobId ?? 'sin-peticion',
    appVersion: null,
    platform: null,
    region: null,
    context: null,
  });
}

@Module({
  providers: [
    {
      provide: NotificationsRepository,
      useFactory: (pool: Pool) => new NotificationsRepository(pool),
      inject: [POOL],
    },
    {
      provide: Notifications,
      useFactory: (repo: NotificationsRepository, cfg: Config, mail: SmtpMail, clock: SystemClock) =>
        new Notifications(repo, pushSendersOf(cfg), mail, clock),
      inject: [NotificationsRepository, CONFIG, SmtpMail, SystemClock],
    },
    {
      provide: NOTIFICATION_WORKERS,
      useFactory: (redis: Redis, notifications: Notifications, failures: FailureLog) =>
        startNotifications(redis, notifications, failures),
      inject: [REDIS, Notifications, FailureLog],
    },
  ],
  exports: [Notifications],
})
export class NotificationsModule implements OnApplicationShutdown {
  constructor(@Inject(NOTIFICATION_WORKERS) private readonly running: Running) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.running.workers.map((worker) => worker.close()));
    await Promise.allSettled(this.running.queues.map((queue) => queue.close()));
  }
}
