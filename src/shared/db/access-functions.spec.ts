// La prueba de aislamiento de lo que añade la 0002: el cuarto rol, las once funciones
// `SECURITY DEFINER` del acceso, `session` por columnas para la consola y el salto de
// estado de la licencia.
//
// Hermana de `isolation.spec.ts` y con las mismas reglas: contra la base real en Docker,
// sin un solo doble, y en ningún momento se desactiva RLS. Siembra el DUEÑO del esquema,
// que es quien migra; todo lo que se COMPRUEBA pasa por los cuatro roles de aplicación y
// por `withTenantContext()`.
//
// Archivo aparte y no dentro del otro por una razón práctica: aquel prueba el aislamiento
// por inquilino de las diez tablas de la 0000 y su siembra está hecha para eso. Este prueba
// la frontera de las funciones, que es por firma y no por fila, y necesita su propia
// siembra —códigos de recuperación vivos, refrescos rotables, una licencia a medio llenar—.

import { Pool, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantContext, type TenantContext } from './tenant-context';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ?? 'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

// Hashes con la forma que las funciones exigen (`$argon2id$…`) y que nadie puede abrir:
// son de contraseñas aleatorias que no se guardaron. Aquí no se verifica ninguna
// contraseña —eso es de Node y de `backend-senior`—, solo se mueve el hash de un lado a
// otro, que es lo que la base hace.
const HASH = '$argon2id$v=19$m=65536,p=4,t=3$c2VtaWxsYWRlcHJ1ZWJh$BcVqHhiTZ4RrQZ4kYgVvxCuUAneDdfTxZ6qz6hUwcLY';
const NEW_HASH = '$argon2id$v=19$m=65536,p=4,t=3$b3RyYXNlbWlsbGFhcQ$GVnsaFqlkimVX8dDYgVvxCuUAneDdfTxZ6qz6hUwcLY';
const RECOVERED_HASH = '$argon2id$v=19$m=65536,p=4,t=3$dGVyY2VyYXNlbWlsbGE$QZ4kYgVvxCuUAneDdfTxZ6qz6hUwcLYBcVqHhiTZ4Rr';
// Los refrescos no son Argon2id: son resúmenes deterministas, porque hay un índice único
// sobre la columna y un hash con sal nueva en cada cálculo no se podría buscar.
const REFRESH = 'f'.repeat(64);
const ROTATED_REFRESH = 'a'.repeat(64);

const A = {
  practice: 'eeeeeeee-0000-4000-8000-00000000000a',
  license: 'eeeeeeee-0000-4000-8000-00000000001a',
  practitioner: 'eeeeeeee-0000-4000-8000-00000000002a',
  account: 'eeeeeeee-0000-4000-8000-00000000003a',
  session: 'eeeeeeee-0000-4000-8000-00000000004a',
  // Recepción de la consulta A: tiene `practice_id` pero NO es la dueña.
  teamAccount: 'eeeeeeee-0000-4000-8000-00000000005a',
  email: 'duena.a@funciones.local',
  teamEmail: 'recepcion.a@funciones.local',
};
const B = {
  practice: 'eeeeeeee-0000-4000-8000-00000000000b',
  license: 'eeeeeeee-0000-4000-8000-00000000001b',
  practitioner: 'eeeeeeee-0000-4000-8000-00000000002b',
  account: 'eeeeeeee-0000-4000-8000-00000000003b',
  session: 'eeeeeeee-0000-4000-8000-00000000004b',
  email: 'duena.b@funciones.local',
};
const PATIENT = {
  account: 'eeeeeeee-0000-4000-8000-00000000000c',
  session: 'eeeeeeee-0000-4000-8000-00000000001c',
  otherPhoneSession: 'eeeeeeee-0000-4000-8000-00000000002c',
  code: 'eeeeeeee-0000-4000-8000-00000000003c',
  email: 'paciente@funciones.local',
};
const PLATFORM = { account: 'eeeeeeee-0000-4000-8000-00000000000d' };
const EMAIL_THAT_DOES_NOT_EXIST = 'nadie.en.absoluto@funciones.local';
const NEW_EMAIL = 'valeria.nueva@funciones.local';
const OWNER_EMAIL = 'andrea.nueva@funciones.local';

const ctxPractitionerA: TenantContext = { role: 'app_practitioner', practiceId: A.practice, accountId: A.account };
const ctxTeamA: TenantContext = { role: 'app_practitioner', practiceId: A.practice, accountId: A.teamAccount };
const ctxPractitionerB: TenantContext = { role: 'app_practitioner', practiceId: B.practice, accountId: B.account };
const ctxPatient: TenantContext = { role: 'app_patient', accountId: PATIENT.account };
const ctxPlatform: TenantContext = { role: 'app_platform', accountId: PLATFORM.account };
// El rol sin sesión: ni inquilino ni cuenta. No hay nada que fijar porque todavía no se
// sabe quién llama, y eso es el punto.
const ctxAnonymous: TenantContext = { role: 'app_anonymous' };

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 1 });

async function seed() {
  await clean();

  const practice = async (t: typeof A | typeof B, name: string, licenseComplete: boolean) => {
    await owner.query(
      `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit)
       values ($1, $2, 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300)`,
      [t.practice, name],
    );
    await owner.query(
      `insert into account (id, email, role, region, first_name, last_name)
       values ($1, $2, 'practitioner', 'latam', 'Andrea', 'Paz')`,
      [t.account, t.email],
    );
    await owner.query(
      `insert into credential (account_id, hash, is_temporary, set_at) values ($1, $2, false, now())`,
      [t.account, HASH],
    );
    await owner.query(
      `insert into practitioner (id, practice_id, account_id, first_name, last_name, role)
       values ($1, $2, $3, 'Andrea', 'Paz', 'doctora')`,
      [t.practitioner, t.practice, t.account],
    );
    await owner.query('update practice set owner_account_id = $1 where id = $2', [t.account, t.practice]);
    // La licencia de A está llena y lista para enviarse; la de B, a medias, que es el
    // caso del «Guardar y salir» de `Licencia.dc.html` · 1.
    await owner.query(
      `insert into license (id, practice_id, status, practice_country, specialty, license_number,
                            credential_key, declaration_accepted, terms_accepted)
       values ($1, $2, 'sin_enviar', 'BO', 'medicina_estetica', $3, $4, $5, $5)`,
      [
        t.license,
        t.practice,
        licenseComplete ? '48921' : null,
        licenseComplete ? 'lic/x.pdf' : null,
        licenseComplete,
      ],
    );
    await owner.query(
      `insert into session (id, account_id, practice_id, scope, device_id, device, os,
                            app_version, platform, city)
       values ($1, $2, $3, 'completo', 'disp-1', 'iPhone 15 Pro', 'iOS 18.2', '2.4.1', 'ios', 'Santa Cruz')`,
      [t.session, t.account, t.practice],
    );
  };

  await practice(A, 'Consulta A de funciones', true);
  await practice(B, 'Consulta B de funciones', false);

  // Recepción de A: su cuenta y su fila de equipo, para probar que la licencia la envía la
  // dueña y nadie más.
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'practitioner', 'latam', 'Rosa', 'Mamani')`,
    [A.teamAccount, A.teamEmail],
  );
  await owner.query(
    `insert into practitioner (practice_id, account_id, first_name, last_name, role, permissions)
     values ($1, $2, 'Rosa', 'Mamani', 'recepcion', $3)`,
    [A.practice, A.teamAccount, ['pacientes:leer', 'agenda:editar']],
  );

  // La paciente: dos sesiones (dos teléfonos), un código de recuperación vivo y una
  // credencial TEMPORAL sin consumir, que es lo que `contrasena-nueva` va a consumir.
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'paciente', 'latam', 'Valeria', 'Antelo')`,
    [PATIENT.account, PATIENT.email],
  );
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, temp_expires_at)
     values ($1, $2, true, now() + interval '72 hours')`,
    [PATIENT.account, HASH],
  );
  await owner.query(
    `insert into session (id, account_id, scope, device_id, app_version, platform,
                          refresh_hash, refresh_expires_at)
     values ($1, $2, 'completo', 'disp-paciente', '2.4.1', 'ios', $3, now() + interval '30 days')`,
    [PATIENT.session, PATIENT.account, REFRESH],
  );
  await owner.query(
    `insert into session (id, account_id, scope, device_id, app_version, platform)
     values ($1, $2, 'completo', 'disp-paciente-2', '2.4.0', 'android')`,
    [PATIENT.otherPhoneSession, PATIENT.account],
  );
  await owner.query(
    `insert into recovery_code (id, account_id, code_hash, expires_at)
     values ($1, $2, $3, now() + interval '10 minutes')`,
    [PATIENT.code, PATIENT.account, HASH],
  );
}

async function clean() {
  await owner.query('delete from practice where id = any($1::uuid[])', [[A.practice, B.practice]]);
  await owner.query('delete from account where email = any($1::citext[])', [
    [A.email, A.teamEmail, B.email, PATIENT.email, NEW_EMAIL, OWNER_EMAIL],
  ]);
  await owner.query('delete from access_audit where practice_id = any($1::uuid[])', [[A.practice, B.practice]]);
}

function read<T extends QueryResultRow = Record<string, string>>(
  pool: Pool,
  ctx: TenantContext,
  sql: string,
  params: unknown[] = [],
) {
  return withTenantContext(pool, ctx, async (client) => (await client.query<T>(sql, params)).rows);
}

/**
 * «No lee nada» tiene dos formas y las dos valen: cero filas porque la política las filtró,
 * o permiso denegado porque no hay ni grant. La segunda es la más fuerte, y es la única que
 * `app_anonymous` puede dar: no hay consulta que escribir.
 */
async function whatItSees(pool: Pool, ctx: TenantContext, sql: string, params: unknown[] = []) {
  try {
    return `${(await read(pool, ctx, sql, params)).length} filas`;
  } catch (failure) {
    if ((failure as { code?: string }).code === '42501') return 'permiso denegado';
    throw failure;
  }
}

beforeAll(seed, 30_000);
afterAll(async () => {
  await clean();
  await Promise.all([owner.end(), app.end()]);
});

describe('app_anonymous · el rol de las peticiones sin sesión', () => {
  it('no tiene un solo privilegio de tabla, ni de columna, en ninguna tabla', async () => {
    // La forma fuerte de la prueba: no se enumeran las tablas de hoy, se le pregunta al
    // catálogo. El día que llegue `patient` con el tramo 2, esta comprobación ya la cubre.
    const { rows: tables } = await owner.query<{ n: string }>(
      `select count(*)::text as n from information_schema.table_privileges where grantee = 'app_anonymous'`,
    );
    const { rows: columns } = await owner.query<{ n: string }>(
      `select count(*)::text as n from information_schema.column_privileges where grantee = 'app_anonymous'`,
    );
    // Y tampoco por la puerta de atrás: sin BYPASSRLS, sin SUPERUSER y sin LOGIN.
    const { rows: attributes } = await owner.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolinherit: boolean;
    }>(`select rolsuper, rolbypassrls, rolcanlogin, rolinherit from pg_roles where rolname = 'app_anonymous'`);

    expect({ tables: tables[0]?.n, columns: columns[0]?.n, attributes: attributes[0] }).toEqual({
      tables: '0',
      columns: '0',
      attributes: { rolsuper: false, rolbypassrls: false, rolcanlogin: false, rolinherit: false },
    });
  });

  it('no lee ni una fila de account, credential, session ni de ninguna otra, por mucho que se intente', async () => {
    // Trece maneras de intentarlo, incluidas las que un programador escribiría sin pensar.
    expect({
      account: await whatItSees(app, ctxAnonymous, 'select id from account'),
      account_by_email: await whatItSees(app, ctxAnonymous, 'select id from account where email = $1', [
        PATIENT.email,
      ]),
      account_count: await whatItSees(app, ctxAnonymous, 'select count(*) from account'),
      account_exists: await whatItSees(app, ctxAnonymous, 'select exists (select 1 from account where email = $1)', [
        PATIENT.email,
      ]),
      credential: await whatItSees(app, ctxAnonymous, 'select hash from credential'),
      session: await whatItSees(app, ctxAnonymous, 'select id from session'),
      recovery_code: await whatItSees(app, ctxAnonymous, 'select id from recovery_code'),
      practice: await whatItSees(app, ctxAnonymous, 'select id from practice'),
      practitioner: await whatItSees(app, ctxAnonymous, 'select id from practitioner'),
      license: await whatItSees(app, ctxAnonymous, 'select id from license'),
      // El señuelo tampoco: es la otra mitad de la promesa del «mismo tiempo».
      access_decoy: await whatItSees(app, ctxAnonymous, 'select hash from access_decoy'),
      // Y no puede escribir en ningún sitio, ni en la bitácora.
      insert_account: await whatItSees(
        app,
        ctxAnonymous,
        `insert into account (email, role, region, first_name, last_name)
         values ('colado@funciones.local', 'paciente', 'latam', 'X', 'Y')`,
      ),
      insert_audit: await whatItSees(app, ctxAnonymous, `insert into access_audit (action) values ('inventada')`),
    }).toEqual({
      account: 'permiso denegado',
      account_by_email: 'permiso denegado',
      account_count: 'permiso denegado',
      account_exists: 'permiso denegado',
      credential: 'permiso denegado',
      session: 'permiso denegado',
      recovery_code: 'permiso denegado',
      practice: 'permiso denegado',
      practitioner: 'permiso denegado',
      license: 'permiso denegado',
      access_decoy: 'permiso denegado',
      insert_account: 'permiso denegado',
      insert_audit: 'permiso denegado',
    });
  });

  it('solo ejecuta las funciones del acceso, y las demás no las ve ni él ni los otros roles', async () => {
    const canRun = async (ctx: TenantContext, sql: string, params: unknown[] = []) => {
      try {
        await read(app, ctx, sql, params);
        return 'ejecuta';
      } catch (failure) {
        return (failure as { code?: string }).code === '42501' ? 'permiso denegado' : `otro: ${String(failure)}`;
      }
    };

    expect({
      // Lo suyo: las del acceso sin sesión.
      credential: await canRun(ctxAnonymous, 'select * from medskin_access_credential($1)', [PATIENT.email]),
      refresh: await canRun(
        ctxAnonymous,
        `select * from medskin_session_refresh($1, $2, now() + '30 days'::interval)`,
        ['z'.repeat(64), 'y'.repeat(64)],
      ),
      // Lo que no es suyo: guardar una contraseña, crear una paciente, mover una licencia.
      password: await canRun(ctxAnonymous, 'select * from medskin_set_final_password($1, $2, null)', [
        NEW_HASH,
        'temporal',
      ]),
      create_patient: await canRun(
        ctxAnonymous,
        `select * from medskin_create_patient_account($1, $2, $3, null, $4, now() + '72 hours'::interval)`,
        [NEW_EMAIL, 'Valeria', 'Antelo', HASH],
      ),
      license: await canRun(ctxAnonymous, `select * from medskin_license_to_review(now() + '2 days'::interval)`),
      // Y la de verificar credenciales NO la puede llamar la doctora: si pudiera, tendría
      // el oráculo del padrón de otra clínica que `app_anonymous` existe para cerrar.
      credential_as_practitioner: await canRun(ctxPractitionerA, 'select * from medskin_access_credential($1)', [
        PATIENT.email,
      ]),
      credential_as_platform: await canRun(ctxPlatform, 'select * from medskin_access_credential($1)', [
        PATIENT.email,
      ]),
      // Y la del alta de inquilino no la puede llamar la doctora.
      owner_as_practitioner: await canRun(
        ctxPractitionerA,
        `select * from medskin_create_practice_owner($1, $2, $3, $4, $5, now() + '72 hours'::interval)`,
        [B.practice, NEW_EMAIL, 'X', 'Y', HASH],
      ),
    }).toEqual({
      credential: 'ejecuta',
      refresh: 'ejecuta',
      password: 'permiso denegado',
      create_patient: 'permiso denegado',
      license: 'permiso denegado',
      credential_as_practitioner: 'permiso denegado',
      credential_as_platform: 'permiso denegado',
      owner_as_practitioner: 'permiso denegado',
    });
  });

  it('el ayudante no le deja fijar contexto, y dentro de la transacción los dos están vacíos', async () => {
    await expect(
      withTenantContext(app, { role: 'app_anonymous', accountId: PATIENT.account }, () => Promise.resolve(null)),
    ).rejects.toThrow(/app_anonymous no fija ningún contexto/);
    await expect(
      withTenantContext(app, { role: 'app_anonymous', practiceId: A.practice }, () => Promise.resolve(null)),
    ).rejects.toThrow(/app_anonymous no fija ningún contexto/);

    const [row] = await read(
      app,
      ctxAnonymous,
      `select current_user as role,
              coalesce(current_setting('medskin.practice_id', true), '') as practice,
              coalesce(current_setting('medskin.account_id', true), '') as account`,
    );
    expect(row).toEqual({ role: 'app_anonymous', practice: '', account: '' });
  });

  it('el camino del correo que no existe es el mismo que el de la contraseña mal', async () => {
    type Verdict = {
      account_id: string | null;
      role: string | null;
      hash: string;
      practice_id: string | null;
      practitioner_role: string | null;
      attempts_left: number;
    };
    const verify = (email: string) =>
      read<Verdict>(app, ctxAnonymous, 'select * from medskin_access_credential($1)', [email]);

    const exists = await verify(PATIENT.email);
    const missing = await verify(EMAIL_THAT_DOES_NOT_EXIST);
    const alsoMissing = await verify('otro.fantasma@funciones.local');
    const practitioner = await verify(A.email);
    // Y da igual cómo se escriba: `email` es citext, y el parámetro de la función también.
    // Con un parámetro `text` esto fallaría, y es el motivo de que esté declarado citext.
    const uppercase = await verify(PATIENT.email.toUpperCase());

    // 1 · SIEMPRE una fila, y SIEMPRE un hash que verificar. No hay forma de saltarse el
    // Argon2id, que es lo que se mediría con un cronómetro.
    expect([exists.length, missing.length, alsoMissing.length, uppercase.length]).toEqual([1, 1, 1, 1]);
    for (const [which, row] of [
      ['exists', exists[0]],
      ['missing', missing[0]],
      ['alsoMissing', alsoMissing[0]],
    ] as const) {
      expect(row?.hash, which).toMatch(/^\$argon2id\$/);
    }

    // 2 · Los dos correos inexistentes reciben el MISMO señuelo, y no es el hash de nadie.
    expect(missing[0]?.hash).toBe(alsoMissing[0]?.hash);
    expect(missing[0]?.hash).not.toBe(exists[0]?.hash);
    expect(missing[0]?.account_id).toBeNull();

    // 3 · Para una cuenta que existe viaja lo que el endpoint necesita para decidir, y el
    // mismo veredicto escriba el correo como lo escriba.
    expect(uppercase[0]).toEqual(exists[0]);
    expect({
      account_id: exists[0]?.account_id,
      role: exists[0]?.role,
      practice_id: exists[0]?.practice_id,
      attempts: exists[0]?.attempts_left,
    }).toEqual({ account_id: PATIENT.account, role: 'paciente', practice_id: null, attempts: 5 });

    // 4 · La doctora trae su consulta y su rol de equipo, que es lo que `POST /v1/acceso`
    // no puede averiguar después: con `app_practitioner` ya haría falta el `practice_id`.
    expect({
      practice: practitioner[0]?.practice_id,
      role: practitioner[0]?.practitioner_role,
    }).toEqual({ practice: A.practice, role: 'doctora' });
  });

  it('la pausa cuenta hasta cinco y se limpia al entrar bien', async () => {
    const attempt = (email: string, success: boolean) =>
      read<{ attempts_left: number; locked_until: string | null }>(
        app,
        ctxAnonymous,
        'select * from medskin_access_attempt($1, $2)',
        [email, success],
      );

    const left: number[] = [];
    let lockedUntil: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const [row] = await attempt(PATIENT.email, false);
      left.push(row!.attempts_left);
      lockedUntil = row!.locked_until;
    }
    expect(left).toEqual([4, 3, 2, 1, 0]);
    expect(lockedUntil).not.toBeNull();

    // El contador vuelve a cero al llegar a la pausa: si no, pasada la pausa el sexto
    // intento dispararía otra y la cuenta quedaría sellada para siempre.
    const [after] = await attempt(PATIENT.email, true);
    expect({ left: after?.attempts_left, locked: after?.locked_until }).toEqual({ left: 5, locked: null });

    // Un correo que no existe no deja rastro en ninguna fila: el contador que hace idéntica
    // su respuesta es el de Redis, por correo y por IP.
    const [ghost] = await attempt(EMAIL_THAT_DOES_NOT_EXIST, false);
    expect(ghost).toEqual({ attempts_left: 5, locked_until: null });

    // Y la entrada que salió bien dejó marcada la PRIMERA vez que se usó la temporal, que
    // es lo que habilita la recuperación por correo. Sigue sin consumirse: el consumo es
    // al guardar la definitiva (decisión 2), y son dos columnas distintas a propósito.
    // Se lee por el dueño a propósito: `temp_first_used_at` NO se le concede a ningún rol
    // de aplicación. Quien la necesita la recibe por `medskin_access_credential()` y por
    // `medskin_current_credential()`, que es toda la superficie que hace falta.
    const marks = await owner
      .query<{ first_used: string | null; used: string | null; temporary: boolean }>(
        `select temp_first_used_at::text as first_used, temp_used_at::text as used,
                is_temporary as temporary
           from credential where account_id = $1`,
        [PATIENT.account],
      )
      .then((r) => r.rows);
    const firstMark = marks[0]?.first_used;
    expect(await whatItSees(app, ctxPatient, 'select temp_first_used_at from credential')).toBe('permiso denegado');
    expect({
      first_used: marks[0]?.first_used !== null,
      used: marks[0]?.used,
      temporary: marks[0]?.temporary,
    }).toEqual({ first_used: true, used: null, temporary: true });

    // Y no se mueve en cada entrada: la primera vez es la primera vez.
    await attempt(PATIENT.email, true);
    // Como cadena ISO y no como objeto: `pg` sin el `mode: 'string'` de drizzle devuelve
    // `Date`, y dos `Date` del mismo instante no son el mismo objeto.
    const again = await owner
      .query<{ first_used: string }>(
        'select temp_first_used_at::text as first_used from credential where account_id = $1',
        [PATIENT.account],
      )
      .then((r) => r.rows);
    expect(again[0]?.first_used).toBe(firstMark);
  });
});

describe('la consola · session por columnas y el vínculo con la dueña', () => {
  it('lee cinco columnas de session y ninguna otra, ni por un WHERE', async () => {
    // Las CINCO de la consola: las tres de la decisión 5 más `revoked_at` y `platform`,
    // que son las que hacen posible «sesiones activas» y «versiones_app: {ios, android}»
    // (decidido el 27 de octubre al cerrar la pregunta 14; migración 0003).
    const five = await read(
      app,
      ctxPlatform,
      `select account_id, app_version, last_seen_at, revoked_at, platform
         from session where account_id = $1`,
      [PATIENT.account],
    );
    expect(five.length).toBe(2);

    // Y se para ahí. Se comprueba contra el CATÁLOGO, no contra la lista de abajo: si
    // alguien concede `city` o `device` mañana, esto falla aunque no toque esta prueba.
    const granted = await owner
      .query<{ column_name: string }>(
        `select column_name from information_schema.column_privileges
          where grantee = 'app_platform' and table_name = 'session' order by column_name`,
      )
      .then((r) => r.rows.map((c) => c.column_name));
    expect(granted).toEqual(['account_id', 'app_version', 'last_seen_at', 'platform', 'revoked_at']);

    // Y las trece que no. «Desde qué teléfono y desde qué ciudad entró» es un dato de
    // localización de quien va a una clínica de estética, y la pantalla promete que no se
    // lee: cuántas, no cuáles. No es un filtro en el código del endpoint, es un grant que
    // no existe.
    const closed = [
      'id',
      'practice_id',
      'scope',
      'refresh_hash',
      'refresh_expires_at',
      'refresh_rotated_at',
      'previous_refresh_hash',
      'revoked_reason',
      'device_id',
      'device',
      'os',
      'city',
      'signed_in_at',
    ];
    const perColumn: Record<string, string> = {};
    for (const column of closed) {
      perColumn[column] = await whatItSees(app, ctxPlatform, `select ${column} from session`);
    }
    expect(perColumn).toEqual(Object.fromEntries(closed.map((c) => [c, 'permiso denegado'])));

    expect({
      star: await whatItSees(app, ctxPlatform, 'select * from session'),
      // Tampoco por un WHERE sobre una columna que no se le concedió: la cláusula también
      // se comprueba, así que no se puede filtrar por ciudad para adivinarla.
      where_city: await whatItSees(app, ctxPlatform, `select account_id from session where city = 'Santa Cruz'`),
      // Ni cerrar sesiones: `revoked_at` se LEE, y su política sigue siendo solo de SELECT.
      closes: await whatItSees(app, ctxPlatform, 'update session set revoked_at = now() where account_id = $1', [
        PATIENT.account,
      ]),
    }).toEqual({ star: 'permiso denegado', where_city: 'permiso denegado', closes: 'permiso denegado' });
  });

  it('cuenta las sesiones de la dueña llegando por practice.owner_account_id', async () => {
    // Es la consulta de `GET /v1/plataforma/inquilinos/{id}`: de la consulta a su dueña, y
    // de su dueña al recuento. Sin tocar `practitioner`, que la consola no tiene.
    const [row] = await read<{ owner: string; sessions: string }>(
      app,
      ctxPlatform,
      `select p.owner_account_id as owner,
              (select count(*)::text from session s where s.account_id = p.owner_account_id) as sessions
         from practice p where p.id = $1`,
      [A.practice],
    );
    expect(row).toEqual({ owner: A.account, sessions: '1' });

    // Y los dos campos que la pantalla pinta, que son los que la 0003 hizo posibles:
    // «sesiones_activas» por `revoked_at IS NULL`, y `versiones_app` separado por sistema.
    const [active] = await read<{ n: string }>(
      app,
      ctxPlatform,
      `select count(*)::text as n from session
        where account_id = $1 and revoked_at is null`,
      [A.account],
    );
    expect(active?.n).toBe('1');

    const byOs = await read<{ platform: string; app_version: string }>(
      app,
      ctxPlatform,
      `select platform, app_version from session
        where account_id = any($1::uuid[]) and revoked_at is null order by platform`,
      [[A.account, PATIENT.account]],
    );
    expect(byOs).toEqual([
      { platform: 'android', app_version: '2.4.0' },
      { platform: 'ios', app_version: '2.4.1' },
      { platform: 'ios', app_version: '2.4.1' },
    ]);

    // Y sigue sin poder leer `practitioner`: el vínculo está en `practice` justo para no
    // abrirle esa tabla.
    expect(await whatItSees(app, ctxPlatform, 'select id from practitioner')).toBe('permiso denegado');
  });

  it('la doctora ve quién es la dueña de su consulta, y de ninguna otra', async () => {
    const own = await read(app, ctxPractitionerA, 'select owner_account_id from practice');
    expect(own).toEqual([{ owner_account_id: A.account }]);

    expect({
      practice_of_b: await whatItSees(app, ctxPractitionerA, 'select owner_account_id from practice where id = $1', [
        B.practice,
      ]),
      owner_of_b: await whatItSees(app, ctxPractitionerA, 'select id from practice where owner_account_id = $1', [
        B.account,
      ]),
      permissions_of_b: await whatItSees(
        app,
        ctxPractitionerA,
        'select permissions from practitioner where practice_id = $1',
        [B.practice],
      ),
      // Y no se nombra dueña de nada: `owner_account_id` no está en su GRANT de UPDATE.
      names_herself_owner: await whatItSees(
        app,
        ctxPractitionerA,
        'update practice set owner_account_id = $1 where id = $2',
        [A.teamAccount, A.practice],
      ),
    }).toEqual({
      practice_of_b: '0 filas',
      owner_of_b: '0 filas',
      permissions_of_b: '0 filas',
      names_herself_owner: 'permiso denegado',
    });

    // Lo suyo sí: los permisos de su equipo, nulos o explícitos (decisión 11).
    const team = await read<{ role: string; permissions: string[] | null }>(
      app,
      ctxPractitionerA,
      'select role, permissions from practitioner order by role',
    );
    expect(team).toEqual([
      { role: 'doctora', permissions: null },
      { role: 'recepcion', permissions: ['pacientes:leer', 'agenda:editar'] },
    ]);
  });
});

describe('license.status · lo mueve la función, no un grant', () => {
  const toReview = (ctx: TenantContext) =>
    read<{ verdict: string; status: string | null; submitted_at: string | null }>(
      app,
      ctx,
      `select * from medskin_license_to_review(now() + '2 days'::interval)`,
    );

  it('la doctora no mueve el estado por UPDATE directo, ni el suyo ni el de nadie', async () => {
    await expect(
      read(app, ctxPractitionerA, `update license set status = 'verificada' where practice_id = $1`, [A.practice]),
    ).rejects.toMatchObject({ code: '42501' });
    // Ni colándolo entre las columnas que sí puede escribir.
    await expect(
      read(
        app,
        ctxPractitionerA,
        `update license set license_number = '1', status = 'en_revision' where practice_id = $1`,
        [A.practice],
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Las columnas del formulario sí, que es lo que ya estaba concedido.
    const touched = await read(
      app,
      ctxPractitionerA,
      `update license set license_number = '48921' where practice_id = $1`,
      [A.practice],
    );
    expect(touched).toEqual([]);
  });

  it('la función valida la transición, exige ser la dueña y deja la fila de auditoría', async () => {
    // Recepción tiene el mismo `practice_id` y no es la dueña: no la mueve.
    expect((await toReview(ctxTeamA))[0]?.verdict).toBe('not_owner');

    // La dueña de A, con la licencia llena: `sin_enviar` → `en_revision`.
    const [first] = await toReview(ctxPractitionerA);
    expect({ verdict: first?.verdict, status: first?.status }).toEqual({
      verdict: 'submitted',
      status: 'en_revision',
    });
    expect(first?.submitted_at).not.toBeNull();

    // Segunda llamada: ya hay un caso abierto (409 licencia_en_revision).
    expect((await toReview(ctxPractitionerA))[0]?.verdict).toBe('already_in_review');

    // La de B está a medias: no se envía una licencia sin matrícula ni credencial.
    expect((await toReview(ctxPractitionerB))[0]?.verdict).toBe('incomplete');

    // La bitácora quedó, con quién, qué, sobre qué y de qué inquilino.
    const audit = await read<{
      action: string;
      actor: string;
      label: string;
      subject: string;
      data: unknown;
    }>(
      app,
      ctxPractitionerA,
      `select action, actor_account_id as actor, actor_label as label, subject_id as subject, data
         from access_audit where action = 'license.to_review'`,
    );
    expect(audit).toEqual([
      {
        action: 'license.to_review',
        actor: A.account,
        label: 'Andrea Paz',
        subject: A.license,
        data: { previous_status: 'sin_enviar' },
      },
    ]);

    // Y la licencia de B no se movió: la función toma el inquilino del contexto, no de un
    // argumento, así que no hay nada que apuntar a otra consulta.
    const [licenseB] = await read(app, ctxPractitionerB, 'select status from license');
    expect(licenseB).toEqual({ status: 'sin_enviar' });
    // Y A sigue sin ver la de B.
    expect(
      await whatItSees(app, ctxPractitionerA, 'select id from license where practice_id = $1', [B.practice]),
    ).toBe('0 filas');
  });
});

describe('la contraseña definitiva · todo en una transacción', () => {
  it('consume la temporal, anula el código y revoca las demás sesiones', async () => {
    const before = await read(app, ctxPatient, 'select is_temporary, temp_used_at from credential');
    expect(before).toEqual([{ is_temporary: true, temp_used_at: null }]);

    const [verdict] = await read<{ verdict: string; role: string; sessions_revoked: number }>(
      app,
      ctxPatient,
      'select * from medskin_set_final_password($1, $2, $3)',
      [NEW_HASH, 'temporal', PATIENT.session],
    );
    expect({
      verdict: verdict?.verdict,
      role: verdict?.role,
      revoked: verdict?.sessions_revoked,
    }).toEqual({ verdict: 'saved', role: 'paciente', revoked: 1 });

    const [credential] = await read<{ is_temporary: boolean; used: string | null; set: string | null }>(
      app,
      ctxPatient,
      'select is_temporary, temp_used_at as used, set_at as set from credential',
    );
    expect({
      temporary: credential?.is_temporary,
      used: credential?.used !== null,
      set: credential?.set !== null,
    }).toEqual({ temporary: false, used: true, set: true });

    // Se llegó por la temporal, así que el código de recuperación no se toca: la paciente
    // no lo pidió para esto y «pedir el código no invalida nada».
    const [code] = await owner
      .query<{ voided_reason: string | null }>('select voided_reason from recovery_code where id = $1', [PATIENT.code])
      .then((r) => r.rows);
    expect(code?.voided_reason).toBeNull();

    // La sesión que guardó sigue abierta —«Guardar y entrar» es entrar— y la otra no.
    const sessions = await read<{ id: string; revoked: string | null; reason: string | null }>(
      app,
      ctxPatient,
      'select id, revoked_at as revoked, revoked_reason as reason from session order by device_id',
    );
    expect(sessions.map((s) => ({ id: s.id, open: s.revoked === null, reason: s.reason }))).toEqual([
      { id: PATIENT.session, open: true, reason: null },
      { id: PATIENT.otherPhoneSession, open: false, reason: 'password_changed' },
    ]);

    // Y la segunda vez por la temporal ya no: se gastó eligiendo la definitiva. Es el
    // único caso en que salta el `401 contrasena_temporal_ya_usada` (decisión 2).
    const [again] = await read<{ verdict: string }>(
      app,
      ctxPatient,
      'select * from medskin_set_final_password($1, $2, $3)',
      [HASH, 'temporal', PATIENT.session],
    );
    expect(again?.verdict).toBe('already_chosen');

    // Por recuperación sí, porque el código estaba vivo: y ES esta transacción la que lo
    // anula, no la que lo validó.
    const [recovered] = await read<{ verdict: string }>(
      app,
      ctxPatient,
      'select * from medskin_set_final_password($1, $2, $3)',
      [RECOVERED_HASH, 'recuperacion', PATIENT.session],
    );
    expect(recovered?.verdict).toBe('saved');
    const [voided] = await owner
      .query<{ voided_reason: string | null; used: string | null }>(
        'select voided_reason, used_at as used from recovery_code where id = $1',
        [PATIENT.code],
      )
      .then((r) => r.rows);
    expect({ reason: voided?.voided_reason, used: voided?.used !== null }).toEqual({
      reason: 'usado',
      used: true,
    });

    // Y la tercera, por recuperación, ya no tiene código que anular.
    const [noCode] = await read<{ verdict: string }>(
      app,
      ctxPatient,
      'select * from medskin_set_final_password($1, $2, $3)',
      [HASH, 'recuperacion', PATIENT.session],
    );
    expect(noCode?.verdict).toBe('no_code');
  });

  it('nadie puede guardarle la contraseña a otra cuenta: la autorización es el contexto', async () => {
    // La función no recibe `account_id`. Con el contexto de la doctora A, lo único que puede
    // tocar es la credencial de la doctora A, que no es temporal: 'already_chosen'.
    const [row] = await read<{ verdict: string; account_id: string }>(
      app,
      ctxPractitionerA,
      'select * from medskin_set_final_password($1, $2, null)',
      [NEW_HASH, 'temporal'],
    );
    expect({ verdict: row?.verdict, account: row?.account_id }).toEqual({
      verdict: 'already_chosen',
      account: A.account,
    });

    // Y la credencial de la paciente sigue como estaba.
    const [hash] = await owner
      .query<{ hash: string }>('select hash from credential where account_id = $1', [PATIENT.account])
      .then((r) => r.rows);
    expect(hash?.hash).toBe(RECOVERED_HASH);
  });
});

describe('el refresco · rotación de un solo uso', () => {
  it('rota una vez, y el refresco ya usado revoca la sesión entera', async () => {
    const refresh = (oldHash: string, newHash: string) =>
      read<{ verdict: string; session_id: string | null; account_id: string | null; role: string | null }>(
        app,
        ctxAnonymous,
        `select * from medskin_session_refresh($1, $2, now() + '30 days'::interval)`,
        [oldHash, newHash],
      );

    const [rotated] = await refresh(REFRESH, ROTATED_REFRESH);
    expect({ verdict: rotated?.verdict, session: rotated?.session_id, role: rotated?.role }).toEqual({
      verdict: 'rotated',
      session: PATIENT.session,
      role: 'paciente',
    });

    // El mismo otra vez: ya usado. Se revoca la sesión, que ES la familia derivada de ese
    // inicio —cada entrada crea una fila y la rotación la actualiza en su sitio—.
    const [reused] = await refresh(REFRESH, 'b'.repeat(64));
    expect({ verdict: reused?.verdict, session: reused?.session_id }).toEqual({
      verdict: 'reused',
      session: PATIENT.session,
    });

    // Y el rotado ya no sirve tampoco, porque su sesión quedó revocada: 'revoked' y no
    // 'invalid', que son dos frases distintas a propósito.
    expect((await refresh(ROTATED_REFRESH, 'c'.repeat(64)))[0]?.verdict).toBe('revoked');
    // Uno inventado no revoca nada de nadie.
    expect((await refresh('d'.repeat(64), 'e'.repeat(64)))[0]?.verdict).toBe('invalid');
  });
});

describe('el alta de cuentas · lo que cada rol puede crear', () => {
  it('la doctora crea la cuenta de su paciente y no puede apuntar a ninguna otra', async () => {
    const [created] = await read<{ account_id: string; already_existed: boolean; status: string }>(
      app,
      ctxPractitionerA,
      `select * from medskin_create_patient_account($1, $2, $3, $4, $5, now() + '72 hours'::interval)`,
      [NEW_EMAIL, 'Valeria', 'Antelo', '+59177124408', HASH],
    );
    expect({ existed: created?.already_existed, status: created?.status }).toEqual({
      existed: false,
      status: 'activa',
    });

    // Nació con su temporal, su rol y la región de la consulta. Lo comprueba el dueño,
    // porque la doctora no tiene política de lectura sobre la cuenta de su paciente: lo
    // que ve de su acceso lo verá en `patient_link`, del tramo 2.
    const [row] = await owner
      .query<{ role: string; region: string; temporary: boolean }>(
        `select a.role, a.region, c.is_temporary as temporary
           from account a join credential c on c.account_id = a.id where a.id = $1`,
        [created!.account_id],
      )
      .then((r) => r.rows);
    expect(row).toEqual({ role: 'paciente', region: 'latam', temporary: true });

    // Un correo que ya tiene cuenta se REUSA y no se le acuña contraseña ninguna: ya tiene
    // la suya. Es lo único que la respuesta revela de su existencia.
    const [repeated] = await read<{ account_id: string; already_existed: boolean }>(
      app,
      ctxPractitionerA,
      `select * from medskin_create_patient_account($1, $2, $3, null, $4, now() + '72 hours'::interval)`,
      [PATIENT.email, 'Valeria', 'Antelo', HASH],
    );
    expect({ id: repeated?.account_id, existed: repeated?.already_existed }).toEqual({
      id: PATIENT.account,
      existed: true,
    });
    // Y su contraseña no se tocó: la doctora no puede resetear la de una paciente que ya
    // eligió la suya, ni por este camino ni por ninguno.
    const [untouched] = await owner
      .query<{ hash: string }>('select hash from credential where account_id = $1', [PATIENT.account])
      .then((r) => r.rows);
    expect(untouched?.hash).toBe(RECOVERED_HASH);
  });

  it('la plataforma crea la dueña de una consulta, y solo si no tiene una', async () => {
    const create = (practiceId: string, email: string) =>
      read<{ verdict: string; account_id: string | null }>(
        app,
        ctxPlatform,
        `select * from medskin_create_practice_owner($1, $2, $3, $4, $5, now() + '72 hours'::interval)`,
        [practiceId, email, 'Andrea', 'Paz', HASH],
      );

    expect((await create(A.practice, 'otra.duena@funciones.local'))[0]).toEqual({
      verdict: 'practice_has_owner',
      account_id: A.account,
    });
    expect((await create('eeeeeeee-0000-4000-8000-0000000000ff', 'nadie@funciones.local'))[0]?.verdict).toBe(
      'practice_not_found',
    );

    // Una consulta de verdad sin dueña: el alta es un solo acto, con `practitioner` y
    // `practice.owner_account_id` incluidos, que es lo que `app_platform` NO puede hacer
    // por grant.
    const ownerless = 'eeeeeeee-0000-4000-8000-0000000000fe';
    await owner.query(
      `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit)
       values ($1, 'Consulta sin duena', 'latam', 'BO', 'America/La_Paz', 'BOB', 'individual', 100)`,
      [ownerless],
    );
    try {
      const [made] = await create(ownerless, OWNER_EMAIL);
      expect(made?.verdict).toBe('created');

      const [built] = await owner
        .query<{ owner: string; role: string; temporary: boolean }>(
          `select p.owner_account_id as owner, pr.role, c.is_temporary as temporary
             from practice p
             join practitioner pr on pr.practice_id = p.id
             join credential c on c.account_id = pr.account_id
            where p.id = $1`,
          [ownerless],
        )
        .then((r) => r.rows);
      expect({ owner: built?.owner, role: built?.role, temporary: built?.temporary }).toEqual({
        owner: made!.account_id,
        role: 'doctora',
        temporary: true,
      });

      // Y un reintento no pone una segunda dueña.
      expect((await create(ownerless, A.email))[0]?.verdict).toBe('practice_has_owner');
    } finally {
      await owner.query('delete from practice where id = $1', [ownerless]);
      await owner.query('delete from account where email = $1', [OWNER_EMAIL]);
    }
  });
});

describe('la recuperación · un código vivo por cuenta', () => {
  it('acuña solo para quien ya estrenó su contraseña, y el camino del correo que no existe es el mismo', async () => {
    const mint = (email: string) =>
      read<{ medskin_recovery_mint: boolean }>(
        app,
        ctxAnonymous,
        `select * from medskin_recovery_mint($1, $2, now() + '10 minutes'::interval)`,
        [email, HASH],
      );

    // La paciente ya eligió su contraseña en la prueba anterior, así que sí se acuña.
    expect((await mint(PATIENT.email))[0]?.medskin_recovery_mint).toBe(true);
    // Un correo que no existe: `false`, y ni una fila escrita.
    expect((await mint(EMAIL_THAT_DOES_NOT_EXIST))[0]?.medskin_recovery_mint).toBe(false);
    // Y quien nunca estrenó su temporal tampoco: «quien no probó nunca que tiene el correo
    // no puede usar el correo para entrar». Su camino es que la doctora le reenvíe el acceso.
    expect((await mint(NEW_EMAIL))[0]?.medskin_recovery_mint).toBe(false);

    // Y esta es la razón de las dos marcas: esa misma cuenta, EN CUANTO ENTRA una vez con
    // su temporal, sí puede recuperar —aunque no haya llegado a elegir contraseña—. Es el
    // caso de la paciente a la que se le cierra la app en «Crea tu contraseña»: con una
    // sola columna se quedaba sin recuperación y sin forma de enterarse.
    await read(app, ctxAnonymous, 'select * from medskin_access_attempt($1, true)', [NEW_EMAIL]);
    expect((await mint(NEW_EMAIL))[0]?.medskin_recovery_mint).toBe(true);
    const [stillTemporary] = await owner
      .query<{ temporary: boolean; used: string | null }>(
        `select c.is_temporary as temporary, c.temp_used_at as used
           from credential c join account a on a.id = c.account_id where a.email = $1`,
        [NEW_EMAIL],
      )
      .then((r) => r.rows);
    expect(stillTemporary).toEqual({ temporary: true, used: null });

    // Pedir otro anula el anterior: solo hay uno vivo por cuenta, y lo garantiza el índice
    // parcial, no el código.
    expect((await mint(PATIENT.email))[0]?.medskin_recovery_mint).toBe(true);
    const codes = await owner
      .query<{ n: string }>(
        `select count(*)::text as n from recovery_code
          where account_id = $1 and used_at is null and voided_at is null`,
        [PATIENT.account],
      )
      .then((r) => r.rows);
    expect(codes[0]?.n).toBe('1');
  });

  it('el código vigente viaja con señuelo, y cinco fallos lo anulan sin tocar la cuenta', async () => {
    const live = (email: string) =>
      read<{ verdict: string; account_id: string | null; code_hash: string; attempts_left: number }>(
        app,
        ctxAnonymous,
        'select * from medskin_recovery_live($1)',
        [email],
      );

    const real = await live(PATIENT.email);
    const ghost = await live(EMAIL_THAT_DOES_NOT_EXIST);
    // Las dos dicen 'live' y las dos traen un hash que comparar: un correo sin cuenta
    // responde lo mismo que un código mal escrito, con el mismo contador.
    expect([real[0]?.verdict, ghost[0]?.verdict]).toEqual(['live', 'live']);
    expect(ghost[0]?.code_hash).toMatch(/^\$argon2id\$/);
    expect(ghost[0]?.account_id).toBeNull();
    expect([real[0]?.attempts_left, ghost[0]?.attempts_left]).toEqual([5, 5]);

    const miss = (email: string) =>
      read<{ attempts_left: number | null; voided: boolean }>(
        app,
        ctxAnonymous,
        'select * from medskin_recovery_miss($1)',
        [email],
      );
    const left: Array<number | null> = [];
    for (let i = 0; i < 5; i += 1) left.push((await miss(PATIENT.email))[0]!.attempts_left);
    expect(left).toEqual([4, 3, 2, 1, 0]);

    const [voided] = await live(PATIENT.email);
    expect({ verdict: voided?.verdict }).toEqual({ verdict: 'voided' });
    // «No se bloquea tu cuenta: solo ese código.»
    const [account] = await owner
      .query<{ status: string; locked: string | null }>(
        'select status, locked_until as locked from account where id = $1',
        [PATIENT.account],
      )
      .then((r) => r.rows);
    expect(account).toEqual({ status: 'activa', locked: null });

    // Un correo sin código no tiene nada que contar: el número que ve quien no tiene cuenta
    // sale del contador por correo de Redis.
    expect((await miss(EMAIL_THAT_DOES_NOT_EXIST))[0]).toEqual({ attempts_left: null, voided: false });
  });
});
