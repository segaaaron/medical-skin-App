// El cableado de las fotos, y el trabajador que las procesa fuera de la petición.

import { Module } from '@nestjs/common';
import type { Pool } from 'pg';

import { SystemClock } from '../../shared/clock';
import type { Config } from '../../shared/config/config';
import { FailureLog } from '../../shared/failures/service-failure';
import { CONFIG, POOL } from '../../shared/shared.module';
import type { StorageConfig } from '../../shared/storage/signed-url';
import { Photos } from './application/photos';
import { PhotoWorker } from './infrastructure/photo-worker';
import { PhotoWorkerLoop } from './infrastructure/photo-worker-loop';
import { PhotosRepository } from './infrastructure/photos.repository';
import { PhotosController } from './photos.controller';

export const STORAGE = Symbol('STORAGE');

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
      useFactory: (worker: PhotoWorker, failures: FailureLog) =>
        new PhotoWorkerLoop(worker, failures),
      inject: [PhotoWorker, FailureLog],
    },
  ],
})
export class PhotosModule {}
