// El cableado de las consultas · los CINCO endpoints de `consultas.md`: los dos de la
// doctora —leer su consulta y declarar su matrícula— y los tres de la consola interna —el
// alta, la búsqueda y la ficha—.
//
// ERAN SIETE HASTA HOY: también estaban `POST /v1/platform/tenants/:id/license/decision` y
// `GET /v1/platform/licenses`, que se fueron con la revisión manual de licencias (migración
// 0072). Con ellos se fueron `DecideLicense`, `ListLicenses` y `PlatformLicensesController`.
//
// Dos controladores y no uno, porque son dos puertas distintas: `TenantsController` entra con
// un token de sesión y su alcance, y `PlatformTenantsController` con el token de plataforma,
// que no tiene cuenta ni consulta. Lo único que comparten es el recurso.
//
// Todo por FÁBRICA y con `@Inject` explícito, que es la regla del repo: esbuild no emite
// `emitDecoratorMetadata`, así que la inyección por el tipo del constructor funciona con
// `tsc` y deja las dependencias en `undefined` bajo `tsx` y vitest.

import { Module } from '@nestjs/common';
import type { Pool } from 'pg';

import { SystemClock } from '../../shared/clock';
import type { Config } from '../../shared/config/config';
import { FailureLog } from '../../shared/failures/service-failure';
import { SmtpMail } from '../../shared/mail/mailer';
import { Argon2Passwords } from '../../shared/security/passwords';
import { CONFIG, POOL } from '../../shared/shared.module';
import { CreateTenant } from './application/create-tenant';
import { ReadOwnPractice } from './application/read-own-practice';
import { ReadTenant } from './application/read-tenant';
import { SubmitLicense } from './application/submit-license';
import { AdmissionFailures } from './infrastructure/admission-failures';
import { PlatformRepository } from './infrastructure/platform.repository';
import { TenantsRepository } from './infrastructure/tenants.repository';
import { WelcomeMail } from './infrastructure/welcome-mail';
import { SearchTenants } from './application/console-reads';
import { PlatformTenantsController } from './platform-tenants.controller';
import { TenantsController } from './tenants.controller';

@Module({
  controllers: [TenantsController, PlatformTenantsController],
  providers: [
    {
      provide: TenantsRepository,
      useFactory: (pool: Pool) => new TenantsRepository(pool),
      inject: [POOL],
    },
    {
      provide: ReadOwnPractice,
      useFactory: (repo: TenantsRepository) => new ReadOwnPractice(repo),
      inject: [TenantsRepository],
    },
    {
      provide: SubmitLicense,
      // Solo el repositorio. Llevaba además el reloj y la zona del despliegue para calcular
      // las «24 h hábiles» de `respuesta_estimada_en`: no hay plazo que prometer porque no hay
      // nadie revisando, y la hora de la declaración la pone la base en el mismo `UPDATE`.
      useFactory: (repo: TenantsRepository) => new SubmitLicense(repo),
      inject: [TenantsRepository],
    },

    // -----------------------------------------------------------------------------------
    // La consola interna. Un repositorio aparte y no métodos más en el de la doctora: el
    // rol de base es otro (`app_platform`), lo que puede leer es otro, y lo que cambia por
    // el mismo motivo va junto.
    // -----------------------------------------------------------------------------------
    {
      // La única lectura de lista. `SearchTenants` solo necesita la etiqueta de la región, la
      // misma que la ficha.
      provide: SearchTenants,
      useFactory: (repo: PlatformRepository, cfg: Config) =>
        new SearchTenants(repo, cfg.REGION_ETIQUETA),
      inject: [PlatformRepository, CONFIG],
    },
    {
      provide: PlatformRepository,
      useFactory: (pool: Pool, cfg: Config) => new PlatformRepository(pool, cfg.ZONA_HORARIA),
      inject: [POOL, CONFIG],
    },
    {
      provide: WelcomeMail,
      useFactory: (mail: SmtpMail) => new WelcomeMail(mail),
      inject: [SmtpMail],
    },
    {
      provide: AdmissionFailures,
      useFactory: (failures: FailureLog) => new AdmissionFailures(failures),
      inject: [FailureLog],
    },
    {
      provide: CreateTenant,
      useFactory: (
        repo: PlatformRepository,
        passwords: Argon2Passwords,
        clock: SystemClock,
        mail: WelcomeMail,
        failures: AdmissionFailures,
        cfg: Config,
      ) => new CreateTenant(repo, passwords, clock, mail, failures, cfg.REGION),
      inject: [
        PlatformRepository,
        Argon2Passwords,
        SystemClock,
        WelcomeMail,
        AdmissionFailures,
        CONFIG,
      ],
    },
    {
      provide: ReadTenant,
      // «Bolivia · bo-1» sale de la configuración del despliegue y no de la base: no es dato
      // de consulta —todos los de un despliegue comparten la etiqueta— y guardarla por fila
      // serían N copias del mismo literal (decisión 6).
      useFactory: (repo: PlatformRepository, cfg: Config) =>
        new ReadTenant(repo, cfg.REGION_ETIQUETA),
      inject: [PlatformRepository, CONFIG],
    },
  ],
})
export class TenantsModule {}
