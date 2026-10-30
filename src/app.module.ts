import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { AccessModule } from './modules/access/access.module';
import { BusinessModule } from './modules/business/business.module';
import { AftercareModule } from './modules/aftercare/aftercare.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PhotosModule } from './modules/photos/photos.module';
import { ClinicalModule } from './modules/clinical/clinical.module';
import { ScheduleModule } from './modules/schedule/schedule.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { PatientsModule } from './modules/patients/patients.module';
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
    NotificationsModule,
    BusinessModule,
    AftercareModule,
    PhotosModule,
    ClinicalModule,
    ScheduleModule,
    CatalogModule,
    PatientsModule,
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
      // `PlatformTokens` sale de `SharedModule` y ya no se construye aquí: desde que
      // `POST /v1/platform/access` lo FIRMA, son dos los que lo necesitan, y dos instancias
      // serían dos lecturas de la misma llave con el riesgo de que no cuadraran.
      useFactory: (tokens: Tokens, platform: PlatformTokens) => new ScopeGuard(tokens, platform),
      inject: [Tokens, PlatformTokens],
    },
    {
      provide: APP_FILTER,
      useFactory: (failures: FailureLog, cfg: Config) => new ErrorFilter(failures, cfg.REGION),
      inject: [FailureLog, CONFIG],
    },
  ],
})
export class AppModule {}
