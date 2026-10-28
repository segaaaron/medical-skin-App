// El cableado de las cuentas. Un solo endpoint por ahora: el resto de `cuentas.md`
// —el alta de pacientes, el reenvío de acceso, `GET /v1/cuentas/mia` y el borrado— depende
// de `patient` y de `patient_link`, que no existen todavía.

import { Module } from '@nestjs/common';
import type { Pool } from 'pg';

import { SystemClock } from '../../shared/clock';
import { Counters } from '../../shared/security/counters';
import { Argon2Passwords } from '../../shared/security/passwords';
import { POOL } from '../../shared/shared.module';
import { AccountsController } from './accounts.controller';
import { ChangeOwnPassword } from './application/change-password';
import { AccountsRepository } from './infrastructure/accounts.repository';
import { PasswordAttempts } from './infrastructure/password-attempts';

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
  ],
})
export class AccountsModule {}
