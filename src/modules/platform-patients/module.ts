// El cableado de las pacientes vistas desde la consola · `pacientes-consola.md`, 31 oct 2026.
//
// Todo por FÁBRICA y con `@Inject` explícito, que es la regla del repo: esbuild no emite
// `emitDecoratorMetadata`, así que la inyección por el tipo del constructor funciona con `tsc`
// y deja las dependencias en `undefined` bajo `tsx` y vitest.

import { Module } from '@nestjs/common';
import type { Pool } from 'pg';

import type { Config } from '../../shared/config/config';
import { CONFIG, POOL } from '../../shared/shared.module';
import { PlatformPatientsController } from './controller';
import { PlatformPatientsRepository } from './repository';
import {
  ListTenantPatients,
  ReadConsoleHistory,
  ReadConsolePatient,
  SetConsolePatientStatus,
} from './use-cases';

@Module({
  controllers: [PlatformPatientsController],
  providers: [
    {
      provide: PlatformPatientsRepository,
      // La zona del despliegue: `alta_en` es una fecha de calendario y pasarla por un instante
      // la mueve un día.
      useFactory: (pool: Pool, cfg: Config) => new PlatformPatientsRepository(pool, cfg.ZONA_HORARIA),
      inject: [POOL, CONFIG],
    },
    ...[ListTenantPatients, ReadConsolePatient, ReadConsoleHistory, SetConsolePatientStatus].map(
      (Caso) => ({
        provide: Caso,
        useFactory: (repo: PlatformPatientsRepository) => new Caso(repo),
        inject: [PlatformPatientsRepository],
      }),
    ),
  ],
})
export class PlatformPatientsModule {}
