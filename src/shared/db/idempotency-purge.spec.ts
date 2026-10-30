// La prueba de la 0024: el barrido de `idempotency_key`, que es lo que hace verdad la
// promesa de 24 h de `_convenciones.md`.
//
// Mismas reglas que sus hermanas: contra la base real en Docker, sin un solo doble, RLS
// nunca se desactiva, siembra el DUEÑO del esquema y todo lo que se COMPRUEBA pasa por los
// roles de aplicación y por `withTenantContext()`.
//
// El caso que explica por qué la función existe es el tercero: reproduce la medición que la
// levantó —ningún rol de aplicación puede barrer más que lo suyo— para que siga siendo
// verdad el día que alguien piense que esto se podía hacer desde la app.

import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantContext, type TenantContext } from './tenant-context';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ?? 'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

const HASH = '$argon2id$v=19$m=65536,p=4,t=3$c2VtaWxsYWRlcHJ1ZWJh$BcVqHhiTZ4RrQZ4kYgVvxCuUAneDdfTxZ6qz6hUwcLY';

const A = {
  practice: '4e4e4e4e-0000-4000-8000-00000000000a',
  account: '4e4e4e4e-0000-4000-8000-00000000001a',
  practitioner: '4e4e4e4e-0000-4000-8000-00000000002a',
  email: 'duena.a@barrido.local',
};
const B = {
  practice: '4e4e4e4e-0000-4000-8000-00000000000b',
  account: '4e4e4e4e-0000-4000-8000-00000000001b',
  practitioner: '4e4e4e4e-0000-4000-8000-00000000002b',
  email: 'duena.b@barrido.local',
};
const PATIENT = { account: '4e4e4e4e-0000-4000-8000-00000000000c', email: 'paciente@barrido.local' };
// La persona de la consola no tiene fila en `account` y `idempotency_key` no tiene clave
// foránea a ninguna: su clave de idempotencia es una fila como las demás.
const PLATFORM = { account: '4e4e4e4e-0000-4000-8000-00000000000d' };

const KEYS = {
  expiredA: 'caducada-a',
  aliveA: 'viva-a',
  expiredB: 'caducada-b',
  expiredPatient: 'caducada-paciente',
  expiredPlatform: 'caducada-plataforma',
};

const ctxPractitionerA: TenantContext = { role: 'app_practitioner', practiceId: A.practice, accountId: A.account };
const ctxPatient: TenantContext = { role: 'app_patient', accountId: PATIENT.account };
const ctxPlatform: TenantContext = { role: 'app_platform', accountId: PLATFORM.account };
const ctxAccount: TenantContext = { role: 'app_account', accountId: PATIENT.account };
const ctxAnonymous: TenantContext = { role: 'app_anonymous' };

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 1 });

async function read<T extends QueryResultRow>(ctx: TenantContext, sql: string, params: unknown[] = []): Promise<T[]> {
  return withTenantContext(app, ctx, async (client: PoolClient) => (await client.query<T>(sql, params)).rows);
}

const purge = async (ctx: TenantContext = ctxAnonymous) =>
  (await read<{ borradas: number }>(ctx, 'select medskin_purge_idempotency_keys() as borradas'))[0]?.borradas;

/** Qué claves quedan, leído por el dueño: ningún rol ve las de los demás, que es el punto. */
async function remaining(): Promise<string[]> {
  const { rows } = await owner.query<{ key: string }>(
    `select key from idempotency_key where key like 'caducada-%' or key like 'viva-%' order by key`,
  );
  return rows.map((r) => r.key);
}

async function seedKeys() {
  await owner.query(`delete from idempotency_key where key like 'caducada-%' or key like 'viva-%'`);
  await owner.query(
    `insert into idempotency_key (key, account_id, practice_id, body_hash, http_status, response, expires_at)
     values
       -- La caducada de A lleva en su respuesta lo que la convierte en el problema: el 201
       -- del alta con la contraseña temporal en claro, que la idempotencia promete repetir
       -- la respuesta de la misma petición, contraseña incluida, mientras la fila viva.
       ($1, $6, $9,  'h1', 201, '{"contrasena_temporal": "tejado-lila-07"}'::jsonb, now() - interval '1 minute'),
       ($2, $6, $9,  'h2', 201, '{"ok": true}'::jsonb,                             now() + interval '23 hours'),
       ($3, $7, $10, 'h3', 201, '{"ok": true}'::jsonb,                             now() - interval '2 hours'),
       ($4, $8, null, 'h4', 200, '{"ok": true}'::jsonb,                            now() - interval '25 hours'),
       ($5, $11, null, 'h5', 201, '{"ok": true}'::jsonb,                           now() - interval '30 hours')`,
    [
      KEYS.expiredA,
      KEYS.aliveA,
      KEYS.expiredB,
      KEYS.expiredPatient,
      KEYS.expiredPlatform,
      A.account,
      B.account,
      PATIENT.account,
      A.practice,
      B.practice,
      PLATFORM.account,
    ],
  );
}

beforeAll(async () => {
  await owner.query('delete from practice where id = any($1::uuid[])', [[A.practice, B.practice]]);
  await owner.query(`delete from account where email like '%@barrido.local'`);

  for (const t of [A, B]) {
    await owner.query(
      `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit)
       values ($1, 'Clínica Barrido', 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300)`,
      [t.practice],
    );
    await owner.query(
      `insert into account (id, email, role, region, first_name, last_name)
       values ($1, $2, 'doctor', 'latam', 'Andrea', 'Paz')`,
      [t.account, t.email],
    );
    await owner.query(`insert into credential (account_id, hash, is_temporary, set_at) values ($1, $2, false, now())`, [
      t.account,
      HASH,
    ]);
    await owner.query(
      `insert into practitioner (id, practice_id, account_id, first_name, last_name, role)
       values ($1, $2, $3, 'Andrea', 'Paz', 'doctor')`,
      [t.practitioner, t.practice, t.account],
    );
    await owner.query('update practice set owner_account_id = $1 where id = $2', [t.account, t.practice]);
  }
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'patient', 'latam', 'Carla', 'Rojas')`,
    [PATIENT.account, PATIENT.email],
  );
});

afterAll(async () => {
  await owner.query(`delete from idempotency_key where key like 'caducada-%' or key like 'viva-%'`);
  await owner.query('delete from practice where id = any($1::uuid[])', [[A.practice, B.practice]]);
  await owner.query(`delete from account where email like '%@barrido.local'`);
  await owner.end();
  await app.end();
});

describe('el barrido de `idempotency_key` · la retención de 24 h (0024)', () => {
  it('se lleva lo caducado de los dos consultas y de las cuentas sin consulta, y no toca lo vivo', async () => {
    await seedKeys();
    expect(await remaining()).toHaveLength(5);

    // Cuatro caducadas: la de A —con la contraseña en claro dentro—, la de B, la de la
    // paciente y la de la consola. Un solo barrido, sin sesión y sin contexto.
    expect(await purge()).toBe(4);
    expect(await remaining()).toEqual([KEYS.aliveA]);
  });

  it('un segundo barrido devuelve cero: dos veces no hace dos efectos', async () => {
    // La idempotencia del procesador, que es lo que le permite reintentar sin pensar.
    expect(await purge()).toBe(0);
    expect(await remaining()).toEqual([KEYS.aliveA]);
  });

  it('y por esto existe: ningún rol de aplicación puede barrer más que lo suyo', async () => {
    await seedKeys();

    // La medición que levantó el encargo, dentro de la suite para que siga siendo verdad.
    // El `GRANT DELETE` está desde la 0000; lo que confina son las políticas.
    const borra = async (ctx: TenantContext) =>
      (
        await read<{ cuantas: number }>(
          ctx,
          `with fuera as (delete from idempotency_key where expires_at <= now() returning 1)
           select count(*)::int as cuantas from fuera`,
        )
      )[0]?.cuantas;

    expect({
      practitionerA: await borra(ctxPractitionerA),
      patient: await borra(ctxPatient),
      platform: await borra(ctxPlatform),
    }).toEqual({ practitionerA: 1, patient: 1, platform: 1 });

    // Tres roles, tres intentos, y todavía queda una caducada: la de la consulta B, que
    // ninguno de ellos puede ver ni enumerar. Eso es lo que la función resuelve.
    expect(await remaining()).toEqual([KEYS.expiredB, KEYS.aliveA].sort());
    expect(await purge()).toBe(1);
    expect(await remaining()).toEqual([KEYS.aliveA]);
  });

  it('la ejecuta el rol sin sesión y nadie más', async () => {
    for (const ctx of [ctxPractitionerA, ctxPatient, ctxPlatform, ctxAccount]) {
      await expect(read(ctx, 'select medskin_purge_idempotency_keys()')).rejects.toThrow(
        /permission denied for function/i,
      );
    }
    // Y el que sí puede no necesita contexto ninguno para hacerlo: cuando el trabajador
    // corre no hay ni consulta ni cuenta que fijar.
    expect(await purge(ctxAnonymous)).toBe(0);
  });
});
