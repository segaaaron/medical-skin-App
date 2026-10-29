// El cableado del expediente.

import { Module } from '@nestjs/common';
import type { Pool } from 'pg';

import { SystemClock } from '../../shared/clock';
import { POOL } from '../../shared/shared.module';
import { ClinicalSessions, Consents, Lots } from './application/clinical';
import {
  ClinicalSessionsController,
  ConsentsController,
  LotsController,
} from './clinical.controller';
import { ClinicalRepository } from './infrastructure/clinical.repository';
import { ConsentsRepository } from './infrastructure/consents.repository';
import { LotsRepository } from './infrastructure/lots.repository';

@Module({
  controllers: [ClinicalSessionsController, LotsController, ConsentsController],
  providers: [
    {
      provide: ClinicalRepository,
      useFactory: (pool: Pool) => new ClinicalRepository(pool),
      inject: [POOL],
    },
    {
      provide: LotsRepository,
      useFactory: (pool: Pool) => new LotsRepository(pool),
      inject: [POOL],
    },
    {
      provide: ConsentsRepository,
      useFactory: (pool: Pool) => new ConsentsRepository(pool),
      inject: [POOL],
    },
    {
      provide: ClinicalSessions,
      useFactory: (repo: ClinicalRepository, clock: SystemClock) =>
        new ClinicalSessions(repo, clock),
      inject: [ClinicalRepository, SystemClock],
    },
    {
      provide: Lots,
      useFactory: (repo: LotsRepository, clock: SystemClock) => new Lots(repo, clock),
      inject: [LotsRepository, SystemClock],
    },
    {
      provide: Consents,
      useFactory: (repo: ConsentsRepository) => new Consents(repo),
      inject: [ConsentsRepository],
    },
  ],
})
export class ClinicalModule {}
