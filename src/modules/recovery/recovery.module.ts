// El cableado de la recuperación. Los casos de uso no conocen NestJS: aquí se les dan sus
// puertos y nada más.
//
// El trabajador de la cola se levanta con el módulo y se cierra con él, porque vive en
// este proceso en esta entrega. Sacarlo a un proceso propio es llamar a
// `startRecoveryWorker()` desde otro `main`, no reescribir nada.

import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';

import { SystemClock } from '../../shared/clock';
import type { Config } from '../../shared/config/config';
import { FailureLog } from '../../shared/failures/service-failure';
import { SmtpMail } from '../../shared/mail/mailer';
import { Counters } from '../../shared/security/counters';
import { Argon2Passwords } from '../../shared/security/passwords';
import { Tokens } from '../../shared/security/tokens';
import type { AppWorker, QueueConnection } from '../../shared/queues/queues';
import { CONFIG, POOL, QUEUES } from '../../shared/shared.module';
import { RecoveryController } from './recovery.controller';
import { CheckRecoveryCode } from './application/check-code';
import { RequestRecoveryCode } from './application/request-code';
import { SendRecoveryCode } from './application/send-code';
import { RecoveryLimits } from './infrastructure/recovery-limits';
import { RecoveryMail } from './infrastructure/recovery-mail';
import { RecoveryQueue, startRecoveryWorker } from './infrastructure/recovery-queue';
import { RecoveryRepository } from './infrastructure/recovery.repository';

/** El trabajador, como proveedor, para que el módulo lo pueda cerrar al apagarse. */
const RECOVERY_WORKER = Symbol('RECOVERY_WORKER');

@Module({
  controllers: [RecoveryController],
  providers: [
    {
      provide: RecoveryRepository,
      useFactory: (pool: Pool) => new RecoveryRepository(pool),
      inject: [POOL],
    },
    {
      provide: RecoveryLimits,
      useFactory: (counters: Counters) => new RecoveryLimits(counters),
      inject: [Counters],
    },
    {
      provide: RecoveryQueue,
      useFactory: (queues: QueueConnection) => new RecoveryQueue(queues),
      inject: [QUEUES],
    },
    {
      provide: RecoveryMail,
      useFactory: (mail: SmtpMail, clock: SystemClock) => new RecoveryMail(mail, clock),
      inject: [SmtpMail, SystemClock],
    },
    {
      provide: RequestRecoveryCode,
      useFactory: (limits: RecoveryLimits, queue: RecoveryQueue, clock: SystemClock) =>
        new RequestRecoveryCode(limits, queue, clock),
      inject: [RecoveryLimits, RecoveryQueue, SystemClock],
    },
    {
      provide: CheckRecoveryCode,
      useFactory: (
        repo: RecoveryRepository,
        limits: RecoveryLimits,
        // Argon2id para el código, igual que para una contraseña: «un volcado de la base
        // no da códigos vivos». Y la comparación, en tiempo constante.
        passwords: Argon2Passwords,
        tokens: Tokens,
        cfg: Config,
      ) => new CheckRecoveryCode(repo, limits, passwords, tokens, cfg.REGION),
      inject: [RecoveryRepository, RecoveryLimits, Argon2Passwords, Tokens, CONFIG],
    },
    {
      provide: SendRecoveryCode,
      useFactory: (
        repo: RecoveryRepository,
        passwords: Argon2Passwords,
        mail: RecoveryMail,
      ) => new SendRecoveryCode(repo, passwords, mail),
      inject: [RecoveryRepository, Argon2Passwords, RecoveryMail],
    },
    {
      provide: RECOVERY_WORKER,
      useFactory: (queues: QueueConnection, send: SendRecoveryCode, failures: FailureLog) =>
        startRecoveryWorker(queues, send, failures),
      inject: [QUEUES, SendRecoveryCode, FailureLog],
    },
  ],
})
export class RecoveryModule implements OnApplicationShutdown {
  constructor(
    @Inject(RECOVERY_WORKER) private readonly worker: AppWorker,
    @Inject(RecoveryQueue) private readonly queue: RecoveryQueue,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.worker.close(), this.queue.close()]);
  }
}
