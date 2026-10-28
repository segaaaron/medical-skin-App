// El cableado de las cuentas. Dos endpoints: el cambio de contraseña y el envío del acceso
// de una paciente. Lo que falta de `cuentas.md` —el alta (`POST /v1/pacientes`),
// `POST /v1/equipo`, `GET /v1/cuentas/mia` y el borrado— está dicho en la entrega.

import { Module } from '@nestjs/common';
import type { Pool } from 'pg';

import { SystemClock } from '../../shared/clock';
import { Counters } from '../../shared/security/counters';
import { Argon2Passwords } from '../../shared/security/passwords';
import { POOL } from '../../shared/shared.module';
import { AccountsController } from './accounts.controller';
import { ChangeOwnPassword } from './application/change-password';
import { SendPatientAccess } from './application/send-patient-access';
import { AccountsRepository } from './infrastructure/accounts.repository';
import { PatientAccessRepository } from './infrastructure/patient-access.repository';
import { PasswordAttempts, ResendLimit } from './infrastructure/password-attempts';

@Module({
  controllers: [AccountsController],
  providers: [
    {
      provide: AccountsRepository,
      useFactory: (pool: Pool) => new AccountsRepository(pool),
      inject: [POOL],
    },
    {
      provide: PasswordAttempts,
      useFactory: (counters: Counters) => new PasswordAttempts(counters),
      inject: [Counters],
    },
    {
      provide: ChangeOwnPassword,
      useFactory: (
        repo: AccountsRepository,
        passwords: Argon2Passwords,
        attempts: PasswordAttempts,
        clock: SystemClock,
      ) => new ChangeOwnPassword(repo, passwords, attempts, clock),
      inject: [AccountsRepository, Argon2Passwords, PasswordAttempts, SystemClock],
    },
    {
      provide: PatientAccessRepository,
      useFactory: (pool: Pool) => new PatientAccessRepository(pool),
      inject: [POOL],
    },
    {
      provide: ResendLimit,
      useFactory: (counters: Counters) => new ResendLimit(counters),
      inject: [Counters],
    },
    {
      provide: SendPatientAccess,
      useFactory: (
        repo: PatientAccessRepository,
        passwords: Argon2Passwords,
        limit: ResendLimit,
        clock: SystemClock,
      ) => new SendPatientAccess(repo, passwords, limit, clock),
      inject: [PatientAccessRepository, Argon2Passwords, ResendLimit, SystemClock],
    },
  ],
})
export class AccountsModule {}
