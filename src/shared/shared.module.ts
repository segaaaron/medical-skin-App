// Lo transversal, en un módulo: la configuración validada, el pool, Redis, las llaves del
// token, el reloj, Argon2id, los contadores, la idempotencia, el correo y el registro de
// fallos. Lo usan los 23 endpoints del tramo, así que se construye una vez.

import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';

import { SystemClock } from './clock';
import { config, type Config } from './config/config';
import { FailureLog } from './failures/service-failure';
import {
  IdempotencySweep,
  RetentionSweep,
  startIdempotencySweep,
  startRetentionSweep,
} from './idempotency/idempotency-sweep';
import { SmtpMail } from './mail/mailer';
import { PlatformTokens } from './platform/platform-token';
import {
  queueConnection,
  type AppQueue,
  type AppWorker,
  type QueueConnection,
} from './queues/queues';
import { Counters } from './security/counters';
import { Argon2Passwords } from './security/passwords';
import { Tokens } from './security/tokens';

export const CONFIG = Symbol('CONFIG');
export const POOL = Symbol('POOL');
/** La conexión de las colas: Postgres, no Redis. Su propio pool y su propio esquema. */
export const QUEUES = Symbol('QUEUES');

/**
 * EL BARRIDO DE `idempotency_key`, cada hora. Vive aquí y no en un módulo de recurso porque
 * la tabla no es de ninguno: la usan los cinco `POST` que crean algo. Se arranca al construir
 * el módulo y se cierra en el apagado, igual que el trabajador de recuperación.
 */
const IDEMPOTENCY_SWEEP = Symbol('IDEMPOTENCY_SWEEP');

/**
 * Y EL BARRIDO DEL PLAZO DE CONSERVACIÓN, diario. Vive aquí por lo mismo: la promesa es de la
 * cuenta —«se conserva hasta 2036»— y lo que cumple el plazo no es de ningún módulo de
 * recurso. Es el trabajo más delicado del sistema y por eso tiene sus dos cotas dentro.
 */
const RETENTION_SWEEP = Symbol('RETENTION_SWEEP');

@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: (): Config => config() },
    {
      provide: POOL,
      // La API va por el pooler en modo transacción, como en producción.
      // `withTenantContext()` es lo que hace que eso sea seguro: `SET LOCAL` y
      // `set_config(…, true)` se deshacen en el COMMIT, y nunca un `SET` de sesión, que se
      // filtra al siguiente cliente.
      useFactory: (cfg: Config): Pool =>
        new Pool({ connectionString: cfg.DATABASE_URL_POOLER ?? cfg.DATABASE_URL, max: 10 }),
      inject: [CONFIG],
    },
    {
      provide: QUEUES,
      // Las colas van por la cadena de conexión y NO por el pool de arriba: ese lleva `SET ROLE`
      // por petición y BullMQ no puede fijarle el `search_path` a un pool que no construyó.
      useFactory: (cfg: Config): QueueConnection => queueConnection(cfg.DATABASE_URL),
      inject: [CONFIG],
    },
    { provide: Tokens, useFactory: (cfg: Config) => Tokens.fromFiles(cfg), inject: [CONFIG] },
    // Lo usan DOS: el guardia, que verifica el token de consola, y `PlatformSignIn`, que lo
    // firma desde el 30 de octubre de 2026. Antes se construía suelto en `app.module.ts`
    // con el comentario «no lo usa nadie más»; dos usuarios y una sola llave en memoria es
    // lo que garantiza que el `kid` que se firma sea el que se verifica.
    {
      provide: PlatformTokens,
      useFactory: (cfg: Config) => PlatformTokens.fromFiles(cfg),
      inject: [CONFIG],
    },
    {
      provide: SystemClock,
      useFactory: (cfg: Config) => new SystemClock(cfg.ZONA_HORARIA),
      inject: [CONFIG],
    },
    // Con el registro de fallos puesto: un hash de credencial ilegible sigue devolviendo
    // «no coincide» —indistinguible de una contraseña mal, que es lo correcto— pero deja
    // una fila de aviso en vez de desaparecer.
    {
      provide: Argon2Passwords,
      useFactory: (failures: FailureLog) => new Argon2Passwords(failures),
      inject: [FailureLog],
    },
    {
      provide: Counters,
      useFactory: (pool: Pool, cfg: Config) => new Counters(pool, cfg.SERVICE_HMAC_KEY),
      inject: [POOL, CONFIG],
    },
    { provide: SmtpMail, useFactory: (cfg: Config) => new SmtpMail(cfg), inject: [CONFIG] },
    { provide: FailureLog, useFactory: (pool: Pool) => new FailureLog(pool), inject: [POOL] },
    {
      provide: IDEMPOTENCY_SWEEP,
      useFactory: (pool: Pool, queues: QueueConnection, failures: FailureLog, counters: Counters) =>
        startIdempotencySweep(queues, new IdempotencySweep(pool), failures, counters),
      inject: [POOL, QUEUES, FailureLog, Counters],
    },
    {
      provide: RETENTION_SWEEP,
      useFactory: (pool: Pool, queues: QueueConnection, failures: FailureLog) =>
        startRetentionSweep(queues, new RetentionSweep(pool), failures),
      inject: [POOL, QUEUES, FailureLog],
    },
  ],
  exports: [
    CONFIG,
    POOL,
    QUEUES,
    Tokens,
    PlatformTokens,
    SystemClock,
    Argon2Passwords,
    Counters,
    SmtpMail,
    FailureLog,
  ],
})
export class SharedModule implements OnApplicationShutdown {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(IDEMPOTENCY_SWEEP) private readonly sweep: { queue: AppQueue; worker: AppWorker },
    @Inject(RETENTION_SWEEP) private readonly retention: { queue: AppQueue; worker: AppWorker },
  ) {}

  /**
   * El trabajador y su cola PRIMERO, y después el pool: cerrarlos al revés deja al trabajador
   * leyendo de una conexión que ya no está y convierte un apagado limpio en un fallo registrado.
   *
   * Las colas tienen su propio pool —lo construye BullMQ— y lo cierran ellas en su `close()`.
   */
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([
      this.sweep.worker.close(),
      this.sweep.queue.close(),
      this.retention.worker.close(),
      this.retention.queue.close(),
    ]);
    await this.pool.end();
  }
}
