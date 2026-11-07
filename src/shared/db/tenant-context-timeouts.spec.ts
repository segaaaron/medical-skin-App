// Los tiempos máximos de `withTenantContext()`: valen dentro de la transacción y se van con ella.
// Contra la base real; sin ellos las tres opciones valen 0 (sin límite).

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenantContext } from './tenant-context';

const app = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin',
  max: 1,
});

afterAll(async () => {
  await app.end();
});

const show = (c: { query: (q: string) => Promise<{ rows: Array<Record<string, string>> }> }) =>
  c.query(
    `select current_setting('statement_timeout') as st, current_setting('lock_timeout') as lt,
            current_setting('idle_in_transaction_session_timeout') as it`,
  );

describe('withTenantContext · tiempos máximos', () => {
  it('fija los tres dentro de la transacción y no los deja en la conexión', async () => {
    const dentro = await withTenantContext(
      app,
      { role: 'app_anonymous' },
      async (c) => (await show(c)).rows[0],
    );
    expect(dentro).toEqual({ st: '30s', lt: '5s', it: '1min' });

    // Misma conexión (max: 1), ya sin transacción: tiene que haber vuelto al valor del servidor.
    const fuera = (await show(app)).rows[0];
    expect(fuera).toEqual({ st: '0', lt: '0', it: '0' });
  });

  it('una consulta que supera el límite se corta con 57014', async () => {
    const corta = withTenantContext(app, { role: 'app_anonymous' }, async (c) => {
      await c.query("select set_config('statement_timeout', '50ms', true)");
      await c.query('select pg_sleep(1)');
    });
    await expect(corta).rejects.toMatchObject({ code: '57014' });
  });
});

describe('withTenantContext · tiempo propio de un trabajo largo', () => {
  it('statementTimeout sustituye los 30 s, y un valor mal escrito se rechaza antes de abrir nada', async () => {
    const dentro = await withTenantContext(
      app,
      { role: 'app_anonymous', statementTimeout: '120s' },
      async (c) => (await show(c)).rows[0],
    );
    expect(dentro).toEqual({ st: '2min', lt: '5s', it: '1min' });

    await expect(
      withTenantContext(app, { role: 'app_anonymous', statementTimeout: '1; drop table x' }, () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow('statementTimeout');
  });
});

describe('withTenantContext · la base corta la conexión con la transacción abierta', () => {
  it('la petición falla con error y el proceso sigue vivo', async () => {
    const pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin',
      max: 1,
    });
    const quieta = withTenantContext(pool, { role: 'app_anonymous' }, async (c) => {
      await c.query("select set_config('idle_in_transaction_session_timeout', '300ms', true)");
      await new Promise((r) => setTimeout(r, 900));
      await c.query('select 1');
    });
    // Sin el oyente de 'error' esto no rechaza: Node termina el proceso.
    await expect(quieta).rejects.toBeDefined();
    await pool.end();
  });
});
