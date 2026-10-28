import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { AccessModule } from './modules/access/access.module';
import { AccountsModule } from './modules/accounts/accounts.module';
import { RecoveryModule } from './modules/recovery/recovery.module';
import { SessionModule } from './modules/session/session.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import type { Config } from './shared/config/config';
import { FailureLog } from './shared/failures/service-failure';
import { ErrorFilter } from './shared/http/error.filter';
import { ScopeGuard } from './shared/http/scope.guard';
import { PlatformTokens } from './shared/platform/platform-token';
import { Tokens } from './shared/security/tokens';
import { CONFIG, SharedModule } from './shared/shared.module';

// El guardia de alcance es GLOBAL y por lista blanca de rutas: una ruta nueva nace cerrada.
// El filtro es global también: una sola forma de error en toda la API.
//
// Los dos se cablean por FÁBRICA y no por tipo del constructor, y no es un gusto: esbuild
// —el que usan `tsx` y vitest— no emite `emitDecoratorMetadata`, así que la inyección por
// tipo funciona con `tsc` y no en desarrollo. Un filtro construido con sus dependencias en
// `undefined` convierte el primer 500 en un cuelgue del proceso. Con fábricas no hay
// metadatos de los que depender y las dos rutas de ejecución se comportan igual.
@Module({
  imports: [
    SharedModule,
    AccessModule,
    RecoveryModule,
    AccountsModule,
    SessionModule,
    TenantsModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      // `PlatformTokens` se construye aquí y no en `SharedModule` porque no lo usa nadie
      // más: la consola solo necesita lo que el guardia deja en la petición, no el
      // verificador. La fábrica es `async` porque leer e importar la llave pública lo es.
      useFactory: async (tokens: Tokens, cfg: Config) =>
        new ScopeGuard(tokens, await PlatformTokens.fromFiles(cfg)),
      inject: [Tokens, CONFIG],
    },
    {
      provide: APP_FILTER,
      useFactory: (failures: FailureLog, cfg: Config) => new ErrorFilter(failures, cfg.REGION),
      inject: [FailureLog, CONFIG],
    },
  ],
})
export class AppModule {}
