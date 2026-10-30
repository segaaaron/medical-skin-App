// El cableado del negocio.

import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';

import type { Config } from '../../shared/config/config';
import { FailureLog } from '../../shared/failures/service-failure';
import { SmtpMail } from '../../shared/mail/mailer';
import {
  QUEUE_NAMES,
  createQueue,
  createWorker,
  type QueueConnection,
  type AppQueue,
  type AppWorker,
} from '../../shared/queues/queues';
import { CONFIG, POOL, QUEUES } from '../../shared/shared.module';
import type { StorageConfig } from '../../shared/storage/signed-url';
import { ExportWorker } from './infrastructure/export-worker';
import { Business } from './application/business';
import {
  ExportsController,
  InventoryController,
  MarginsController,
  PaymentsController,
  PlanController,
  ReportsController,
} from './business.controller';
import { BusinessRepository } from './infrastructure/business.repository';

const EXPORT_WORKER = Symbol('EXPORT_WORKER');
const EXPORT_STORAGE = Symbol('EXPORT_STORAGE');

/** Cada minuto: una exportación pedida se arma en el minuto siguiente, no en la hora. */
const EXPORT_EVERY_MS = 60 * 1000;

@Module({
  controllers: [
    PaymentsController,
    MarginsController,
    InventoryController,
    ReportsController,
    PlanController,
    ExportsController,
  ],
  providers: [
    {
      provide: BusinessRepository,
      useFactory: (pool: Pool) => new BusinessRepository(pool),
      inject: [POOL],
    },
    {
      provide: EXPORT_STORAGE,
      useFactory: (cfg: Config): StorageConfig => ({
        endpoint: cfg.S3_ENDPOINT,
        region: cfg.S3_REGION,
        bucket: cfg.S3_BUCKET,
        accessKey: cfg.S3_ACCESS_KEY,
        secretKey: cfg.S3_SECRET_KEY,
        forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
      }),
      inject: [CONFIG],
    },
    {
      provide: ExportWorker,
      useFactory: (pool: Pool, storage: StorageConfig, mail: SmtpMail, failures: FailureLog) =>
        new ExportWorker(pool, storage, mail, failures),
      inject: [POOL, EXPORT_STORAGE, SmtpMail, FailureLog],
    },
    {
      provide: EXPORT_WORKER,
      useFactory: (queues: QueueConnection, worker: ExportWorker, failures: FailureLog) => {
        const queue = createQueue(QUEUE_NAMES.dataExport, queues);
        const recordFailure = (cause: unknown, jobId?: string) =>
          failures.record({
            service: 'worker',
            operation: QUEUE_NAMES.dataExport,
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

        // CON SU REGISTRO, y no con un `.catch(() => undefined)`: si la programación falla al
        // arrancar, no se arma NINGUNA exportación nunca y cada paciente recibe «te llega por
        // correo» sin que llegue nada. Era el único de los cuatro sitios equivalentes del
        // proyecto que se lo comía en silencio.
        queue
          .upsertJobScheduler(
            QUEUE_NAMES.dataExport,
            { every: EXPORT_EVERY_MS },
            { name: QUEUE_NAMES.dataExport, opts: { attempts: 1, removeOnFail: 1_000 } },
          )
          .catch((cause: unknown) => recordFailure(cause, 'programacion'));
        const running = createWorker(QUEUE_NAMES.dataExport, queues, async () => ({
          armadas: await worker.run(),
          vencidas: await worker.expire(),
        }));
        running.on('failed', (job, cause) => {
          void recordFailure(cause, job?.id);
        });
        return { queue, worker: running };
      },
      inject: [QUEUES, ExportWorker, FailureLog],
    },
    {
      provide: Business,
      useFactory: (repo: BusinessRepository, cfg: Config) =>
        new Business(repo, cfg.ALMACENAMIENTO_POR_FICHA_MB * 1_000_000),
      inject: [BusinessRepository, CONFIG],
    },
  ],
})
export class BusinessModule implements OnApplicationShutdown {
  constructor(
    @Inject(EXPORT_WORKER) private readonly running: { queue: AppQueue; worker: AppWorker },
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.running.worker.close(), this.running.queue.close()]);
  }
}
