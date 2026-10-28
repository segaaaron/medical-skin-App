// El cableado del acceso. Los casos de uso no conocen NestJS: aquí se les dan sus puertos
// y nada más. Es lo que permite probarlos sin levantar nada.

import { Module } from '@nestjs/common';
import type { Pool } from 'pg';

import { SystemClock } from '../../shared/clock';
import { Counters } from '../../shared/security/counters';
import { Argon2Passwords } from '../../shared/security/passwords';
import { Tokens } from '../../shared/security/tokens';
import { POOL } from '../../shared/shared.module';
import { AccessController } from './access.controller';
import { ChoosePassword } from './application/choose-password';
import { CloseOtherSessions, CloseSession, ListSessions, SignOut } from './application/sessions';
import { SignIn } from './application/sign-in';
import { AccessPause } from './infrastructure/access-pause';
import { AccessRepository } from './infrastructure/access.repository';

@Module({
  controllers: [AccessController],
  providers: [
    {
      provide: AccessRepository,
      useFactory: (pool: Pool) => new AccessRepository(pool),
      inject: [POOL],
    },
    {
      provide: AccessPause,
      useFactory: (counters: Counters) => new AccessPause(counters),
      inject: [Counters],
    },
    {
      provide: SignIn,
      useFactory: (
        repo: AccessRepository,
        passwords: Argon2Passwords,
        pause: AccessPause,
        tokens: Tokens,
        clock: SystemClock,
      ) => new SignIn(repo, passwords, pause, repo, tokens, clock),
      inject: [AccessRepository, Argon2Passwords, AccessPause, Tokens, SystemClock],
    },
    {
      provide: ChoosePassword,
      useFactory: (
        repo: AccessRepository,
        passwords: Argon2Passwords,
        tokens: Tokens,
        clock: SystemClock,
      ) => new ChoosePassword(repo, passwords, repo, tokens, clock),
      inject: [AccessRepository, Argon2Passwords, Tokens, SystemClock],
    },
    {
      provide: SignOut,
      useFactory: (repo: AccessRepository, clock: SystemClock) => new SignOut(repo, clock),
      inject: [AccessRepository, SystemClock],
    },
    {
      provide: ListSessions,
      useFactory: (repo: AccessRepository) => new ListSessions(repo),
      inject: [AccessRepository],
    },
    {
      provide: CloseSession,
      useFactory: (repo: AccessRepository) => new CloseSession(repo),
      inject: [AccessRepository],
    },
    {
      provide: CloseOtherSessions,
      useFactory: (repo: AccessRepository) => new CloseOtherSessions(repo),
      inject: [AccessRepository],
    },
  ],
})
export class AccessModule {}
