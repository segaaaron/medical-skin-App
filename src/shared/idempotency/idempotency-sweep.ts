// EL BARRIDO DE `idempotency_key`, cada hora. Es la otra mitad de la retención: la lectura
// ya ignora lo caducado —`expires_at > now()`, así que el comportamiento es el del contrato
// aunque la fila siga ahí—, y esto es lo que hace que la fila **deje de estar ahí**.
//
// Por qué importa más que la higiene normal: la respuesta guardada del `201` de
// `POST /v1/patients` lleva la contraseña temporal EN CLARO cuando la vía es `whatsapp` o
// `ninguna`. Pasadas sus 24 h esa fila ya no sirve para nada y sigue siendo el nombre, el
// correo y una credencial de una paciente. `_convenciones.md` promete «durante 24 h», que es
// una promesa de retención y no solo una ventana de repetición, y hasta la 0024 nadie barría:
// `expires_at` se escribía, `idempotency_key_purge_idx` existía desde la 0000 y nadie los
// leía.
//
// LO QUE BORRA LO DECIDE LA BASE, NO ESTE ARCHIVO. `medskin_purge_idempotency_keys()` es
// `SECURITY DEFINER` y propiedad de `medskin_access` porque **ningún rol de la aplicación
// puede barrer la tabla**: las tres políticas confinan a cada uno a su inquilino o a su
// cuenta, y está medido —`app_practitioner` sin consulta borra 0 de 3, con consulta borra 1
// de 3, `app_patient` 0 de 3, `app_platform` 1 de 3 y `app_anonymous` da 42501—. Así que el
// trabajo corre con `app_anonymous`, que no fija contexto y cuyo único privilegio son
// funciones como esta (napkin §1.6).

import type { Pool } from 'pg';
import type { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { withTenantContext } from '../db/tenant-context';
import { FailureLog } from '../failures/service-failure';
import { QUEUE_NAMES, createQueue, createWorker } from '../queues/queues';

/** Cada hora. No hace falta más: lo que barre caducó hace rato y la lectura ya lo ignora. */
export const SWEEP_EVERY_MS = 60 * 60 * 1000;

/** La cota de la función: `10 000` significa «puede haber más, vuelve a llamar». */
export const SWEEP_BATCH = 10_000;

/**
 * CUÁNTAS VECES SEGUIDAS SE LLAMA EN UN TRABAJO, y es una decisión con su número: hasta 20
 * pasadas, 200 000 filas.
 *
 * Por qué se vuelve a llamar en el mismo trabajo y no se deja para la hora siguiente: nadie
 * ha barrido nunca, así que la primera corrida tiene por delante toda la deuda del día uno, y
 * a 10 000 por hora una deuda de 100 000 tardaría diez horas en desaparecer. Por qué con
 * cota: sin ella, esa primera corrida se queda dando vueltas sin fin conocido, y este trabajo
 * toca la tabla que está en la ruta caliente de todo `POST` que crea algo.
 *
 * Y cada pasada es SU PROPIA TRANSACCIÓN —una llamada, un `withTenantContext()`—, que es lo
 * que hace que la cota de 10 000 sirva para lo que existe: los bloqueos de fila se sueltan
 * entre pasada y pasada, así que el alta de una paciente no espera detrás del barrido.
 */
export const SWEEP_MAX_PASSES = 20;

export type SweepResult = {
  /** Filas borradas en ESTE trabajo, sumando sus pasadas. Nunca «las que estaban caducadas». */
  deleted: number;
  passes: number;
  /** `true` si la última pasada llegó a la cota: queda deuda para la hora siguiente. */
  pending: boolean;
};

export class IdempotencySweep {
  constructor(private readonly pool: Pool) {}

  /**
   * Llama a la función hasta que una pasada devuelva menos que la cota —«no quedaba nada más
   * en ese instante»— o hasta agotar `SWEEP_MAX_PASSES`.
   *
   * No lleva clave de idempotencia y no la necesita: la operación es idempotente por
   * construcción, porque la segunda ejecución no encuentra nada caducado y devuelve `0`.
   */
  async run(): Promise<SweepResult> {
    let deleted = 0;
    for (let passes = 1; passes <= SWEEP_MAX_PASSES; passes += 1) {
      const batch = await this.purge();
      deleted += batch;
      if (batch < SWEEP_BATCH) return { deleted, passes, pending: false };
    }
    return { deleted, passes: SWEEP_MAX_PASSES, pending: true };
  }

  /** Una pasada, una transacción. `app_anonymous` y sin contexto que fijar. */
  private async purge(): Promise<number> {
    return withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<{ borradas: number }>(
        'select medskin_purge_idempotency_keys() as borradas',
      );
      // La función devuelve `integer` y siempre una fila; si no, es que no es la que
      // creemos, y eso se ve en vez de contarse como cero filas borradas.
      const borradas = rows[0]?.borradas;
      if (borradas === undefined) {
        throw new Error('medskin_purge_idempotency_keys no devolvió cuántas borró');
      }
      return borradas;
    });
  }
}

/**
 * El trabajador y su trabajo repetible. Vive en el mismo proceso que la API, como el de
 * recuperación: moverlo a otro proceso es cambiar quién llama a esta función.
 *
 * SIN REINTENTOS (`attempts: 1`), y es la segunda decisión con su motivo: un barrido horario
 * que reintenta tres veces en catorce segundos no aporta nada, porque **la próxima hora
 * vuelve igual** y lo que barre no se ha movido. Lo que sí hace falta es que un barrido que
 * lleva días fallando se vea, y de eso se encargan la cola de fallidos —`removeOnFail: false`,
 * que no borra— y una fila de `service_failure` por CADA intento fallido, no solo por el
 * último.
 */
export function startIdempotencySweep(
  redis: Redis,
  sweep: IdempotencySweep,
  failures: FailureLog,
): { queue: Queue; worker: Worker } {
  const queue = createQueue(QUEUE_NAMES.idempotencySweep, redis);

  // `upsertJobScheduler` y no `add({ repeat })`: es la forma viva en BullMQ 6 y, siendo
  // `upsert`, arrancar dos veces el proceso no deja dos programaciones.
  //
  // Con su `catch`: esta promesa no la espera nadie —el módulo se construye sin bloquear el
  // arranque por un trabajo de higiene— y una programación que falla porque Redis no está
  // sería, sin esto, un rechazo sin dueño. Que no se programe es un fallo registrable, no un
  // motivo para que la API no arranque: lo que esto barre puede esperar una hora.
  queue
    .upsertJobScheduler(
      QUEUE_NAMES.idempotencySweep,
      { every: SWEEP_EVERY_MS },
      { name: QUEUE_NAMES.idempotencySweep, opts: { attempts: 1, removeOnFail: false } },
    )
    .catch((cause: unknown) => recordSweepFailure(failures, cause, 'programacion'));

  const worker = createWorker(QUEUE_NAMES.idempotencySweep, redis, () => sweep.run());

  worker.on('failed', (job, cause) => {
    void recordSweepFailure(failures, cause, job?.id);
  });

  return { queue, worker };
}

/**
 * La fila del fallo. Va por el camino sin sesión —`medskin_record_anonymous_failure()`—
 * porque este trabajo no tiene cuenta ni inquilino que escribir, y es el mismo que ya usa el
 * trabajador de recuperación.
 *
 * `severity: 'error'` y no `'warning'`: sin reintentos, un intento fallido es un barrido que
 * no ocurrió. Y en la causa no hay nada que tapar: este trabajo no conoce ningún correo, ni
 * ninguna contraseña, ni una sola fila de las que borra.
 */
export async function recordSweepFailure(
  failures: FailureLog,
  cause: unknown,
  jobId?: string,
): Promise<void> {
  await failures.record({
    service: 'worker',
    operation: QUEUE_NAMES.idempotencySweep,
    severity: 'error',
    errorCode: 'fallo_de_servicio',
    cause,
    traceId: jobId ?? 'sin-traza',
    requestId: jobId ?? 'sin-peticion',
    appVersion: null,
    platform: null,
    region: null,
    context: null,
  });
}
