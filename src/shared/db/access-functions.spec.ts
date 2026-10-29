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

import { ARGON2_COST } from '../security/passwords';
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
// La paciente del reenvío, aparte de `PATIENT` a propósito: las pruebas de
// `contrasena-nueva` consumen la temporal de aquella, y el reenvío necesita una sin
// consumir para poder distinguir sus tres veredictos.
const RESEND = {
  account: 'eeeeeeee-0000-4000-8000-00000000000e',
  patient: 'eeeeeeee-0000-4000-8000-00000000001e',
  link: 'eeeeeeee-0000-4000-8000-00000000002e',
  email: 'reenvio@funciones.local',
};
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

  // La paciente del reenvío: su cuenta, su temporal SIN consumir, su ficha en A y su
  // vínculo. El vínculo es la autorización literal de `POST /v1/accounts/{account_id}/access`;
  // en B no hay ninguna ficha, y eso es la otra mitad de la prueba.
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'paciente', 'latam', 'Rocio', 'Vargas')`,
    [RESEND.account, RESEND.email],
  );
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, temp_expires_at)
     values ($1, $2, true, now() + interval '72 hours')`,
    [RESEND.account, HASH],
  );
  await owner.query(
    `insert into patient (id, practice_id, first_name, last_name, birth_date, email, phone, how_arrived)
     values ($1, $2, 'Rocio', 'Vargas', '1990-02-02', $3, '+59177124409', 'instagram')`,
    [RESEND.patient, A.practice, RESEND.email],
  );
  await owner.query(
    `insert into patient_link (id, practice_id, patient_id, account_id, email, practice_name,
                               practitioner_name, city)
     values ($1, $2, $3, $4, $5, 'Consulta A de funciones', 'Dra. Andrea Paz', 'Santa Cruz')`,
    [RESEND.link, A.practice, RESEND.patient, RESEND.account, RESEND.email],
  );
}

async function clean() {
  await owner.query('delete from practice where id = any($1::uuid[])', [[A.practice, B.practice]]);
  await owner.query('delete from account where email = any($1::citext[])', [
    [A.email, A.teamEmail, B.email, PATIENT.email, RESEND.email, NEW_EMAIL, OWNER_EMAIL],
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
        // Cuatro argumentos desde la 0020: las dos vidas del refresco en segundos, que es
        // lo que le deja calcular la caducidad con el rol que ya sabe.
        `select * from medskin_session_refresh($1, $2, $3, $4)`,
        ['z'.repeat(64), 'y'.repeat(64), 30 * 24 * 3600, 12 * 3600],
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

    // 4 · La doctora trae su consulta y su rol de equipo, que es lo que `POST /v1/access`
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
    // Es la consulta de `GET /v1/platform/tenants/{id}`: de la consulta a su dueña, y
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
        // Las dos vidas, en segundos, desde la 0020: paciente 30 días · doctora 12 h.
        `select * from medskin_session_refresh($1, $2, $3, $4)`,
        [oldHash, newHash, 30 * 24 * 3600, 12 * 3600],
      );

    const [rotated] = await refresh(REFRESH, ROTATED_REFRESH);
    expect({ verdict: rotated?.verdict, session: rotated?.session_id, role: rotated?.role }).toEqual({
      verdict: 'rotated',
      session: PATIENT.session,
      role: 'paciente',
    });

    // El mismo otra vez: ya usado. Se revoca la sesión, que ES la familia derivada de ese
    // inicio —cada entrada crea una fila y la rotación la actualiza en su sitio—.
    //
    // La rotación se envejece 21 segundos antes de reutilizarlo, y es obligatorio desde la
    // 0018: dentro de los 20 s de gracia el mismo refresco se acepta y rota otra vez
    // (`sesion.md`, 28 oct), así que sin esto se mediría la gracia y no el reuso. La
    // gracia tiene sus propios casos en `refresh-and-first-use.spec.ts`.
    await owner.query(`update session set refresh_rotated_at = now() - interval '21 seconds' where id = $1`, [
      PATIENT.session,
    ]);
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

// =========================================================================================
// LA PREGUNTA 18 · el 500 de una petición SIN SESIÓN tiene que llegar a `service_failure`
//
// Y la mitad que de verdad importa: con la escritura concedida, `app_anonymous` SIGUE SIN
// LEER una sola fila. Un rol que escribe no es un rol que lee.
// =========================================================================================
describe('el registro de fallos del rol sin sesión (0004 y 0005)', () => {
  const TRACE = 'trace-de-la-prueba-18';
  const EMAIL_IN_THE_MESSAGE = 'valeria.antelo@gmail.com';

  afterAll(async () => {
    await owner.query('delete from service_failure where trace_id = $1', [TRACE]);
  });

  it('escribe la fila con la causa real del motor, y sin nada que identifique a nadie', async () => {
    const [row] = await read<{ id: string }>(
      app,
      ctxAnonymous,
      `select medskin_record_anonymous_failure($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9) as id`,
      [
        'acceso.entrar',
        'fallo_de_servicio',
        // La causa textual de PostgreSQL, que es lo que §10.3 exige entera... y que puede
        // traer el correo dentro, porque el motor lo pone en el DETAIL.
        `duplicate key value violates unique constraint "account_email_uq" DETAIL: Key (email)=(${EMAIL_IN_THE_MESSAGE}) already exists`,
        TRACE,
        JSON.stringify([`timeout al escribir a ${EMAIL_IN_THE_MESSAGE}`]),
        `at Object.entrar (/app/acceso.ts:1) ${EMAIL_IN_THE_MESSAGE}`,
        'req-de-la-prueba',
        'ios',
        'latam',
      ],
    );
    expect(Number(row?.id)).toBeGreaterThan(0);

    // Se lee por la consola, que es quien mira el panel de fallos (§10.4). La doctora no:
    // su política es por inquilino y esta fila no tiene inquilino.
    const [written] = await read<Record<string, string | null>>(
      app,
      ctxPlatform,
      `select service, operation, severity, error_code, error_message, cause_chain::text as cause_chain,
              stack, request_id, platform, region, attempt::text as attempt, will_retry::text as will_retry,
              practice_id, actor_id, subject_type, subject_id, input_digest
         from service_failure where trace_id = $1`,
      [TRACE],
    );

    expect(written).toEqual({
      service: 'api',
      operation: 'acceso.entrar',
      severity: 'error',
      error_code: 'fallo_de_servicio',
      // La causa, completa y textual... con la dirección tapada. Regla 1 de §10.3 («nada
      // de dato personal en esta tabla») por delante de la regla 2 («sin reemplazar»): lo
      // que se tapa es una dirección, no la causa.
      error_message:
        'duplicate key value violates unique constraint "account_email_uq" DETAIL: Key (email)=([correo]) already exists',
      cause_chain: '["timeout al escribir a [correo]"]',
      stack: 'at Object.entrar (/app/acceso.ts:1) [correo]',
      request_id: 'req-de-la-prueba',
      platform: 'ios',
      region: 'latam',
      attempt: '1',
      will_retry: 'false',
      // Las cinco columnas que identificarían a alguien, y ninguna es argumento de la
      // función: no hay forma de nombrarlas desde fuera. `input_digest` es la que decide,
      // porque en una petición de acceso sería el hash del correo.
      practice_id: null,
      actor_id: null,
      subject_type: null,
      subject_id: null,
      input_digest: null,
    });

    // Y el correo no está en NINGÚN sitio de la fila, ni completo ni en trozos.
    const [sweep] = await read<{ leaked: string }>(
      app,
      ctxPlatform,
      `select (count(*) > 0)::text as leaked from service_failure
        where trace_id = $1
          and (error_message like '%' || $2 || '%' or stack like '%' || $2 || '%'
               or cause_chain::text like '%' || $2 || '%')`,
      [TRACE, EMAIL_IN_THE_MESSAGE],
    );
    expect(sweep?.leaked).toBe('false');
  });

  it('con la escritura concedida, el rol sin sesión sigue sin leer ni una fila', async () => {
    expect({
      all: await whatItSees(app, ctxAnonymous, 'select id from service_failure'),
      own: await whatItSees(app, ctxAnonymous, 'select error_message from service_failure where trace_id = $1', [
        TRACE,
      ]),
      count: await whatItSees(app, ctxAnonymous, 'select count(*) from service_failure'),
      // Ni escribir directo: la función es la única puerta, y por eso no puede elegir
      // columnas que la función no tiene.
      direct: await whatItSees(
        app,
        ctxAnonymous,
        `insert into service_failure (service, operation, severity, error_code, error_message,
                                      trace_id, will_retry, practice_id)
         values ('api', 'acceso.entrar', 'error', 'x', 'y', 'z', false, $1)`,
        [A.practice],
      ),
      update: await whatItSees(app, ctxAnonymous, `update service_failure set resolution = 'inventada'`),
    }).toEqual({
      all: 'permiso denegado',
      own: 'permiso denegado',
      count: 'permiso denegado',
      direct: 'permiso denegado',
      update: 'permiso denegado',
    });
  });

  it('valida sus argumentos y no la ejecuta nadie más', async () => {
    const fails = async (ctx: TenantContext, params: unknown[]) => {
      try {
        await read(app, ctx, 'select medskin_record_anonymous_failure($1, $2, $3, $4, null, null, null, $5, $6)', params);
        return 'ejecuta';
      } catch (failure) {
        const { code } = failure as { code?: string };
        return code === '42501' ? 'permiso denegado' : code === '22023' ? 'argumento invalido' : `otro: ${code}`;
      }
    };
    const ok = ['acceso.entrar', 'fallo_de_servicio', 'causa', 'traza', null, null];

    expect({
      sinCausa: await fails(ctxAnonymous, ['acceso.entrar', 'fallo_de_servicio', '   ', 'traza', null, null]),
      sinTraza: await fails(ctxAnonymous, ['acceso.entrar', 'fallo_de_servicio', 'causa', null, null, null]),
      // Las dos etiquetas son de lista cerrada: no son texto libre del cliente.
      plataformaInventada: await fails(ctxAnonymous, [...ok.slice(0, 4), 'windows-phone', null]),
      regionInventada: await fails(ctxAnonymous, [...ok.slice(0, 4), null, 'bo']),
      // Y los otros tres roles no la necesitan: escriben la fila completa, con su
      // inquilino y su actor, bajo su propia política.
      comoDoctora: await fails(ctxPractitionerA, ok),
      comoPaciente: await fails(ctxPatient, ok),
      comoPlataforma: await fails(ctxPlatform, ok),
    }).toEqual({
      sinCausa: 'argumento invalido',
      sinTraza: 'argumento invalido',
      plataformaInventada: 'argumento invalido',
      regionInventada: 'argumento invalido',
      comoDoctora: 'permiso denegado',
      comoPaciente: 'permiso denegado',
      comoPlataforma: 'permiso denegado',
    });
  });
});

// =========================================================================================
// EL SEÑUELO Y SU COSTE (0007) · el oráculo del reloj, cerrado
// =========================================================================================
describe('los parámetros del señuelo del acceso (0007)', () => {
  // El señuelo de esta base es el que sembró la migración y así se queda: si una prueba
  // lo tocara, el «mismo tiempo» de las siguientes mediría otra cosa.
  let seeded: string;
  beforeAll(async () => {
    const { rows } = await owner.query<{ hash: string }>('select hash from access_decoy where only_row');
    seeded = rows[0]?.hash ?? '';
  });
  afterAll(async () => {
    await owner.query('update access_decoy set hash = $1 where only_row and hash <> $1', [seeded]);
  });

  it('el señuelo está sembrado con los MISMOS parámetros con los que hashea la aplicación', async () => {
    // Esta es la prueba que faltaba el día que la 0002 sembró el señuelo con los valores
    // por defecto de la librería: `m=65536,t=3,p=4` contra los `m=19456,t=2,p=1` reales.
    // Verificar contra uno costaba 15,4 ms y contra el otro 28,2 ms, y esa diferencia es un
    // oráculo de enumeración de cuentas con un cronómetro y una sola petición por correo.
    //
    // Los parámetros viajan DENTRO del hash codificado, así que el coste lo fija la fila de
    // la base y no la configuración del proceso: comparar las dos cosas es la única forma
    // de que no se vuelvan a desincronizar en silencio. `ARGON2_COST` se importa a
    // propósito —no se copian los números— para que cambiarlo sin resembrar rompa aquí.
    const [params] = await read<Record<string, string>>(
      app,
      ctxAnonymous,
      'select algorithm, memory_cost::text as memory_cost, time_cost::text as time_cost, parallelism::text as parallelism from medskin_access_decoy_params()',
    );
    expect(params).toMatchObject({
      algorithm: 'argon2id',
      memory_cost: String(ARGON2_COST.memoryCost),
      time_cost: String(ARGON2_COST.timeCost),
      parallelism: String(ARGON2_COST.parallelism),
    });
  });

  it('los parámetros se pueden leer y el hash sigue sin poder leerse', async () => {
    expect({
      // El señuelo no se lee desde ningún rol de aplicación: es la otra mitad de la
      // promesa del «mismo tiempo», y lo que no se lee no se compara.
      anonimo: await whatItSees(app, ctxAnonymous, 'select hash from access_decoy'),
      doctora: await whatItSees(app, ctxPractitionerA, 'select hash from access_decoy'),
      plataforma: await whatItSees(app, ctxPlatform, 'select hash from access_decoy'),
      // Y la función de los parámetros es solo del rol cuyo reloj está en juego.
      paramsComoDoctora: await whatItSees(app, ctxPractitionerA, 'select * from medskin_access_decoy_params()'),
    }).toEqual({
      anonimo: 'permiso denegado',
      doctora: 'permiso denegado',
      plataforma: 'permiso denegado',
      paramsComoDoctora: 'permiso denegado',
    });
  });

  it('la fila no acepta nada que no se pueda parsear como Argon2id', async () => {
    // Lo que la restricción garantiza es que la comprobación de arranque SIEMPRE tenga tres
    // números que leer. Lo que NO puede garantizar es que sean los correctos —una cadena
    // con `m=65536` es igual de parseable—, y por eso el arreglo son dos cosas: esta
    // restricción y la comparación contra `ARGON2_COST` de la prueba anterior.
    const broken = [
      'no soy un hash',
      '$argon2id$v=19$m=19456,p=1$c2FsdA$aGFzaA',
      '$argon2d$v=19$m=19456,p=1,t=2$c2FsdA$aGFzaA',
      '$argon2id$v=19$m=19456,p=1,t=2$c2FsdA',
      '',
    ];
    const results = await Promise.all(
      broken.map(async (hash) => {
        try {
          await owner.query('update access_decoy set hash = $1 where only_row', [hash]);
          return 'entra';
        } catch (failure) {
          return (failure as { code?: string }).code === '23514' ? 'rechazado' : 'otro';
        }
      }),
    );
    expect(results).toEqual(['rechazado', 'rechazado', 'rechazado', 'rechazado', 'rechazado']);
  });
});

// =========================================================================================
// LAS DOS FUNCIONES QUE `patient_link` HACE POSIBLES (0006)
// `POST /v1/accounts/{account_id}/access` y el `ya_eligio_contrasena` de la ficha.
// =========================================================================================
describe('el reenvío del acceso de la doctora (0006)', () => {
  const NEW_TEMP = '$argon2id$v=19$m=19456,p=1,t=2$c2FsdGVhZG9kZXBydWViYQ$4+9Luamu4CrTRSqz7rWxCJY49vSQUkKTBlaiJPvmXcs';
  const expiry = `now() + interval '72 hours'`;

  it('el estado del acceso de SU paciente, y nada de la cuenta de nadie más', async () => {
    const [mine] = await read<Record<string, string>>(
      app,
      ctxPractitionerA,
      'select linked::text, password_chosen::text, (temp_expires_at is not null)::text as has_expiry from medskin_patient_access_state($1)',
      [RESEND.account],
    );
    expect(mine).toEqual({ linked: 'true', password_chosen: 'false', has_expiry: 'true' });

    // La misma cuenta preguntada desde B: no hay vínculo, así que no hay nada que contar.
    // No se distingue «no es tuya» de «no existe», que es el `404` del contrato.
    const [notMine] = await read<Record<string, string | null>>(
      app,
      ctxPractitionerB,
      'select linked::text, password_chosen::text, temp_expires_at from medskin_patient_access_state($1)',
      [RESEND.account],
    );
    expect(notMine).toEqual({ linked: 'false', password_chosen: null, temp_expires_at: null });

    // Y una cuenta que no existe responde igual que una que no es suya.
    const [nobody] = await read<Record<string, string | null>>(
      app,
      ctxPractitionerA,
      'select linked::text, password_chosen::text, temp_expires_at from medskin_patient_access_state($1)',
      ['eeeeeeee-0000-4000-8000-0000000000ff'],
    );
    expect(nobody).toEqual(notMine);
  });

  it('acuña una temporal nueva, mata la anterior y marca cuándo se mandó', async () => {
    const before = await owner.query<{ hash: string; sent: string | null }>(
      `select c.hash, l.access_sent_at as sent from credential c
         join patient_link l on l.account_id = c.account_id
        where c.account_id = $1`,
      [RESEND.account],
    );
    expect(before.rows[0]?.sent).toBeNull();

    const [out] = await read<Record<string, string>>(
      app,
      ctxPractitionerA,
      `select outcome, (expires_at is not null)::text as has_expiry
         from medskin_resend_patient_access($1, $2, ${expiry})`,
      [RESEND.account, NEW_TEMP],
    );
    expect(out).toEqual({ outcome: 'acceso_renovado', has_expiry: 'true' });

    const after = await owner.query<{ hash: string; temporary: boolean; first: string | null; sent: string | null }>(
      `select c.hash, c.is_temporary as temporary, c.temp_first_used_at as first, l.access_sent_at as sent
         from credential c join patient_link l on l.account_id = c.account_id
        where c.account_id = $1`,
      [RESEND.account],
    );
    expect(after.rows[0]?.hash).toBe(NEW_TEMP);
    expect(after.rows[0]?.temporary).toBe(true);
    // La temporal nueva no se ha estrenado: la marca de la anterior se borra.
    expect(after.rows[0]?.first).toBeNull();
    expect(after.rows[0]?.sent).not.toBeNull();
  });

  it('una cuenta sin vínculo en esta consulta es «paciente_no_existe», no un acceso nuevo', async () => {
    // Si esto devolviera otra cosa, una doctora podría acuñar una temporal sobre la cuenta
    // de cualquiera y entrar con ella. Es el agujero que `patient_link` cierra.
    const probes = await Promise.all(
      [
        [ctxPractitionerB, RESEND.account],
        [ctxPractitionerA, PATIENT.account],
        [ctxPractitionerA, B.account],
      ].map(async ([ctx, account]) => {
        const [row] = await read<{ outcome: string }>(
          app,
          ctx as TenantContext,
          `select outcome from medskin_resend_patient_access($1, $2, ${expiry})`,
          [account, NEW_TEMP],
        );
        return row?.outcome;
      }),
    );
    expect(probes).toEqual(['paciente_no_existe', 'paciente_no_existe', 'paciente_no_existe']);

    // Y la credencial de la otra cuenta no se tocó.
    const { rows } = await owner.query<{ hash: string }>('select hash from credential where account_id = $1', [
      PATIENT.account,
    ]);
    expect(rows[0]?.hash).not.toBe(NEW_TEMP);
  });

  it('una paciente que ya eligió su contraseña no se la puede resetear su doctora', async () => {
    await owner.query(
      `update credential set is_temporary = false, temp_used_at = now(), set_at = now() where account_id = $1`,
      [RESEND.account],
    );
    const [out] = await read<{ outcome: string }>(
      app,
      ctxPractitionerA,
      `select outcome from medskin_resend_patient_access($1, $2, ${expiry})`,
      [RESEND.account, HASH],
    );
    expect(out?.outcome).toBe('ya_eligio_su_contrasena');

    // El hash no cambió: «si pudiera, la doctora sería dueña del acceso al expediente de
    // una persona adulta» (cuentas.md).
    const { rows } = await owner.query<{ hash: string }>('select hash from credential where account_id = $1', [
      RESEND.account,
    ]);
    expect(rows[0]?.hash).toBe(NEW_TEMP);

    // Y la ficha lo dice, que es para lo que existe la otra función: el botón sale apagado
    // en vez de fallar al pulsarlo.
    const [state] = await read<{ password_chosen: string }>(
      app,
      ctxPractitionerA,
      'select password_chosen::text from medskin_patient_access_state($1)',
      [RESEND.account],
    );
    expect(state?.password_chosen).toBe('true');
  });

  it('las dos funciones exigen contexto de inquilino y no las ejecuta nadie más', async () => {
    const canRun = async (ctx: TenantContext, sql: string, params: unknown[] = []) => {
      try {
        await read(app, ctx, sql, params);
        return 'ejecuta';
      } catch (failure) {
        const { code } = failure as { code?: string };
        return code === '42501' ? 'permiso denegado' : code === '22023' ? 'sin contexto' : `otro: ${code}`;
      }
    };
    const state = 'select * from medskin_patient_access_state($1)';
    const resend = `select * from medskin_resend_patient_access($1, $2, ${expiry})`;

    expect({
      estadoComoPaciente: await canRun(ctxPatient, state, [RESEND.account]),
      estadoComoAnonimo: await canRun(ctxAnonymous, state, [RESEND.account]),
      estadoComoPlataforma: await canRun(ctxPlatform, state, [RESEND.account]),
      reenvioComoPaciente: await canRun(ctxPatient, resend, [RESEND.account, HASH]),
      reenvioComoAnonimo: await canRun(ctxAnonymous, resend, [RESEND.account, HASH]),
      // Y la temporal tiene que venir hasheada con Argon2id: un `hash` en claro aquí sería
      // una contraseña guardada en claro.
      sinHashear: await canRun(ctxPractitionerA, resend, [RESEND.account, 'tejado-lila-07']),
    }).toEqual({
      estadoComoPaciente: 'permiso denegado',
      estadoComoAnonimo: 'permiso denegado',
      estadoComoPlataforma: 'permiso denegado',
      reenvioComoPaciente: 'permiso denegado',
      reenvioComoAnonimo: 'permiso denegado',
      sinHashear: 'sin contexto',
    });
  });
});

// =========================================================================================
// EL CAMINO DE RECUPERACIÓN, ENTERO (0013)
//
// Es el único camino en que el servidor no sabe QUÉ es quien llama: el token de recuperación
// no lleva el rol a propósito. Así que adopta `app_account`, y la función tiene que
// devolverle todo lo que necesita para contestar —incluido el rol dentro de la consulta—
// en UNA transacción: si hiciera falta una segunda lectura y fallara, la contraseña ya
// estaría guardada y el 500 del contrato diría «todavía puedes entrar con la temporal»,
// que en ese instante es mentira.
// =========================================================================================
describe('la contraseña definitiva por recuperación, con app_account (0013)', () => {
  const RECOVERED = '$argon2id$v=19$m=19456,p=1,t=2$cmVjdXBlcmFkYXNhbA$4+9Luamu4CrTRSqz7rWxCJY49vSQUkKTBlaiJPvmXcs';
  // La dueña de A: tiene credencial definitiva y una sesión viva, que es el estado de quien
  // olvidó su contraseña. Y es doctora, que es lo que la columna nueva tiene que decir.
  const ctxAccountOwner: TenantContext = { role: 'app_account', accountId: A.account };

  beforeAll(async () => {
    await owner.query(
      `insert into recovery_code (account_id, code_hash, expires_at)
       values ($1, $2, now() + interval '10 minutes')`,
      [A.account, HASH],
    );
  });

  it('devuelve el rol de la consulta en la misma transacción que guarda la contraseña', async () => {
    const [verdict] = await read<Record<string, string | null>>(
      app,
      ctxAccountOwner,
      'select verdict, role, practitioner_role, practice_id, sessions_revoked::text from medskin_set_final_password($1, $2, null)',
      [RECOVERED, 'recuperacion'],
    );
    expect(verdict).toEqual({
      verdict: 'saved',
      // `account.role` es el de autenticación y no sirve para encender pantallas...
      role: 'practitioner',
      // ...y este sí: es el que el borde traduce a `rol` en la respuesta.
      practitioner_role: 'doctora',
      practice_id: A.practice,
      // No se le pasó `p_current_session`: por recuperación se revocan TODAS, incluida la
      // que llamó. Quien tuviera la contraseña vieja se queda fuera.
      sessions_revoked: '1',
    });

    // Y el código vivo se anuló en la misma transacción.
    const { rows } = await owner.query<{ voided_reason: string | null }>(
      'select voided_reason from recovery_code where account_id = $1 order by created_at desc limit 1',
      [A.account],
    );
    expect(rows[0]?.voided_reason).toBe('usado');
  });

  it('para una paciente el rol de consulta es nulo, y eso también es una respuesta', async () => {
    // `paciente` no es un rol de `practitioner` (decisión 12): vive en `account`. Nulo aquí
    // es «no es de ninguna consulta», no un dato que falte.
    await owner.query(
      `insert into recovery_code (account_id, code_hash, expires_at)
       values ($1, $2, now() + interval '10 minutes')`,
      [RESEND.account, HASH],
    );
    const [verdict] = await read<Record<string, string | null>>(
      app,
      { role: 'app_account', accountId: RESEND.account },
      'select verdict, role, practitioner_role, practice_id from medskin_set_final_password($1, $2, null)',
      [RECOVERED, 'recuperacion'],
    );
    expect(verdict).toEqual({
      verdict: 'saved',
      role: 'paciente',
      practitioner_role: null,
      practice_id: null,
    });
  });

  it('con este rol no se puede guardar la contraseña de otra cuenta', async () => {
    // La autorización es `medskin.account_id` y nunca un argumento: la función no recibe
    // ninguna cuenta. Sin contexto no hay nada que guardar.
    await expect(
      read(app, { role: 'app_anonymous' }, 'select * from medskin_set_final_password($1, $2, null)', [
        RECOVERED,
        'recuperacion',
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('y la bitácora de la MISMA transacción entra con el inquilino que devolvió la función', async () => {
    // Es la segunda consulta que el repositorio hace en esa transacción, y la que faltaba
    // por probar: `practice_id` es el de la doctora —lo acaba de devolver la función— y
    // `medskin.practice_id` está VACÍO, porque este rol no fija inquilino. La política de
    // inserción de `access_audit` es `with check (true)` a propósito; si no lo fuera, o si
    // faltara el `GRANT INSERT`, `POST /v1/access/new-password` sería un 500 con la
    // contraseña ya guardada, que es justo lo que el contrato promete que no pasa.
    await withTenantContext(app, ctxAccountOwner, (c) =>
      c.query(
        `insert into access_audit (practice_id, actor_account_id, actor_label, action,
                                   subject_type, subject_id, data, region)
         values ($1, $2, null, 'acceso.contrasena_elegida', 'cuenta', $2, $3, null)`,
        [A.practice, A.account, JSON.stringify({ via: 'recuperacion' })],
      ),
    );
    const { rows } = await owner.query<{ practice_id: string; data: { via: string } }>(
      `select practice_id, data from access_audit
        where actor_account_id = $1 and action = 'acceso.contrasena_elegida'`,
      [A.account],
    );
    expect(rows).toEqual([{ practice_id: A.practice, data: { via: 'recuperacion' } }]);
  });
});
