// El cableado del negocio.

import { Module } from '@nestjs/common';
import type { Pool } from 'pg';

import { POOL } from '../../shared/shared.module';
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
      provide: Business,
      useFactory: (repo: BusinessRepository) => new Business(repo),
      inject: [BusinessRepository],
    },
  ],
})
export class BusinessModule {}
