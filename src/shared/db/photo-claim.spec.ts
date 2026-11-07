// La prueba de la 0086: `medskin_photos_claim` no entrega la misma foto a dos pasadas.
//
// Contra la base real en Docker, sin dobles. Siembra el dueño del esquema; reclama
// `app_anonymous`, que es el rol del trabajador.
//
// Las fotos llevan `created_at` del año 2000 para que el `ORDER BY created_at` las ponga
// delante de cualquier otra `procesando` que haya en la base de desarrollo, y los reclamos
// piden exactamente cuantas hay.

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantContext, type TenantContext } from './tenant-context';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl =
  process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

const P = {
  practice: '5c5c5c5c-0000-4000-8000-00000000000a',
  account: '5c5c5c5c-0000-4000-8000-00000000001a',
  patient: '5c5c5c5c-0000-4000-8000-00000000002a',
  first: '5c5c5c5c-0000-4000-8000-0000000000f1',
  second: '5c5c5c5c-0000-4000-8000-0000000000f2',
};
const MAX_ATTEMPTS = 3;
const LEASE = 300;
const EXPIRED = '2000-01-01T00:00:00Z';

const ctxAnonymous: TenantContext = { role: 'app_anonymous' };
const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 2 });

const claimIn = async (client: PoolClient, limit: number) =>
  (
    await client.query<{ id: string }>(
      'select id from medskin_photos_claim($1, $2, $3) order by id',
      [limit, MAX_ATTEMPTS, LEASE],
    )
  ).rows.map((r) => r.id);

const claim = (limit: number) => withTenantContext(app, ctxAnonymous, (c) => claimIn(c, limit));

async function seedPhotos() {
  await owner.query('delete from photo where practice_id = $1', [P.practice]);
  await owner.query(
    `insert into photo (id, practice_id, patient_id, view, status, uploaded_by, declared_type,
                        declared_bytes, created_at)
     values ($1, $3, $4, 'frente', 'procesando', 'doctor', 'image/jpeg', 120000, '2000-01-01T00:00:01Z'),
            ($2, $3, $4, 'frente', 'procesando', 'doctor', 'image/jpeg', 120000, '2000-01-01T00:00:02Z')`,
    [P.first, P.second, P.practice, P.patient],
  );
}

const leases = async () =>
  (
    await owner.query<{ id: string; leased: boolean }>(
      'select id, claimed_until is not null as leased from photo where practice_id = $1 order by id',
      [P.practice],
    )
  ).rows;

beforeAll(async () => {
  await owner.query('delete from practice where id = $1', [P.practice]);
  await owner.query('delete from account where id = $1', [P.account]);
  await owner.query(
    `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit)
     values ($1, 'Clínica Reclamo', 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300)`,
    [P.practice],
  );
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, 'duena@reclamo.local', 'doctor', 'latam', 'Andrea', 'Paz')`,
    [P.account],
  );
  await owner.query(
    `insert into practitioner (practice_id, account_id, role, status, first_name, last_name)
     values ($1, $2, 'doctor', 'activa', 'Andrea', 'Paz')`,
    [P.practice, P.account],
  );
  await owner.query(
    `insert into patient (id, practice_id, first_name, last_name, birth_date, email, how_arrived)
     values ($1, $2, 'Ana', 'Antelo', '1992-04-18', 'ana@reclamo.local', 'instagram')`,
    [P.patient, P.practice],
  );
});

afterAll(async () => {
  await owner.query('delete from practice where id = $1', [P.practice]);
  await owner.query('delete from account where id = $1', [P.account]);
  await owner.end();
  await app.end();
});

describe('el reclamo de fotos del trabajador (0086)', () => {
  it('dos reclamos seguidos no devuelven la misma foto, y tras vencer el arrendamiento sí', async () => {
    await seedPhotos();

    expect(await claim(1)).toEqual([P.first]);
    expect(await claim(1)).toEqual([P.second]);
    expect(await leases()).toEqual([
      { id: P.first, leased: true },
      { id: P.second, leased: true },
    ]);

    await owner.query('update photo set claimed_until = $1 where id = $2', [EXPIRED, P.first]);
    expect(await claim(1)).toEqual([P.first]);
  });

  it('dos reclamos a la vez: el segundo salta la fila bloqueada por el primero', async () => {
    await seedPhotos();

    const [a, b] = await withTenantContext(app, ctxAnonymous, async (c) => {
      const first = await claimIn(c, 1);
      // Otra conexión mientras la primera transacción sigue abierta con su fila bloqueada.
      const second = await claim(1);
      return [first, second];
    });
    expect({ a, b }).toEqual({ a: [P.first], b: [P.second] });
  });

  it('`medskin_photo_processed` y `medskin_photo_failed` sueltan el arrendamiento', async () => {
    await seedPhotos();
    expect(await claim(2)).toEqual([P.first, P.second]);

    await withTenantContext(app, ctxAnonymous, async (c) => {
      await c.query('select medskin_photo_processed($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
        P.first,
        'image/jpeg',
        800,
        800,
        'avif',
        50000,
        null,
        null,
        null,
      ]);
      await c.query('select medskin_photo_failed($1, $2, $3)', [
        P.second,
        'decodificación',
        MAX_ATTEMPTS,
      ]);
    });
    expect(await leases()).toEqual([
      { id: P.first, leased: false },
      { id: P.second, leased: false },
    ]);

    // La fallida con intentos restantes vuelve en la pasada siguiente, con un intento contado.
    const again = await withTenantContext(
      app,
      ctxAnonymous,
      async (c) =>
        (
          await c.query<{ id: string; attempts: number }>(
            'select id, attempts from medskin_photos_claim(1, $1, $2)',
            [MAX_ATTEMPTS, LEASE],
          )
        ).rows,
    );
    expect(again).toEqual([{ id: P.second, attempts: 1 }]);
  });

  it('solo la ejecuta el rol del trabajador', async () => {
    const ctx: TenantContext = {
      role: 'app_practitioner',
      practiceId: P.practice,
      accountId: P.account,
    };
    await expect(
      withTenantContext(app, ctx, (c) => c.query('select * from medskin_photos_claim(1, 3, 300)')),
    ).rejects.toThrow(/permission denied for function/i);
  });
});
