// El cableado de la sesión. El caso de uso no conoce NestJS: aquí se le da su puerto y
// nada más. Todo por FÁBRICA, que es la regla del repo: esbuild no emite
// `emitDecoratorMetadata`, así que la inyección por el tipo del constructor funciona con
// `tsc` y deja las dependencias en `undefined` bajo `tsx` y vitest.

import { Module } from '@nestjs/common';
import type { Pool } from 'pg';

import type { Config } from '../../shared/config/config';
import { Counters } from '../../shared/security/counters';
import { Tokens } from '../../shared/security/tokens';
import { CONFIG, POOL } from '../../shared/shared.module';
import { ReadSession } from './application/read-session';
import { RefreshSession } from './application/refresh-session';
import { RefreshLimits } from './infrastructure/refresh-limits';
import { SessionRepository } from './infrastructure/session.repository';
import { SessionController } from './session.controller';

@Module({
  controllers: [SessionController],
  providers: [
    {
      provide: SessionRepository,
      useFactory: (pool: Pool) => new SessionRepository(pool),
      inject: [POOL],
    },
    {
      provide: ReadSession,
      useFactory: (repo: SessionRepository) => new ReadSession(repo),
      inject: [SessionRepository],
    },
    {
      provide: RefreshLimits,
      useFactory: (counters: Counters) => new RefreshLimits(counters),
      inject: [Counters],
    },
    {
      provide: RefreshSession,
      // Sin reloj: todas las fechas de este endpoint las pone la base. `exp` lo pone el
      // firmador y la caducidad del refresco, la función que lo rota.
      useFactory: (
        repo: SessionRepository,
        limits: RefreshLimits,
        tokens: Tokens,
        cfg: Config,
      ) => new RefreshSession(repo, limits, tokens, cfg.REGION),
      inject: [SessionRepository, RefreshLimits, Tokens, CONFIG],
    },
  ],
})
export class SessionModule {}
