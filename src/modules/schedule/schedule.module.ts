// El cableado de la agenda. Un solo repositorio para los dos puertos: el contexto y el rol se
// arman igual en todos sus caminos, y partirlo serían dos copias de lo mismo.

import { Module } from '@nestjs/common';
import type { Pool } from 'pg';

import { SystemClock } from '../../shared/clock';
import { IdempotencyGuard } from '../../shared/idempotency/idempotency-guard';
import { POOL } from '../../shared/shared.module';
import { Appointments } from './application/appointments';
import { Schedule } from './application/schedule';
import { SyncBatch } from './application/sync';
import { ScheduleRepository } from './infrastructure/schedule.repository';
import {
  AppointmentsController,
  AvailabilityController,
  SchedulesController,
  SyncController,
  WaitlistController,
} from './schedule.controller';

@Module({
  controllers: [
    SchedulesController,
    AvailabilityController,
    AppointmentsController,
    WaitlistController,
    SyncController,
  ],
  providers: [
    {
      provide: ScheduleRepository,
      useFactory: (pool: Pool) => new ScheduleRepository(pool),
      inject: [POOL],
    },
    {
      provide: Schedule,
      useFactory: (repo: ScheduleRepository, clock: SystemClock) => new Schedule(repo, clock),
      inject: [ScheduleRepository, SystemClock],
    },
    {
      provide: Appointments,
      useFactory: (repo: ScheduleRepository, clock: SystemClock) =>
        new Appointments(repo, repo, clock),
      inject: [ScheduleRepository, SystemClock],
    },
    {
      provide: IdempotencyGuard,
      useFactory: (pool: Pool) => new IdempotencyGuard(pool),
      inject: [POOL],
    },
    {
      provide: SyncBatch,
      useFactory: (appointments: Appointments, guard: IdempotencyGuard) =>
        new SyncBatch(appointments, guard),
      inject: [Appointments, IdempotencyGuard],
    },
  ],
})
export class ScheduleModule {}
