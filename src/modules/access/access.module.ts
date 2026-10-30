// El cableado del acceso. Los casos de uso no conocen NestJS: aquí se les dan sus puertos
// y nada más. Es lo que permite probarlos sin levantar nada.

import { Module } from '@nestjs/common';
import type { Pool } from 'pg';

import { SystemClock } from '../../shared/clock';
import { config } from '../../shared/config/config';
import { PlatformTokens } from '../../shared/platform/platform-token';
import { Counters } from '../../shared/security/counters';
import { Argon2Passwords } from '../../shared/security/passwords';
import { Tokens } from '../../shared/security/tokens';
import { POOL } from '../../shared/shared.module';
import { AccessController } from './access.controller';
import { ChoosePassword } from './application/choose-password';
import { CloseOtherSessions, CloseSession, ListSessions, SignOut } from './application/sessions';
import { SignIn } from './application/sign-in';
import { PlatformSignIn } from './application/platform-sign-in';
import { AccessPause } from './infrastructure/access-pause';
import { AccessRepository } from './infrastructure/access.repository';
import { PlatformAccessRepository } from './infrastructure/platform-access.repository';
import { PlatformAccessController } from './platform-access.controller';

@Module({
  controllers: [AccessController, PlatformAccessController],
  providers: [
    {
      provide: AccessRepository,
      useFactory: (pool: Pool) => new AccessRepository(pool),
      inject: [POOL],
    },
    {
      provide: PlatformAccessRepository,
      useFactory: (pool: Pool) => new PlatformAccessRepository(pool),
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
      // La entrada de la consola. Comparte `Argon2Passwords` y `AccessPause` con la de la
      // app a propósito: el señuelo y los contadores son los mismos, que es lo que hace que
      // un correo sin fila responda igual aquí y allá.
      provide: PlatformSignIn,
      useFactory: (
        repo: PlatformAccessRepository,
        passwords: Argon2Passwords,
        pause: AccessPause,
        tokens: PlatformTokens,
        clock: SystemClock,
      ) => new PlatformSignIn(repo, passwords, pause, tokens, clock, config()),
      inject: [PlatformAccessRepository, Argon2Passwords, AccessPause, PlatformTokens, SystemClock],
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
