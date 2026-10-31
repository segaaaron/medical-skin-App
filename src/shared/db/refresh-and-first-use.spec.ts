// Lo que añaden la 0017 y la 0018, y solo eso:
//
//   0017 · el reenvío de acceso deja de borrar `temp_first_used_at`, así que la paciente
//          que ya estrenó su temporal conserva la recuperación por correo cuando el
//          reenvío se queda a medias (H-12) o cuando el correo se pierde.
//   0018 · `medskin_session_refresh` devuelve lo que el 200 de `POST /v1/session/refresh`
//          promete —`practitioner_role`, `license_declared`, `first_day_done`,
//          `password_is_temporary`— y resuelve la gracia de 20 s en la fila.
//   0020 · acuñar una temporal nueva revoca las sesiones de esa cuenta —la llave contra la
//          que estaban autenticadas ya no existe— y el refresco calcula su caducidad con el
//          rol, en la misma transacción que rota.
//
// Mismas reglas que sus hermanas: contra la base real en Docker, sin un solo doble, RLS
// nunca se desactiva, siembra el DUEÑO del esquema y todo lo que se COMPRUEBA pasa por los
// roles de aplicación y por `withTenantContext()`.

import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantContext, type TenantContext } from './tenant-context';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ?? 'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

const HASH = '$argon2id$v=19$m=65536,p=4,t=3$c2VtaWxsYWRlcHJ1ZWJh$BcVqHhiTZ4RrQZ4kYgVvxCuUAneDdfTxZ6qz6hUwcLY';
const NEW_TEMP = '$argon2id$v=19$m=65536,p=4,t=3$b3RyYXNlbWlsbGFhcQ$GVnsaFqlkimVX8dDYgVvxCuUAneDdfTxZ6qz6hUwcLY';
// El código de recuperación viaja hasheado con Argon2id, igual que una contraseña, y la
// función lo exige. Los refrescos, en cambio, son resúmenes deterministas: hay un índice
// único sobre su columna y un hash con sal nueva en cada cálculo no se podría buscar.
const CODE_HASH = '$argon2id$v=19$m=65536,p=4,t=3$dGVyY2VyYXNlbWlsbGE$QZ4kYgVvxCuUAneDdfTxZ6qz6hUwcLYBcVqHhiTZ4Rr';

const DOCTOR = {
  practice: '0a0a0a0a-0000-4000-8000-00000000000a',
  account: '0a0a0a0a-0000-4000-8000-00000000001a',
  practitioner: '0a0a0a0a-0000-4000-8000-00000000002a',
  session: '0a0a0a0a-0000-4000-8000-00000000003a',
  email: 'duena@refresco.local',
  refresh: 'd'.repeat(64),
};
// La paciente de la 0017 que SÍ estrenó su temporal, y la que no. Las dos con vínculo en
// la consulta de la doctora, que es lo que autoriza el reenvío.
const USED = {
  account: '0a0a0a0a-0000-4000-8000-00000000000b',
  patient: '0a0a0a0a-0000-4000-8000-00000000001b',
  link: '0a0a0a0a-0000-4000-8000-00000000002b',
  session: '0a0a0a0a-0000-4000-8000-00000000003b',
  email: 'estreno@refresco.local',
  refresh: 'e'.repeat(64),
};
const NEVER = {
  account: '0a0a0a0a-0000-4000-8000-00000000000c',
  patient: '0a0a0a0a-0000-4000-8000-00000000001c',
  link: '0a0a0a0a-0000-4000-8000-00000000002c',
  email: 'sin.estrenar@refresco.local',
};

const ctxDoctor: TenantContext = { role: 'app_practitioner', practiceId: DOCTOR.practice, accountId: DOCTOR.account };
const ctxPlatform: TenantContext = { role: 'app_platform', accountId: '0a0a0a0a-0000-4000-8000-00000000000d' };
const ctxAnonymous: TenantContext = { role: 'app_anonymous' };

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 1 });

async function read<T extends QueryResultRow>(ctx: TenantContext, sql: string, params: unknown[] = []): Promise<T[]> {
  return withTenantContext(app, ctx, async (client: PoolClient) => (await client.query<T>(sql, params)).rows);
}

/** Lo que solo el dueño puede mirar: `temp_first_used_at` no se concede a ningún rol. */
async function markOf(accountId: string): Promise<Date | null> {
  const { rows } = await owner.query<{ first: Date | null }>(
    'select temp_first_used_at as first from credential where account_id = $1',
    [accountId],
  );
  return rows[0]?.first ?? null;
}

async function clean() {
  await owner.query('delete from practice where id = $1', [DOCTOR.practice]);
  await owner.query(`delete from account where email like '%@refresco.local'`);
}

beforeAll(async () => {
  await clean();
  await owner.query(
    `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit)
     values ($1, 'Clínica Refresco', 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300)`,
    [DOCTOR.practice],
  );
  // La licencia sin enviar y el primer día sin tocar: el `siguiente_paso` de esta doctora
  // es `licencia`, y eso es lo que la 0018 tiene que poder decir.
  await owner.query(`insert into license (practice_id) values ($1)`, [DOCTOR.practice]);
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'doctor', 'latam', 'Andrea', 'Paz'),
            ($3, $4, 'patient', 'latam', 'Rocio', 'Vargas'),
            ($5, $6, 'patient', 'latam', 'Lucia', 'Suarez')`,
    [DOCTOR.account, DOCTOR.email, USED.account, USED.email, NEVER.account, NEVER.email],
  );
  await owner.query(`insert into credential (account_id, hash, is_temporary, set_at) values ($1, $2, false, now())`, [
    DOCTOR.account,
    HASH,
  ]);
  // La diferencia entre las dos pacientes es UNA columna, y es toda la 0017.
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, temp_expires_at, temp_first_used_at)
     values ($1, $2, true, now() + interval '72 hours', now() - interval '1 hour'),
            ($3, $2, true, now() + interval '72 hours', null)`,
    [USED.account, HASH, NEVER.account],
  );
  await owner.query(
    `insert into practitioner (id, practice_id, account_id, first_name, last_name, role)
     values ($1, $2, $3, 'Andrea', 'Paz', 'doctor')`,
    [DOCTOR.practitioner, DOCTOR.practice, DOCTOR.account],
  );
  await owner.query('update practice set owner_account_id = $1 where id = $2', [DOCTOR.account, DOCTOR.practice]);
  await owner.query(
    `insert into patient (id, practice_id, first_name, last_name, birth_date, email, how_arrived)
     values ($1, $2, 'Rocio', 'Vargas', '1990-02-02', $3, 'instagram'),
            ($4, $2, 'Lucia', 'Suarez', '1991-03-03', $5, 'instagram')`,
    [USED.patient, DOCTOR.practice, USED.email, NEVER.patient, NEVER.email],
  );
  await owner.query(
    `insert into patient_link (id, practice_id, patient_id, account_id, email, practice_name, practitioner_name)
     values ($1, $2, $3, $4, $5, 'Clínica Refresco', 'Dra. Andrea Paz'),
            ($6, $2, $7, $8, $9, 'Clínica Refresco', 'Dra. Andrea Paz')`,
    [
      USED.link,
      DOCTOR.practice,
      USED.patient,
      USED.account,
      USED.email,
      NEVER.link,
      NEVER.patient,
      NEVER.account,
      NEVER.email,
    ],
  );
  // Las dos sesiones con refresco vivo. `scope = 'completo'` no es decorativo: la base
  // prohíbe un refresco en cualquier otro alcance (`session_scope_without_refresh_ck`).
  await owner.query(
    `insert into session (id, account_id, practice_id, scope, device_id, refresh_hash, refresh_expires_at)
     values ($1, $2, $3, 'completo', 'disp-duena', $4, now() + interval '12 hours'),
            ($5, $6, null, 'completo', 'disp-paciente', $7, now() + interval '30 days')`,
    [DOCTOR.session, DOCTOR.account, DOCTOR.practice, DOCTOR.refresh, USED.session, USED.account, USED.refresh],
  );
});

afterAll(async () => {
  await clean();
  await owner.end();
  await app.end();
});

// =========================================================================================
// 0017 · H-12
// =========================================================================================
describe('el reenvío de acceso · la marca de la primera entrada es un hecho (0017)', () => {
  it('la paciente que ya estrenó su temporal conserva la recuperación cuando el reenvío se queda a medias', async () => {
    const before = await markOf(USED.account);
    expect(before).not.toBeNull();

    // El reenvío de la doctora. En el camino de H-12 lo que viene después es el relé de
    // correo que falla y la compensación de `access_sent_at`: la temporal vieja ya está
    // muerta y la nueva no se entregó nunca.
    const [out] = await read<{ outcome: string }>(
      ctxDoctor,
      `select outcome from medskin_resend_patient_access($1, $2, now() + interval '72 hours')`,
      [USED.account, NEW_TEMP],
    );
    expect(out?.outcome).toBe('acceso_renovado');

    // La marca sigue en su sitio y con su valor: es la fecha de la PRIMERA entrada, no de
    // esta temporal.
    expect(await markOf(USED.account)).toEqual(before);

    // Y esto es lo que H-12 le quitaba: su propia salida, sin depender de que la doctora
    // acierte otro reenvío.
    const [minted] = await read<{ medskin_recovery_mint: boolean }>(
      ctxAnonymous,
      `select medskin_recovery_mint($1::citext, $2, now() + interval '10 minutes')`,
      [USED.email, CODE_HASH],
    );
    expect(minted?.medskin_recovery_mint).toBe(true);
  });

  it('la que nunca la estrenó sigue sin recuperación, y el reenvío no cambia eso', async () => {
    // La regla de `recuperacion.md` no se toca: «quien no probó nunca que tiene el correo
    // no puede usar el correo para entrar». Su camino sigue siendo el reenvío.
    const [out] = await read<{ outcome: string }>(
      ctxDoctor,
      `select outcome from medskin_resend_patient_access($1, $2, now() + interval '72 hours')`,
      [NEVER.account, NEW_TEMP],
    );
    expect(out?.outcome).toBe('acceso_renovado');
    expect(await markOf(NEVER.account)).toBeNull();

    const [minted] = await read<{ medskin_recovery_mint: boolean }>(
      ctxAnonymous,
      `select medskin_recovery_mint($1::citext, $2, now() + interval '10 minutes')`,
      [NEVER.email, CODE_HASH],
    );
    expect(minted?.medskin_recovery_mint).toBe(false);
  });

  it('el reenvío de la consola tampoco borra la marca: era la misma línea en las dos funciones', async () => {
    const before = await markOf(USED.account);
    const [out] = await read<{ outcome: string }>(
      ctxPlatform,
      `select outcome from medskin_platform_resend_access($1, $2, now() + interval '72 hours')`,
      [USED.account, HASH],
    );
    expect(out?.outcome).toBe('acceso_renovado');
    expect(await markOf(USED.account)).toEqual(before);
  });

  it('el reenvío revoca la sesión viva de esa cuenta, y su refresco ya no rota (0020)', async () => {
    // El callejón sin salida que esto cierra: con la sesión abierta, el refresco devolvía
    // `siguiente_paso: contrasena_nueva` con un token de alcance `completo`, y
    // `POST /v1/access/new-password` solo admite `contrasena_temporal` y
    // `recuperacion`. La pantalla se abría y no se podía completar.
    await owner.query('update session set revoked_at = null, revoked_reason = null where id = $1', [USED.session]);

    const [out] = await read<{ outcome: string }>(
      ctxDoctor,
      `select outcome from medskin_resend_patient_access($1, $2, now() + interval '72 hours')`,
      [USED.account, NEW_TEMP],
    );
    expect(out?.outcome).toBe('acceso_renovado');

    const { rows } = await owner.query<{ revoked: Date | null; reason: string | null }>(
      'select revoked_at as revoked, revoked_reason as reason from session where id = $1',
      [USED.session],
    );
    expect(rows[0]?.revoked).not.toBeNull();
    expect(rows[0]?.reason).toBe('access_resent');

    // Y la consecuencia que importa: su refresco ya no rota. `revoked` y no `invalid`, que
    // son dos frases distintas a propósito.
    const [verdict] = await read<{ verdict: string }>(
      ctxAnonymous,
      `select verdict from medskin_session_refresh($1, $2, $3, $4)`,
      [USED.refresh, 'z'.repeat(64), 30 * 24 * 3600, 12 * 3600],
    );
    expect(verdict?.verdict).toBe('revoked');
  });
});

// =========================================================================================
// 0018 · POST /v1/session/refresh
// =========================================================================================
describe('el refresco · lo que el 200 promete y la gracia de 20 s (0018)', () => {
  type Rotation = {
    verdict: string;
    role: string | null;
    practitioner_role: string | null;
    permissions: string[] | null;
    account_status: string | null;
    password_is_temporary: boolean | null;
    license_declared: boolean | null;
    first_day_done: boolean | null;
    graced: boolean;
    refresh_expires_at: Date | null;
  };

  // Las dos vidas las pone el llamador y la base les pone cota: `REFRESH_LIFETIME_MS` de
  // `sign-in.ts`, en segundos.
  const PATIENT_SECONDS = 30 * 24 * 3600;
  const PRACTITIONER_SECONDS = 12 * 3600;

  const refresh = (oldHash: string, newHash: string) =>
    read<Rotation>(
      ctxAnonymous,
      `select verdict, role, practitioner_role, permissions, account_status, password_is_temporary,
              license_declared, first_day_done, graced, refresh_expires_at
         from medskin_session_refresh($1, $2, $3, $4)`,
      [oldHash, newHash, PATIENT_SECONDS, PRACTITIONER_SECONDS],
    );

  // La sesión de la paciente la revocó el reenvío de los casos de la 0017, que es
  // justamente lo que la 0020 añade. Se revive aquí para poder medir SU rotación: las dos
  // cosas se prueban, pero no en la misma fila al mismo tiempo.
  beforeAll(async () => {
    await owner.query(
      'update session set revoked_at = null, revoked_reason = null where id = $1',
      [USED.session],
    );
  });

  it('la doctora recibe el rol de su consulta, si declaró su matrícula y su primer día', async () => {
    const [rotated] = await refresh(DOCTOR.refresh, '1'.repeat(64));
    // La caducidad sale aparte: la mide el caso de la 0020, aquí solo tiene que venir.
    const { refresh_expires_at: expiry, ...facts } = rotated ?? {};
    expect(expiry).toBeInstanceOf(Date);
    expect(facts).toEqual({
      verdict: 'rotated',
      // `role` es `account.role` y se queda como estaba: el rol de autenticación. El del
      // token sale de `practitioner_role`, que es lo que faltaba.
      role: 'doctor',
      practitioner_role: 'doctor',
      // Nulo es «los de su rol» (decisión 11), que es el 100 % de las filas de hoy.
      permissions: null,
      account_status: 'activa',
      password_is_temporary: false,
      // «¿Declaró su matrícula?», y NO su estado: la revisión manual se fue con la 0072 y la
      // función devuelve `license_number IS NOT NULL` (migración 0073). La semilla no declaró
      // nada, así que `false`, y de ahí sale `siguiente_paso: 'licencia'`.
      license_declared: false,
      first_day_done: false,
      graced: false,
    });
  });

  it('el primer día cerrado por ella también es primer día terminado', async () => {
    await owner.query('update practice set first_day_dismissed = true where id = $1', [DOCTOR.practice]);
    const [rotated] = await refresh('1'.repeat(64), '2'.repeat(64));
    expect(rotated?.first_day_done).toBe(true);
    await owner.query('update practice set first_day_dismissed = false where id = $1', [DOCTOR.practice]);
  });

  it('el refresco anterior dentro de los 20 s rota otra vez, sin revocar y sin alarma', async () => {
    // El que llega es el ANTERIOR —la prueba de arriba dejó vigente el '2' y anterior el
    // '1'—, que es lo que hace un cliente que no vio la respuesta y reintenta con el
    // refresco que tenía guardado.
    const used = '1'.repeat(64);
    const [graced] = await refresh(used, '3'.repeat(64));
    expect(graced?.verdict).toBe('rotated');
    expect(graced?.graced).toBe(true);
    expect(graced?.practitioner_role).toBe('doctor');

    // La ventana NO se desliza y el anterior se queda donde está: por eso el mismo
    // reintento vuelve a entrar —tres peticiones en paralelo con el refresco guardado— y
    // por eso una cadena de reintentos no puede estirar la gracia.
    const { rows } = await owner.query<{ previous: string; rotated_at: Date; revoked: Date | null }>(
      'select previous_refresh_hash as previous, refresh_rotated_at as rotated_at, revoked_at as revoked from session where id = $1',
      [DOCTOR.session],
    );
    expect(rows[0]?.previous).toBe(used);
    expect(rows[0]?.revoked).toBeNull();
    const anchor = rows[0]?.rotated_at;

    const [again] = await refresh(used, '4'.repeat(64));
    expect({ verdict: again?.verdict, graced: again?.graced }).toEqual({ verdict: 'rotated', graced: true });
    const { rows: after } = await owner.query<{ rotated_at: Date }>(
      'select refresh_rotated_at as rotated_at from session where id = $1',
      [DOCTOR.session],
    );
    expect(after[0]?.rotated_at).toEqual(anchor);
  });

  it('el par que quedó superado es `invalid`, que no es alarma ni revoca a nadie', async () => {
    // Consecuencia (b) de la migración: la respuesta que la app no guardó. `invalid` es el
    // `401 refresco_no_valido` —borra lo local y vuelve a entrar—, no el reuso.
    expect((await refresh('3'.repeat(64), '5'.repeat(64)))[0]?.verdict).toBe('invalid');
    const { rows } = await owner.query<{ revoked: Date | null }>('select revoked_at as revoked from session where id = $1', [
      DOCTOR.session,
    ]);
    expect(rows[0]?.revoked).toBeNull();
  });

  it('fuera de la ventana el anterior sigue siendo reuso, y revoca la sesión entera', async () => {
    // 21 segundos atrás: la gracia es de 20 y la detección de reuso es la de siempre.
    await owner.query(
      `update session set refresh_rotated_at = now() - interval '21 seconds' where id = $1`,
      [DOCTOR.session],
    );
    // El mismo refresco anterior de la gracia, ya fuera de la ventana.
    const [reused] = await refresh('1'.repeat(64), '6'.repeat(64));
    expect({ verdict: reused?.verdict, graced: reused?.graced }).toEqual({ verdict: 'reused', graced: false });
    const { rows } = await owner.query<{ reason: string | null }>(
      'select revoked_reason as reason from session where id = $1',
      [DOCTOR.session],
    );
    expect(rows[0]?.reason).toBe('refresh_reused');
  });

  it('para una paciente no hay consulta que mirar: licencia nula y primer día terminado', async () => {
    const [rotated] = await refresh(USED.refresh, '7'.repeat(64));
    const { refresh_expires_at: expiry, ...facts } = rotated ?? {};
    expect(expiry).toBeInstanceOf(Date);
    expect(facts).toEqual({
      verdict: 'rotated',
      role: 'patient',
      practitioner_role: null,
      permissions: null,
      account_status: 'activa',
      // Sigue con la temporal: entró con ella y no eligió la definitiva, que es el caso
      // que `siguiente_paso: contrasena_nueva` cubre.
      password_is_temporary: true,
      // Sin consulta no hay fila de licencia que mirar: el `LEFT JOIN` no trae nada y el
      // campo es `false`. No manda a ninguna pantalla porque `role === 'patient'` sale antes
      // en `resolveNextStep()`.
      license_declared: false,
      first_day_done: true,
      graced: false,
    });
  });

  it('la caducidad la pone la función con el rol, en la misma transacción que rota (0020)', async () => {
    // La paciente acaba de rotar en el caso de arriba: 30 días, sin una segunda
    // transacción que los alargue.
    const { rows: patient } = await owner.query<{ seconds: string }>(
      'select extract(epoch from (refresh_expires_at - now())) as seconds from session where id = $1',
      [USED.session],
    );
    expect(Number(patient[0]?.seconds)).toBeGreaterThan(29.9 * 24 * 3600);

    // Y la doctora, 12 h con el mismo par de argumentos: lo que las reparte es el rol que
    // la función ya sabe.
    await owner.query(
      `update session set revoked_at = null, revoked_reason = null, refresh_hash = $2,
              refresh_rotated_at = now() - interval '1 hour'
        where id = $1`,
      [DOCTOR.session, '8'.repeat(64)],
    );
    const [rotated] = await refresh('8'.repeat(64), '9'.repeat(64));
    expect(rotated?.verdict).toBe('rotated');
    const { rows: doctor } = await owner.query<{ seconds: string }>(
      'select extract(epoch from (refresh_expires_at - now())) as seconds from session where id = $1',
      [DOCTOR.session],
    );
    expect(Number(doctor[0]?.seconds)).toBeGreaterThan(11.9 * 3600);
    expect(Number(doctor[0]?.seconds)).toBeLessThan(12.1 * 3600);
  });

  it('intercambiar las dos vidas revienta, en vez de regalarle 30 días a una doctora', async () => {
    // La cota es lo que convierte un error de llamada en un fallo a gritos: sin ella, los
    // argumentos al revés le darían a la doctora un refresco de 30 días y nadie se
    // enteraría (§13).
    await expect(
      read(ctxAnonymous, `select verdict from medskin_session_refresh($1, $2, $3, $4)`, [
        '9'.repeat(64),
        'a1'.repeat(32),
        PRACTITIONER_SECONDS,
        PATIENT_SECONDS,
      ]),
    ).rejects.toThrow(/vida del refresco de doctora esta fuera de rango/);
  });
});
