// El cableado de los cuidados.

import { Module } from '@nestjs/common';
import type { Pool } from 'pg';

import { SystemClock } from '../../shared/clock';
import { POOL } from '../../shared/shared.module';
import {
  AftercareController,
  AlertPreferencesController,
  DevicesController,
  IncidentsController,
  MessagesController,
  TrafficLightController,
} from './aftercare.controller';
import { Aftercare } from './application/aftercare';
import { AftercareRepository } from './infrastructure/aftercare.repository';

@Module({
  controllers: [
    AftercareController,
    TrafficLightController,
    IncidentsController,
    MessagesController,
    DevicesController,
    AlertPreferencesController,
  ],
  providers: [
    {
      provide: AftercareRepository,
      useFactory: (pool: Pool) => new AftercareRepository(pool),
      inject: [POOL],
    },
    {
      provide: Aftercare,
      useFactory: (repo: AftercareRepository, clock: SystemClock) => new Aftercare(repo, clock),
      inject: [AftercareRepository, SystemClock],
    },
  ],
})
export class AftercareModule {}
