// Lo transversal, en un módulo: la configuración validada, el pool, Redis, las llaves del
// token, el reloj, Argon2id, los contadores, la idempotencia, el correo y el registro de
// fallos. Lo usan los 23 endpoints del tramo, así que se construye una vez.

import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { Pool } from 'pg';

import { SystemClock } from './clock';
import { config, type Config } from './config/config';
import { FailureLog } from './failures/service-failure';
import { IdempotencySweep, startIdempotencySweep } from './idempotency/idempotency-sweep';
import { SmtpMail } from './mail/mailer';
import { Counters } from './security/counters';
import { Argon2Passwords } from './security/passwords';
import { Tokens } from './security/tokens';

export const CONFIG = Symbol('CONFIG');
export const POOL = Symbol('POOL');
export const REDIS = Symbol('REDIS');

/**
 * EL BARRIDO DE `idempotency_key`, cada hora. Vive aquí y no en un módulo de recurso porque
 * la tabla no es de ninguno: la usan los cinco `POST` que crean algo. Se arranca al construir
 * el módulo y se cierra en el apagado, igual que el trabajador de recuperación.
 */
const IDEMPOTENCY_SWEEP = Symbol('IDEMPOTENCY_SWEEP');

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
      provide: REDIS,
      // `maxRetriesPerRequest: 1` y sin cola fuera de línea: si Redis no está, el contador
      // falla rápido y el endpoint responde 500. Un límite de intentos que espera en vez
      // de fallar es un límite que no cuenta (_convenciones.md · «Los contadores»).
      useFactory: (cfg: Config): Redis =>
        new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false }),
      inject: [CONFIG],
    },
    { provide: Tokens, useFactory: (cfg: Config) => Tokens.fromFiles(cfg), inject: [CONFIG] },
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
      useFactory: (redis: Redis, cfg: Config) => new Counters(redis, cfg.SERVICE_HMAC_KEY),
      inject: [REDIS, CONFIG],
    },
    { provide: SmtpMail, useFactory: (cfg: Config) => new SmtpMail(cfg), inject: [CONFIG] },
    { provide: FailureLog, useFactory: (pool: Pool) => new FailureLog(pool), inject: [POOL] },
    {
      provide: IDEMPOTENCY_SWEEP,
      useFactory: (pool: Pool, redis: Redis, failures: FailureLog) =>
        startIdempotencySweep(redis, new IdempotencySweep(pool), failures),
      inject: [POOL, REDIS, FailureLog],
    },
  ],
  exports: [
    CONFIG,
    POOL,
    REDIS,
    Tokens,
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
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(IDEMPOTENCY_SWEEP) private readonly sweep: { queue: Queue; worker: Worker },
  ) {}

  /**
   * El trabajador y su cola PRIMERO, y después el pool y Redis: cerrarlos al revés deja al
   * trabajador leyendo de una conexión que ya no está y convierte un apagado limpio en un
   * fallo registrado.
   */
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.sweep.worker.close(), this.sweep.queue.close()]);
    await Promise.allSettled([this.pool.end(), this.redis.quit()]);
  }
}
