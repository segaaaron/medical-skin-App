// El cableado del catálogo. Fábrica y `@Inject` explícito, la regla del repo.

import { Module } from '@nestjs/common';
import type { Pool } from 'pg';

import { SystemClock } from '../../shared/clock';
import { POOL } from '../../shared/shared.module';
import { Catalog } from './application/catalog';
import { ReadCatalog } from './application/read-catalog';
import {
  PatientCatalogController,
  PricesController,
  PromotionsController,
  TreatmentsController,
} from './catalog.controller';
import { CatalogRepository } from './infrastructure/catalog.repository';
import { PatientCatalogRepository } from './infrastructure/patient-catalog.repository';

@Module({
  controllers: [
    TreatmentsController,
    PricesController,
    PromotionsController,
    PatientCatalogController,
  ],
  providers: [
    {
      provide: CatalogRepository,
      useFactory: (pool: Pool) => new CatalogRepository(pool),
      inject: [POOL],
    },
    {
      provide: Catalog,
      useFactory: (repo: CatalogRepository, clock: SystemClock) => new Catalog(repo, clock),
      inject: [CatalogRepository, SystemClock],
    },
    {
      provide: PatientCatalogRepository,
      useFactory: (pool: Pool) => new PatientCatalogRepository(pool),
      inject: [POOL],
    },
    {
      provide: ReadCatalog,
      useFactory: (repo: PatientCatalogRepository, clock: SystemClock) =>
        new ReadCatalog(repo, clock),
      inject: [PatientCatalogRepository, SystemClock],
    },
  ],
})
export class CatalogModule {}
