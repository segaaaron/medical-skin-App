// El cableado de las cuentas. Nueve endpoints —con las dos de consola, el tramo 1 queda
// cerrado—: el alta de una paciente
// (`POST /v1/pacientes`), el cambio de contraseña, el envío del acceso de una paciente,
// `GET /v1/cuentas/mia`, su borrado, el alta del equipo y el reenvío del acceso del equipo.
// y las dos acciones de `Consola.dc.html` · 2 (reenviar el acceso y levantar la pausa).

import { Module } from '@nestjs/common';
import type { Pool } from 'pg';

import { SystemClock } from '../../shared/clock';
import type { Config } from '../../shared/config/config';
import { SmtpMail } from '../../shared/mail/mailer';
import { Counters } from '../../shared/security/counters';
import { Argon2Passwords } from '../../shared/security/passwords';
import { CONFIG, POOL } from '../../shared/shared.module';
import { AccessRepository } from '../access/infrastructure/access.repository';
import { AccountsController } from './accounts.controller';
import { ChangeOwnPassword } from './application/change-password';
import { CreateTeamMember } from './application/create-team-member';
import { DeleteOwnAccount } from './application/delete-own-account';
import { ReadOwnAccount } from './application/read-own-account';
import { ResendTeamAccess } from './application/resend-team-access';
import { LiftAccessPause } from './application/lift-access-pause';
import { RegisterPatient } from './application/register-patient';
import { ResendPlatformAccess } from './application/resend-platform-access';
import { SendPatientAccess } from './application/send-patient-access';
import { AccountsRepository } from './infrastructure/accounts.repository';
import { ConsoleRepository } from './infrastructure/console.repository';
import { PatientsRepository } from './infrastructure/patients.repository';
import { PlatformAccessMail } from './infrastructure/platform-access-mail';
import { PatientAccessMail } from './infrastructure/patient-access-mail';
import { PatientAccessRepository } from './infrastructure/patient-access.repository';
import { PatientCreationLimit, PasswordAttempts, ResendLimit } from './infrastructure/password-attempts';
import { TeamAccessMail } from './infrastructure/team-access-mail';
import { TeamRepository } from './infrastructure/team.repository';
import { PatientsController } from './patients.controller';
import { PlatformAccountsController } from './platform-accounts.controller';
import { TeamController } from './team.controller';

/**
 * `GET /v1/cuentas/mia` necesita el `practitioner.role` de esta consulta y el estado que
 * decide `siguiente_paso` —licencia y lista del primer día—, que es EXACTAMENTE lo que lee
 * `AccessRepository.nextStepFacts()` en una sola consulta para `POST /v1/acceso`. Se reusa
 * ese puerto en vez de escribir una segunda consulta que diga lo mismo: si fueran dos, un
 * día la regla cambiaría en una sola y la pantalla de arranque diría otra cosa que la
 * entrada. No se importa `AccessModule`: lo que hace falta es la clase, que solo depende del
 * pool, y así ningún módulo exporta lo que el otro no le pidió.
 */
const PRACTITIONER_FACTS = Symbol('PRACTITIONER_FACTS');

@Module({
  controllers: [
    AccountsController,
    PatientsController,
    PlatformAccountsController,
    TeamController,
  ],
  providers: [
    {
      provide: AccountsRepository,
      useFactory: (pool: Pool, cfg: Config) => new AccountsRepository(pool, cfg.ZONA_HORARIA),
      inject: [POOL, CONFIG],
    },
    {
      provide: PRACTITIONER_FACTS,
      useFactory: (pool: Pool) => new AccessRepository(pool),
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
      provide: PatientAccessMail,
      useFactory: (mail: SmtpMail) => new PatientAccessMail(mail),
      inject: [SmtpMail],
    },
    {
      provide: SendPatientAccess,
      useFactory: (
        repo: PatientAccessRepository,
        passwords: Argon2Passwords,
        limit: ResendLimit,
        clock: SystemClock,
        // Sin esto, `via: "correo"` acuña una temporal nueva, mata la que la paciente
        // tenía y no manda nada: la asimetría con `recovery.module.ts` ERA el defecto.
        mail: PatientAccessMail,
      ) => new SendPatientAccess(repo, passwords, limit, clock, mail),
      inject: [
        PatientAccessRepository,
        Argon2Passwords,
        ResendLimit,
        SystemClock,
        PatientAccessMail,
      ],
    },
    {
      provide: PatientsRepository,
      useFactory: (pool: Pool) => new PatientsRepository(pool),
      inject: [POOL],
    },
    {
      provide: PatientCreationLimit,
      useFactory: (counters: Counters) => new PatientCreationLimit(counters),
      inject: [Counters],
    },
    {
      provide: RegisterPatient,
      useFactory: (
        repo: PatientsRepository,
        passwords: Argon2Passwords,
        limit: PatientCreationLimit,
        // El cierre de la clave de idempotencia: lo implementa el MISMO repositorio, que es
        // quien tiene el contexto de inquilino, y es un puerto aparte porque cerrar una
        // clave no es parte del alta (la I de SOLID).
        idempotency: PatientsRepository,
        clock: SystemClock,
        // El MISMO correo del acceso que usa el reenvío: una plantilla, un mecanismo. Si
        // aquí se escribiera un segundo envío, la frase del acceso tendría dos versiones.
        mail: PatientAccessMail,
      ) => new RegisterPatient(repo, passwords, limit, idempotency, clock, mail),
      inject: [
        PatientsRepository,
        Argon2Passwords,
        PatientCreationLimit,
        PatientsRepository,
        SystemClock,
        PatientAccessMail,
      ],
    },
    {
      provide: ConsoleRepository,
      useFactory: (pool: Pool) => new ConsoleRepository(pool),
      inject: [POOL],
    },
    {
      provide: PlatformAccessMail,
      useFactory: (mail: SmtpMail) => new PlatformAccessMail(mail),
      inject: [SmtpMail],
    },
    {
      provide: ResendPlatformAccess,
      useFactory: (
        repo: ConsoleRepository,
        passwords: Argon2Passwords,
        clock: SystemClock,
        // Sin esto la consola acuñaría una temporal que nadie manda, y como la respuesta NO
        // la lleva —«soporte no la ve»—, nadie podría entregarla: la cuenta quedaría fuera.
        mail: PlatformAccessMail,
      ) => new ResendPlatformAccess(repo, passwords, clock, mail),
      inject: [ConsoleRepository, Argon2Passwords, SystemClock, PlatformAccessMail],
    },
    {
      provide: LiftAccessPause,
      useFactory: (repo: ConsoleRepository) => new LiftAccessPause(repo),
      inject: [ConsoleRepository],
    },
    {
      provide: ReadOwnAccount,
      useFactory: (repo: AccountsRepository, facts: AccessRepository) =>
        new ReadOwnAccount(repo, facts),
      inject: [AccountsRepository, PRACTITIONER_FACTS],
    },
    {
      provide: DeleteOwnAccount,
      useFactory: (
        repo: AccountsRepository,
        passwords: Argon2Passwords,
        clock: SystemClock,
        cfg: Config,
      ) => new DeleteOwnAccount(repo, passwords, repo, clock, cfg.CONSERVACION_ANOS),
      inject: [AccountsRepository, Argon2Passwords, SystemClock, CONFIG],
    },
    {
      provide: TeamRepository,
      useFactory: (pool: Pool) => new TeamRepository(pool),
      inject: [POOL],
    },
    {
      provide: TeamAccessMail,
      useFactory: (mail: SmtpMail) => new TeamAccessMail(mail),
      inject: [SmtpMail],
    },
    {
      provide: CreateTeamMember,
      useFactory: (
        repo: TeamRepository,
        passwords: Argon2Passwords,
        clock: SystemClock,
        mail: TeamAccessMail,
        idempotency: PatientsRepository,
      ) => new CreateTeamMember(repo, passwords, clock, mail, idempotency),
      inject: [TeamRepository, Argon2Passwords, SystemClock, TeamAccessMail, PatientsRepository],
    },
    {
      provide: ResendTeamAccess,
      useFactory: (
        repo: TeamRepository,
        passwords: Argon2Passwords,
        // `ResendLimit` es el MISMO contador del reenvío de pacientes, con la misma clave
        // por cuenta de destino: las 3 por hora cuentan igual venga de donde venga.
        limit: ResendLimit,
        clock: SystemClock,
        mail: TeamAccessMail,
      ) => new ResendTeamAccess(repo, passwords, limit, clock, mail),
      inject: [TeamRepository, Argon2Passwords, ResendLimit, SystemClock, TeamAccessMail],
    },
  ],
})
export class AccountsModule {}
