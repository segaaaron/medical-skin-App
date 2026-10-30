// EL BARRIDO DE `idempotency_key` CONTRA LA BASE REAL, porque lo que defiende no lo puede
// sostener un doble:
//
//   1. **borra lo caducado y no toca lo vivo.** Lo que decide qué es cada cosa es la función
//      de la base, no este código;
//   2. **corre con `app_anonymous` y sin contexto**, que es el único rol que alcanza la
//      función y el único que no fija consulta. Ningún rol de la aplicación puede barrer la
//      tabla: las tres políticas confinan a cada uno a su consulta o a su cuenta;
//   3. **es idempotente por construcción**: la segunda corrida no encuentra nada y devuelve
//      cero, así que el trabajo no necesita clave;
//   4. **un fallo deja su fila** en `service_failure`, por el camino sin sesión. Un barrido
//      que lleva días fallando en silencio es justo el estado que esto viene a evitar.

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FailureLog } from '../failures/service-failure';
import { QUEUE_NAMES } from '../queues/queues';
import { IdempotencySweep, SWEEP_BATCH, SWEEP_MAX_PASSES, recordSweepFailure } from './idempotency-sweep';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl =
  process.env.DATABASE_URL_POOLER ??
  process.env.DATABASE_URL ??
  'postgresql://medskin:dev_local_only@localhost:5433/medskin';

// Espacio propio: esta prueba no comparte semilla con ninguna otra.
const CONSULTA = 'b1b1b1b1-0000-4000-8000-000000000001';
const CUENTA = 'b1b1b1b1-0000-4000-8000-000000000002';

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 2 });

const sweep = new IdempotencySweep(app);
const failures = new FailureLog(app);

async function sembrarClave(key: string, caducada: boolean): Promise<void> {
  await owner.query(
    `insert into idempotency_key (key, account_id, practice_id, body_hash, http_status,
                                  response, expires_at)
     values ($1, $2, $3, 'huella', 201, $4::jsonb,
             case when $5::boolean then now() - interval '1 minute'
                  else now() + interval '23 hours' end)`,
    [
      key,
      CUENTA,
      CONSULTA,
      // Con la forma de la respuesta que hace que esta fila importe: una credencial viva.
      JSON.stringify({ acceso: { contrasena_temporal: 'tejado-lila-07' } }),
      caducada,
    ],
  );
}

async function claves(): Promise<string[]> {
  const { rows } = await owner.query<{ key: string }>(
    `select key from idempotency_key where key like 'barrido-%' order by key`,
  );
  return rows.map((r) => r.key);
}

async function limpiar(): Promise<void> {
  await owner.query(`delete from idempotency_key where key like 'barrido-%'`);
  await owner.query(`delete from service_failure where operation = $1`, [
    QUEUE_NAMES.idempotencySweep,
  ]);
}

beforeAll(async () => {
  await limpiar();
  await owner.query(
    `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit)
     values ($1, 'Consulta del barrido', 'latam', 'BO', 'America/La_Paz', 'BOB',
             'consultorio', 300)
     on conflict (id) do nothing`,
    [CONSULTA],
  );
});

afterAll(async () => {
  await limpiar();
  await owner.query('delete from practice where id = $1', [CONSULTA]);
  await app.end();
  await owner.end();
});

beforeEach(limpiar);

describe('el barrido de `idempotency_key`', () => {
  it('borra lo caducado, no toca lo vivo, y dice cuántas borró EN ESA llamada', async () => {
    await sembrarClave('barrido-caducada-1', true);
    await sembrarClave('barrido-caducada-2', true);
    await sembrarClave('barrido-viva', false);

    const primera = await sweep.run();

    // Dos, no tres: lo vivo sigue sirviendo para repetir una petición de las últimas 24 h.
    expect(primera.deleted).toBe(2);
    expect(primera.passes).toBe(1);
    expect(primera.pending).toBe(false);
    expect(await claves()).toEqual(['barrido-viva']);
  });

  it('es idempotente por construcción: la segunda corrida borra cero', async () => {
    await sembrarClave('barrido-caducada', true);

    expect((await sweep.run()).deleted).toBe(1);
    // Por eso el trabajo no lleva clave de idempotencia: no hay nada que repetir mal.
    const segunda = await sweep.run();
    expect(segunda.deleted).toBe(0);
    expect(segunda.pending).toBe(false);
    expect(await claves()).toEqual([]);
  });

  it('corre sin contexto de consulta, que es lo único que la función admite', async () => {
    // `app_anonymous` no fija ni cuenta ni consulta —el ayudante lo RECHAZA—, así que esta
    // prueba pasa justo porque el barrido no pretende ser de nadie. Y borra una fila que
    // pertenece a una consulta cuyo contexto nadie fijó, que es lo que ningún rol de la
    // aplicación puede hacer.
    await sembrarClave('barrido-de-otra-consulta', true);
    expect((await sweep.run()).deleted).toBe(1);
    expect(await claves()).toEqual([]);
  });

  it('la cota de la función es el contrato del bucle, y la del bucle es mía', () => {
    // No se prueban 10 000 filas: se fija que los dos números son los que el trabajo dice
    // que son, porque de ellos sale cuánta deuda limpia una corrida (200 000 filas) y cuánto
    // puede durar sin monopolizar la tabla.
    expect(SWEEP_BATCH).toBe(10_000);
    expect(SWEEP_MAX_PASSES).toBe(20);
  });
});

describe('un barrido que falla deja su fila', () => {
  it('va por el camino sin sesión, con la causa real y sin reintento prometido', async () => {
    const cause = new Error('la función no respondió', {
      cause: new Error('ECONNREFUSED 127.0.0.1:6432'),
    });

    await recordSweepFailure(failures, cause, 'repeat:barrido:1');

    const { rows } = await owner.query<{
      service: string;
      operation: string;
      severity: string;
      error_code: string;
      error_message: string;
      cause_chain: { name: string; message: string }[];
      trace_id: string;
      practice_id: string | null;
      actor_id: string | null;
      will_retry: boolean;
    }>(
      `select service, operation, severity, error_code, error_message, cause_chain, trace_id,
              practice_id, actor_id, will_retry
         from service_failure where operation = $1`,
      [QUEUE_NAMES.idempotencySweep],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // `service` y `severity` los FIJA la función del camino sin sesión («api» y «error»,
      // migración 0005), no quien llama: este trabajo pide `worker` y la fila dice `api`.
      // Se deja dicho en la entrega; cambiarlo es una migración y no es de este encargo.
      service: 'api',
      operation: 'idempotencia-barrido',
      severity: 'error',
      error_code: 'fallo_de_servicio',
      error_message: 'la función no respondió',
      trace_id: 'repeat:barrido:1',
      // Este trabajo no es de ninguna consulta ni de nadie: las dos columnas van en nulo.
      practice_id: null,
      actor_id: null,
      will_retry: false,
    });
    // La causa real encadenada, que es lo que hace falta para arreglarlo.
    expect(rows[0]?.cause_chain.map((c) => c.message)).toEqual([
      'la función no respondió',
      'ECONNREFUSED 127.0.0.1:6432',
    ]);
  });

  it('y el fallo del barrido de verdad llega a esa fila: la función no se puede llamar a medias', async () => {
    // Un pool contra un puerto donde no hay nada: `run()` rechaza en vez de devolver cero,
    // que es lo que hace que el manejador `failed` del trabajador se dispare.
    const muerto = new Pool({
      connectionString: 'postgresql://medskin:dev_local_only@localhost:1/medskin',
      max: 1,
    });
    const roto = new IdempotencySweep(muerto);

    const fallo = await roto.run().catch((e: unknown) => e);
    expect(fallo).toBeInstanceOf(Error);
    // Y ese error es un `AggregateError` con MENSAJE VACÍO, que es lo que hacía que la fila
    // no se pudiera escribir: la función rechaza la causa vacía y el fallo salía solo por la
    // salida de error. Por eso la cadena de causas usa el nombre cuando no hay mensaje.
    expect((fallo as Error).message).toBe('');

    await recordSweepFailure(failures, fallo, 'repeat:barrido:2');
    const { rows } = await owner.query<{ total: string }>(
      `select count(*)::text as total from service_failure where operation = $1`,
      [QUEUE_NAMES.idempotencySweep],
    );
    expect(rows[0]?.total).toBe('1');
    await muerto.end();
  });
});
