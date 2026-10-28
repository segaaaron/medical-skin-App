// LA COMPROBACIÓN DE ARRANQUE DEL SEÑUELO, que la 0007 encargó y nadie había escrito.
//
// Los parámetros de Argon2 viajan DENTRO del hash codificado, así que `argon2.verify()`
// cuesta lo que diga el hash que recibe y no lo que diga `ARGON2_COST`. Endurecer Argon2 es
// mantenimiento rutinario: alguien sube `memoryCost` en `passwords.ts`, no escribe la
// migración que resiembra `access_decoy`, y `tsc` y `eslint` pasan. En producción las
// contraseñas reales pasan al coste nuevo y el señuelo se queda en el viejo: vuelve el
// oráculo del 27 de octubre —26,8 ms contra 15,2 ms, rangos sin solapamiento— y separa a
// las pacientes de MedSkin de las que no lo son con un cronómetro y tres peticiones.
//
// La única paridad comprobada vivía en un caso de vitest, y el despliegue no corre vitest.
// Esto se lee ANTES de `app.listen()` y el proceso se niega a servir si no coincide.
// Determinista y sin reloj: compara cuatro enteros y una cadena.
//
// `medskin_access_decoy_params()` devuelve los parámetros PARSEADOS DEL PROPIO HASH y nunca
// el hash, y su `EXECUTE` es solo de `app_anonymous`, que es el rol cuyo reloj está en
// juego. Lo que no se puede leer no se compara.

import type { Pool } from 'pg';

import { withTenantContext } from '../db/tenant-context';
import { ARGON2_COST } from './passwords';

export type DecoyParams = {
  algorithm: string;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
};

/** Lo que la aplicación usa para hashear, con los nombres de la fila. */
export function appCost(): DecoyParams {
  return {
    algorithm: 'argon2id',
    memoryCost: ARGON2_COST.memoryCost,
    timeCost: ARGON2_COST.timeCost,
    parallelism: ARGON2_COST.parallelism,
  };
}

/**
 * `null` si el señuelo y la aplicación cuestan lo mismo; si no, qué difiere. Función pura y
 * sin base para que el caso que importa —uno que divergió— se pueda probar sin tener que
 * desincronizar la base de verdad.
 */
export function decoyParityProblem(seeded: DecoyParams | null): string | null {
  if (seeded === null) return 'la fila de `access_decoy` no existe o no se pudo leer';

  const expected = appCost();
  const differences = (Object.keys(expected) as (keyof DecoyParams)[])
    .filter((key) => seeded[key] !== expected[key])
    .map((key) => `${key}: el señuelo ${String(seeded[key])}, la aplicación ${String(expected[key])}`);

  return differences.length === 0 ? null : differences.join(' · ');
}

export async function readDecoyParams(pool: Pool): Promise<DecoyParams | null> {
  return withTenantContext(pool, { role: 'app_anonymous' }, async (c) => {
    const { rows } = await c.query<{
      algorithm: string;
      memory_cost: number;
      time_cost: number;
      parallelism: number;
    }>(
      `select algorithm, memory_cost, time_cost, parallelism
         from medskin_access_decoy_params()`,
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      algorithm: row.algorithm,
      memoryCost: row.memory_cost,
      timeCost: row.time_cost,
      parallelism: row.parallelism,
    };
  });
}

/**
 * Lanza si no coinciden, y el mensaje dice exactamente qué y qué hacer. No lleva el hash
 * —no se lee— ni ninguna contraseña: solo cinco parámetros públicos.
 */
export async function assertDecoyParity(pool: Pool): Promise<void> {
  const problem = decoyParityProblem(await readDecoyParams(pool));
  if (problem === null) return;

  throw new Error(
    `El señuelo del acceso no cuesta lo mismo que una contraseña real (${problem}). ` +
      'Mientras no coincidan, el tiempo del 401 dice si un correo tiene cuenta. ' +
      'Se arregla con una migración que resiembre `access_decoy` con el coste de ahora, ' +
      'como la 0007: la aplicación no sirve hasta entonces.',
  );
}
