// El cableado de las fotos, y el trabajador que las procesa fuera de la petición.

import { Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';

import { SystemClock } from '../../shared/clock';
import type { Config } from '../../shared/config/config';
import { FailureLog } from '../../shared/failures/service-failure';
import { CONFIG, POOL } from '../../shared/shared.module';
import type { StorageConfig } from '../../shared/storage/signed-url';
import { Photos } from './application/photos';
import { PhotoWorker } from './infrastructure/photo-worker';
import { PhotosRepository } from './infrastructure/photos.repository';
import { PhotosController } from './photos.controller';

export const STORAGE = Symbol('STORAGE');

/** El trabajador en bucle. No es BullMQ: lo que reclama el trabajo es la fila de la foto. */
class PhotoWorkerLoop implements OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly worker: PhotoWorker) {
    // Cada cinco segundos, y una pasada a la vez: si una tanda tarda, la siguiente espera.
    // `unref()` para que no sostenga el proceso al apagar.
    //
    // Las tres pasadas EN SERIE y en este orden: procesar lo nuevo es lo que una doctora está
    // esperando delante de la pantalla; borrar las derivadas de una ficha archivada y
    // regenerar las de una reactivada pueden esperar cinco segundos más.
    this.timer = setInterval(() => {
      void (async () => {
        await this.worker.run();
        await this.worker.purgeDerivatives();
        await this.worker.rebuildDerivatives();
        await this.worker.eraseDeleted();
      })().catch(() => undefined);
    }, 5_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }
}

@Module({
  controllers: [PhotosController],
  providers: [
    {
      provide: STORAGE,
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
      provide: PhotosRepository,
      useFactory: (pool: Pool, storage: StorageConfig) => new PhotosRepository(pool, storage),
      inject: [POOL, STORAGE],
    },
    {
      provide: Photos,
      useFactory: (repo: PhotosRepository, clock: SystemClock) => new Photos(repo, clock),
      inject: [PhotosRepository, SystemClock],
    },
    {
      provide: PhotoWorker,
      useFactory: (pool: Pool, storage: StorageConfig, failures: FailureLog) =>
        new PhotoWorker(pool, storage, failures),
      inject: [POOL, STORAGE, FailureLog],
    },
    {
      provide: PhotoWorkerLoop,
      useFactory: (worker: PhotoWorker) => new PhotoWorkerLoop(worker),
      inject: [PhotoWorker],
    },
  ],
})
export class PhotosModule {}
