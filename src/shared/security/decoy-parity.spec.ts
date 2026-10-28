// La comprobación de arranque del señuelo (0007). Dos mitades:
//
//   · la comparación, pura y determinista, con el caso que importa —uno que divergió—, que
//     contra la base no se puede montar sin resembrar la fila que mide todo lo demás;
//   · y la lectura de verdad, por `app_anonymous` y `withTenantContext()`, contra la base
//     en Docker: es exactamente lo que `main.ts` hace antes de `app.listen()`.
//
// Lo que esta prueba defiende: alguien sube `memoryCost` en `passwords.ts` —endurecer
// Argon2 es mantenimiento rutinario—, no escribe la migración que resiembra el señuelo, y
// el oráculo del reloj del 27 de octubre vuelve sin que `tsc` ni `eslint` digan nada.

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { appCost, assertDecoyParity, decoyParityProblem, readDecoyParams } from './decoy-parity';

const appUrl =
  process.env.DATABASE_URL_POOLER ??
  process.env.DATABASE_URL ??
  'postgresql://medskin:dev_local_only@localhost:5433/medskin';

const pool = new Pool({ connectionString: appUrl, max: 2 });
afterAll(async () => {
  await pool.end();
});

describe('la paridad del señuelo · la comparación', () => {
  it('coincide: no hay problema que contar', () => {
    expect(decoyParityProblem(appCost())).toBeNull();
  });

  it('un `memoryCost` endurecido sin resembrar el señuelo se nombra con los dos números', () => {
    // El señuelo se quedó donde estaba y la aplicación subió: es el escenario exacto del
    // oráculo. El valor sale de `appCost()` y no de un número fijo, para que el caso siga
    // probando lo mismo el día que el perfil de OWASP cambie.
    const atrasado = { ...appCost(), memoryCost: appCost().memoryCost - 1024 };
    const problema = decoyParityProblem(atrasado);

    expect(problema).toContain('memoryCost');
    expect(problema).toContain(String(atrasado.memoryCost));
    expect(problema).toContain(String(appCost().memoryCost));
  });

  it('otro algoritmo, otro coste de tiempo y otro paralelismo se cuentan los tres', () => {
    const problema = decoyParityProblem({
      algorithm: 'argon2i',
      memoryCost: appCost().memoryCost,
      timeCost: appCost().timeCost + 1,
      parallelism: appCost().parallelism + 3,
    });

    expect(problema).toContain('algorithm');
    expect(problema).toContain('timeCost');
    expect(problema).toContain('parallelism');
  });

  it('sin fila de señuelo tampoco se sirve: no hay nada contra lo que medir', () => {
    expect(decoyParityProblem(null)).toContain('access_decoy');
  });
});

describe('la paridad del señuelo · contra la base real', () => {
  it('la fila sembrada cuesta lo que cuesta una contraseña real, y el arranque pasa', async () => {
    expect(await readDecoyParams(pool)).toEqual(appCost());
    await expect(assertDecoyParity(pool)).resolves.toBeUndefined();
  });

  it('el hash del señuelo NO se lee: la función devuelve parámetros y nada más', async () => {
    const params = await readDecoyParams(pool);
    expect(Object.keys(params ?? {}).sort()).toEqual([
      'algorithm',
      'memoryCost',
      'parallelism',
      'timeCost',
    ]);
  });
});
