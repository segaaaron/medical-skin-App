// Toda tabla de `public` lleva RLS activada, FORZADA y al menos una política. Una tabla nueva
// sin eso rompe esta prueba antes de llegar a producción: el aislamiento entre tenants no puede
// depender de que alguien se acuerde. Las tablas de `drizzle` y de las colas viven en otros
// esquemas y no entran.

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

const owner = new Pool({
  connectionString:
    process.env.DATABASE_URL_OWNER ??
    'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin',
  max: 1,
});
afterAll(async () => {
  await owner.end();
});

describe('cobertura de RLS', () => {
  it('ninguna tabla de public queda sin RLS forzada y sin política', async () => {
    const { rows } = await owner.query<{
      tabla: string;
      rls: boolean;
      forzada: boolean;
      politicas: number;
    }>(
      `select c.relname as tabla, c.relrowsecurity as rls, c.relforcerowsecurity as forzada,
              (select count(*)::int from pg_policy p where p.polrelid = c.oid) as politicas
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
        order by c.relname`,
    );
    expect(rows.length).toBeGreaterThan(40);
    const incumplen = rows
      .filter((r) => !r.rls || !r.forzada || r.politicas === 0)
      .map((r) => r.tabla);
    expect(incumplen).toEqual([]);
  });
});
