// La salud del servicio y la vigilancia de lo que falla en silencio.

import { Module } from '@nestjs/common';
import type { Pool } from 'pg';

import type { Config } from '../../shared/config/config';
import { FailureLog } from '../../shared/failures/service-failure';
import { OpsWatch } from '../../shared/ops/ops-watch';
import { CONFIG, POOL } from '../../shared/shared.module';
import { pushSendersOf } from '../notifications/notifications.module';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: OpsWatch,
      useFactory: (pool: Pool, failures: FailureLog, cfg: Config) => {
        const watch = new OpsWatch(pool, failures, {
          pushChannels: pushSendersOf(cfg).length,
          storageAlertBytes: cfg.STORAGE_ALERT_BYTES ?? null,
          production: cfg.NODE_ENV === 'production',
        });
        watch.start();
        return watch;
      },
      inject: [POOL, FailureLog, CONFIG],
    },
  ],
})
export class OpsModule {}
