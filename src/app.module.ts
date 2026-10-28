import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { AccessModule } from './modules/access/access.module';
import { AccountsModule } from './modules/accounts/accounts.module';
import { RecoveryModule } from './modules/recovery/recovery.module';
import { FailureLog } from './shared/failures/service-failure';
import { ErrorFilter } from './shared/http/error.filter';
import { ScopeGuard } from './shared/http/scope.guard';
import { Tokens } from './shared/security/tokens';
import { SharedModule } from './shared/shared.module';

// El guardia de alcance es GLOBAL y por lista blanca de rutas: una ruta nueva nace cerrada.
// El filtro es global también: una sola forma de error en toda la API.
//
// Los dos se cablean por FÁBRICA y no por tipo del constructor, y no es un gusto: esbuild
// —el que usan `tsx` y vitest— no emite `emitDecoratorMetadata`, así que la inyección por
// tipo funciona con `tsc` y no en desarrollo. Un filtro construido con sus dependencias en
// `undefined` convierte el primer 500 en un cuelgue del proceso. Con fábricas no hay
// metadatos de los que depender y las dos rutas de ejecución se comportan igual.
@Module({
  imports: [SharedModule, AccessModule, RecoveryModule, AccountsModule],
  providers: [
    { provide: APP_GUARD, useFactory: (tokens: Tokens) => new ScopeGuard(tokens), inject: [Tokens] },
    {
      provide: APP_FILTER,
      useFactory: (failures: FailureLog) => new ErrorFilter(failures),
      inject: [FailureLog],
    },
  ],
})
export class AppModule {}
