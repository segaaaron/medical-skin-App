// El cableado de la ficha. Todo por fábrica y con `@Inject` explícito, que es la regla del
// repo: esbuild no emite `emitDecoratorMetadata`.

import { Module } from '@nestjs/common';
import type { Pool } from 'pg';

import { SystemClock } from '../../shared/clock';
import { POOL } from '../../shared/shared.module';
import { EditPatient } from './application/edit-patient';
import { PatientLinks } from './application/patient-links';
import { WritePatientHistory } from './application/write-patient-history';
import { ListPatients } from './application/list-patients';
import { ReadPatient } from './application/read-patient';
import { PatientsReadRepository } from './infrastructure/patients-read.repository';
import { PatientsWriteRepository } from './infrastructure/patients-write.repository';
import { PatientHistoryRepository } from './infrastructure/patient-history.repository';
import { PatientLinksRepository } from './infrastructure/patient-links.repository';
import { LinksController } from './links.controller';
import { PatientsController } from './patients.controller';

@Module({
  controllers: [PatientsController, LinksController],
  providers: [
    {
      provide: PatientsReadRepository,
      useFactory: (pool: Pool) => new PatientsReadRepository(pool),
      inject: [POOL],
    },
    {
      provide: ListPatients,
      useFactory: (repo: PatientsReadRepository, clock: SystemClock) =>
        new ListPatients(repo, clock),
      inject: [PatientsReadRepository, SystemClock],
    },
    {
      provide: PatientsWriteRepository,
      useFactory: (pool: Pool) => new PatientsWriteRepository(pool),
      inject: [POOL],
    },
    {
      provide: EditPatient,
      useFactory: (repo: PatientsWriteRepository, clock: SystemClock) =>
        new EditPatient(repo, clock),
      inject: [PatientsWriteRepository, SystemClock],
    },
    {
      provide: PatientLinksRepository,
      useFactory: (pool: Pool) => new PatientLinksRepository(pool),
      inject: [POOL],
    },
    {
      provide: PatientLinks,
      useFactory: (repo: PatientLinksRepository) => new PatientLinks(repo),
      inject: [PatientLinksRepository],
    },
    {
      provide: PatientHistoryRepository,
      useFactory: (pool: Pool) => new PatientHistoryRepository(pool),
      inject: [POOL],
    },
    {
      provide: WritePatientHistory,
      useFactory: (repo: PatientHistoryRepository) => new WritePatientHistory(repo),
      inject: [PatientHistoryRepository],
    },
    {
      provide: ReadPatient,
      useFactory: (repo: PatientsReadRepository, clock: SystemClock) =>
        new ReadPatient(repo, clock),
      inject: [PatientsReadRepository, SystemClock],
    },
  ],
})
export class PatientsModule {}
