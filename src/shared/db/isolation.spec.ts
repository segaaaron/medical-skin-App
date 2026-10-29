// La prueba bloqueante de §7.3: falla si el inquilino A lee una fila del B.
// Contra la base real en Docker, sin un solo doble: un mock de RLS prueba el mock.
//
// Y la prueba que de verdad importa, la última de este archivo: la misma comprobación a
// través de PgBouncer en modo transacción (6432), que es donde se vería la fuga si alguien
// fijara el contexto con un `SET` de sesión en vez de con `set_config(..., true)`.
//
// En ningún momento se desactiva RLS. Las filas de prueba las siembra la conexión del
// DUEÑO del esquema, que es la que migra; las lecturas, las únicas que se comprueban, van
// siempre por los roles de aplicación y por el ayudante de contexto.
//
// Identificadores en inglés, descripciones en español: norma del 27 de octubre.

import { Pool, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantContext, type TenantContext } from './tenant-context';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ?? 'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';
const poolerUrl = process.env.DATABASE_URL_POOLER ?? 'postgresql://medskin:dev_local_only@localhost:6432/medskin';

// Identificadores fijos: así una ejecución que se corta no deja basura que la siguiente
// no sepa limpiar.
const A = {
  practice: 'aaaaaaaa-0000-4000-8000-000000000001',
  license: 'aaaaaaaa-0000-4000-8000-000000000002',
  practitioner: 'aaaaaaaa-0000-4000-8000-000000000003',
  account: 'aaaaaaaa-0000-4000-8000-000000000004',
  session: 'aaaaaaaa-0000-4000-8000-000000000005',
  // Tramo 2: la ficha, su vínculo y sus antecedentes.
  patient: 'aaaaaaaa-0000-4000-8000-000000000006',
  link: 'aaaaaaaa-0000-4000-8000-000000000007',
  history: 'aaaaaaaa-0000-4000-8000-000000000008',
};
const B = {
  practice: 'bbbbbbbb-0000-4000-8000-000000000001',
  license: 'bbbbbbbb-0000-4000-8000-000000000002',
  practitioner: 'bbbbbbbb-0000-4000-8000-000000000003',
  account: 'bbbbbbbb-0000-4000-8000-000000000004',
  session: 'bbbbbbbb-0000-4000-8000-000000000005',
  patient: 'bbbbbbbb-0000-4000-8000-000000000006',
  link: 'bbbbbbbb-0000-4000-8000-000000000007',
  history: 'bbbbbbbb-0000-4000-8000-000000000008',
};
const PATIENT = {
  account: 'cccccccc-0000-4000-8000-000000000001',
  session: 'cccccccc-0000-4000-8000-000000000002',
  code: 'cccccccc-0000-4000-8000-000000000003',
};
// La consola no es un inquilino y su operador no tiene fila en `account`: solo hace falta
// un `account_id` para el contexto.
const PLATFORM = { account: 'dddddddd-0000-4000-8000-000000000001' };

const ctxPractitionerA: TenantContext = { role: 'app_practitioner', practiceId: A.practice, accountId: A.account };
const ctxPractitionerB: TenantContext = { role: 'app_practitioner', practiceId: B.practice, accountId: B.account };
const ctxPatient: TenantContext = { role: 'app_patient', accountId: PATIENT.account };
const ctxPlatform: TenantContext = { role: 'app_platform', accountId: PLATFORM.account };
// El quinto rol (0013): el del token que NO dice qué es la persona. Por aquí entra tanto
// una paciente como una doctora, y es justo por eso que existe.
const ctxAccountPatient: TenantContext = { role: 'app_account', accountId: PATIENT.account };
const ctxAccountPractitioner: TenantContext = { role: 'app_account', accountId: A.account };

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
// max: 1 a propósito: obliga a reutilizar la misma conexión entre transacciones, que es
// donde se vería un contexto que sobrevive al COMMIT.
const app = new Pool({ connectionString: appUrl, max: 1 });
const pooler = new Pool({ connectionString: poolerUrl, max: 1 });

async function seed() {
  await clean();
  const side = async (t: typeof A, name: string, email: string) => {
    await owner.query(
      `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit, internal_note)
       values ($1, $2, 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300, 'nota de la consola')`,
      [t.practice, name],
    );
    await owner.query(`insert into license (id, practice_id, status) values ($1, $2, 'sin_enviar')`, [
      t.license,
      t.practice,
    ]);
    await owner.query(
      `insert into account (id, email, role, region, first_name, last_name)
       values ($1, $2, 'practitioner', 'latam', 'Andrea', 'Paz')`,
      [t.account, email],
    );
    await owner.query(
      `insert into practitioner (id, practice_id, account_id, first_name, last_name, role)
       values ($1, $2, $3, 'Andrea', 'Paz', 'doctora')`,
      [t.practitioner, t.practice, t.account],
    );
    // La dueña de la consulta es una columna de `practice` desde la 0002, no un `role` de
    // `practitioner`: la consola necesita el vínculo y no tiene políticas de `practitioner`.
    await owner.query('update practice set owner_account_id = $1 where id = $2', [t.account, t.practice]);
    await owner.query(
      `insert into credential (account_id, hash, is_temporary, temp_expires_at)
       values ($1, 'argon2id$de-prueba', true, now() + interval '72 hours')`,
      [t.account],
    );
    await owner.query(
      `insert into session (id, account_id, practice_id, scope, device_id, app_version, platform)
       values ($1, $2, $3, 'completo', 'disp-1', '2.4.1', 'ios')`,
      [t.session, t.account, t.practice],
    );
    await owner.query(
      `insert into idempotency_key (key, account_id, practice_id, body_hash, expires_at)
       values ('clave-de-prueba', $1, $2, 'sha256-x', now() + interval '24 hours')`,
      [t.account, t.practice],
    );
    await owner.query(
      `insert into service_failure (service, operation, severity, error_code, error_message, practice_id, trace_id, will_retry)
       values ('api', 'acceso.entrar', 'error', 'fallo_de_servicio', 'VipsJpeg: Premature end of input file', $1, $2, false)`,
      [t.practice, `trace-${name}`],
    );
    await owner.query(
      `insert into access_audit (practice_id, actor_account_id, actor_label, action)
       values ($1, $2, 'Andrea Paz', 'license.to_review')`,
      [t.practice, t.account],
    );
    // La ficha de la paciente en esta consulta, y sus antecedentes. Dos fichas distintas
    // de la misma persona que no comparten nada (§12.2.1): es el caso que importa.
    await owner.query(
      `insert into patient (id, practice_id, first_name, last_name, birth_date, email, phone, how_arrived)
       values ($1, $2, 'Valeria', 'Antelo', '1992-04-18', 'paciente@prueba.local', '+59177124408', 'referida')`,
      [t.patient, t.practice],
    );
    await owner.query(
      `insert into medical_history (id, practice_id, patient_id, has_allergies, allergies,
                                    allergies_source, allergies_source_at, phototype,
                                    phototype_source, phototype_source_at, notes, notes_source,
                                    notes_source_at)
       values ($1, $2, $3, true, array['lidocaína'], 'doctora', now(), 3, 'doctora', now(),
               'Pide empezar por la zona periocular.', 'doctora', now())`,
      [t.history, t.practice, t.patient],
    );
  };

  await side(A, 'Clinica A', 'doctora.a@prueba.local');
  await side(B, 'Clinica B', 'doctora.b@prueba.local');

  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, 'paciente@prueba.local', 'paciente', 'latam', 'Valeria', 'Antelo')`,
    [PATIENT.account],
  );
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, temp_expires_at)
     values ($1, 'argon2id$de-prueba', true, now() + interval '72 hours')`,
    [PATIENT.account],
  );
  await owner.query(
    `insert into session (id, account_id, scope, device_id) values ($1, $2, 'completo', 'disp-2')`,
    [PATIENT.session, PATIENT.account],
  );
  await owner.query(
    `insert into recovery_code (id, account_id, code_hash, expires_at)
     values ($1, $2, 'argon2id$codigo', now() + interval '10 minutes')`,
    [PATIENT.code, PATIENT.account],
  );

  // Los dos vínculos de LA MISMA cuenta con DOS inquilinos distintos. Va después de la
  // cuenta porque `patient_link.account_id` la referencia, y es el único sitio del esquema
  // donde una fila legible cruza inquilinos: la cara por `account_id` de la política.
  // A está aceptado y B todavía invitado: así se prueba que los antecedentes se abren con
  // el vínculo aceptado y no con el otro.
  const link = (t: typeof A, status: string, practiceName: string, city: string) =>
    owner.query(
      `insert into patient_link (id, practice_id, patient_id, account_id, status, email,
                                 access_sent_at, practice_name, practitioner_name, city)
       values ($1, $2, $3, $4, $5, 'paciente@prueba.local', now(), $6, 'Dra. Andrea Paz', $7)`,
      [t.link, t.practice, t.patient, PATIENT.account, status, practiceName, city],
    );
  await link(A, 'vinculada', 'Clinica A', 'Santa Cruz');
  await link(B, 'invitada', 'Clinica B', 'La Paz');
}

async function clean() {
  await owner.query('delete from practice where id = any($1::uuid[])', [[A.practice, B.practice]]);
  await owner.query('delete from account where id = any($1::uuid[])', [[A.account, B.account, PATIENT.account]]);
  // Estas tres no se las lleva ningún cascade porque no tienen claves foráneas: la de
  // idempotencia porque su inquilino es «el de quien llama», y las dos bitácoras porque
  // deben sobrevivir al borrado de lo que describen (§12.2.8).
  await owner.query('delete from idempotency_key where account_id = any($1::uuid[])', [
    [A.account, B.account, PATIENT.account],
  ]);
  await owner.query('delete from service_failure where practice_id = any($1::uuid[])', [[A.practice, B.practice]]);
  await owner.query('delete from access_audit where practice_id = any($1::uuid[])', [[A.practice, B.practice]]);
  // Y la cuarta sin claves foráneas: la bitácora clínica. `patient`, `patient_link` y
  // `medical_history` sí se las lleva el cascade de `practice`.
  await owner.query('delete from medical_history_audit where practice_id = any($1::uuid[])', [
    [A.practice, B.practice],
  ]);
}

/**
 * Lee por el rol y el contexto que se le den, y devuelve las filas. Todas las columnas que
 * estas pruebas leen son identificadores o cadenas, así que la forma por defecto basta.
 */
function read<T extends QueryResultRow = Record<string, string>>(
  pool: Pool,
  ctx: TenantContext,
  sql: string,
  params: unknown[] = [],
) {
  return withTenantContext(pool, ctx, async (client) => (await client.query<T>(sql, params)).rows);
}

/**
 * «No lee nada» tiene dos formas legítimas y las dos valen: cero filas porque la política
 * las filtró, o permiso denegado porque el rol no tiene ni el grant. La segunda es la más
 * fuerte: no hay consulta que escribir.
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
  await Promise.all([owner.end(), app.end(), pooler.end()]);
});

describe('aislamiento entre inquilinos · conexión directa (5433)', () => {
  it('el inquilino A no lee ni una fila del B, tabla por tabla', async () => {
    const fromB = {
      practice: await whatItSees(app, ctxPractitionerA, 'select id from practice where id = $1', [B.practice]),
      license: await whatItSees(app, ctxPractitionerA, 'select id from license where practice_id = $1', [B.practice]),
      practitioner: await whatItSees(app, ctxPractitionerA, 'select id from practitioner where practice_id = $1', [
        B.practice,
      ]),
      idempotency_key: await whatItSees(
        app,
        ctxPractitionerA,
        'select key from idempotency_key where practice_id = $1',
        [B.practice],
      ),
      service_failure: await whatItSees(app, ctxPractitionerA, 'select id from service_failure where practice_id = $1', [
        B.practice,
      ]),
      access_audit: await whatItSees(app, ctxPractitionerA, 'select id from access_audit where practice_id = $1', [
        B.practice,
      ]),
    };
    expect(fromB).toEqual({
      practice: '0 filas',
      license: '0 filas',
      practitioner: '0 filas',
      idempotency_key: '0 filas',
      service_failure: '0 filas',
      access_audit: '0 filas',
    });

    // Y no pasa por estar todo vacío: con su propio contexto, A sí ve lo suyo.
    const own = {
      practice: (await read(app, ctxPractitionerA, 'select id from practice')).map((r) => r.id),
      license: (await read(app, ctxPractitionerA, 'select practice_id from license')).map((r) => r.practice_id),
      practitioner: (await read(app, ctxPractitionerA, 'select practice_id from practitioner')).map(
        (r) => r.practice_id,
      ),
      idempotency_key: (await read(app, ctxPractitionerA, 'select practice_id from idempotency_key')).map(
        (r) => r.practice_id,
      ),
      service_failure: (await read(app, ctxPractitionerA, 'select practice_id from service_failure')).map(
        (r) => r.practice_id,
      ),
      access_audit: (await read(app, ctxPractitionerA, 'select practice_id from access_audit')).map(
        (r) => r.practice_id,
      ),
    };
    expect(own).toEqual({
      practice: [A.practice],
      license: [A.practice],
      practitioner: [A.practice],
      idempotency_key: [A.practice],
      service_failure: [A.practice],
      access_audit: [A.practice],
    });
  });

  it('una cuenta no lee la cuenta, la credencial ni la sesión de otra', async () => {
    // `account` no lleva practice_id: su aislamiento es por fila (§12.2.1).
    expect({
      account: await whatItSees(app, ctxPractitionerA, 'select id from account where id = $1', [B.account]),
      credential: await whatItSees(app, ctxPractitionerA, 'select id from credential where account_id = $1', [
        B.account,
      ]),
      session: await whatItSees(app, ctxPractitionerA, 'select id from session where account_id = $1', [B.account]),
    }).toEqual({ account: '0 filas', credential: '0 filas', session: '0 filas' });

    // Una doctora tampoco ve la sesión de su paciente: saber desde dónde entra no es
    // parte de atenderla (acceso.md).
    expect(
      await whatItSees(app, ctxPractitionerA, 'select id from session where account_id = $1', [PATIENT.account]),
    ).toBe('0 filas');

    // Y la paciente lee la suya, y solo la suya.
    expect((await read(app, ctxPatient, 'select id from account')).map((r) => r.id)).toEqual([PATIENT.account]);
    expect((await read(app, ctxPatient, 'select id from session')).map((r) => r.id)).toEqual([PATIENT.session]);
  });

  it('el hash de la contraseña no se puede leer, con contexto propio y todo', async () => {
    await expect(read(app, ctxPatient, 'select hash from credential')).rejects.toMatchObject({ code: '42501' });
  });

  it('el rol de plataforma no lee nada clínico, ni credenciales, ni códigos', async () => {
    expect({
      practitioner: await whatItSees(app, ctxPlatform, 'select id from practitioner'),
      credential: await whatItSees(app, ctxPlatform, 'select id from credential'),
      recovery_code: await whatItSees(app, ctxPlatform, 'select id from recovery_code'),
      // De `session` tiene tres columnas desde la 0002 y nada más: `select *` sigue
      // cerrado, y `id` también. El detalle está en access-functions.spec.ts.
      session: await whatItSees(app, ctxPlatform, 'select id from session'),
    }).toEqual({
      practitioner: 'permiso denegado',
      credential: 'permiso denegado',
      recovery_code: 'permiso denegado',
      session: 'permiso denegado',
    });

    // Y no pasa porque el rol esté roto: en sus cuatro tablas sí lee (_convenciones.md).
    const practices = (
      await read(app, ctxPlatform, 'select id from practice where id = any($1::uuid[])', [[A.practice, B.practice]])
    ).length;
    const licenses = (
      await read(app, ctxPlatform, 'select id from license where practice_id = any($1::uuid[])', [
        [A.practice, B.practice],
      ])
    ).length;
    const accounts = (
      await read(app, ctxPlatform, 'select email from account where id = any($1::uuid[])', [
        [A.account, B.account, PATIENT.account],
      ])
    ).length;
    const failures = (
      await read(app, ctxPlatform, 'select id from service_failure where practice_id = any($1::uuid[])', [
        [A.practice, B.practice],
      ])
    ).length;
    expect({ practices, licenses, accounts, failures }).toEqual({
      practices: 2,
      licenses: 2,
      accounts: 3,
      failures: 2,
    });

    // De `account` ve «correo, rol, estado y pausa», y nada más: ni el nombre.
    await expect(read(app, ctxPlatform, 'select first_name from account')).rejects.toMatchObject({ code: '42501' });
  });

  it('ni la doctora ni la plataforma pueden leer un código de recuperación', async () => {
    expect({
      practitioner: await whatItSees(app, ctxPractitionerA, 'select id from recovery_code'),
      platform: await whatItSees(app, ctxPlatform, 'select id from recovery_code'),
    }).toEqual({ practitioner: 'permiso denegado', platform: 'permiso denegado' });
  });

  it('la bitácora es inmutable: nadie puede reescribirla ni borrarla', async () => {
    await expect(
      read(app, ctxPractitionerA, 'update access_audit set action = $1 where practice_id = $2', [
        'falseada',
        A.practice,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      read(app, ctxPlatform, 'delete from access_audit where practice_id = $1', [A.practice]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('el contexto no sobrevive al COMMIT', async () => {
    expect((await read(app, ctxPractitionerA, 'select id from practice')).length).toBe(1);

    // Misma conexión (el pool es de una), transacción nueva y sin contexto.
    const client = await app.connect();
    try {
      const { rows } = await client.query<{ role: string; practice: string; account: string }>(
        `select current_user as role,
                coalesce(current_setting('medskin.practice_id', true), '') as practice,
                coalesce(current_setting('medskin.account_id', true), '') as account`,
      );
      expect(rows[0]).toEqual({ role: 'medskin', practice: '', account: '' });
      // Y sin rol adoptado la conexión de la aplicación no puede leer nada: NOINHERIT y
      // sin grants directos. Falla cerrada.
      await expect(client.query('select id from practice')).rejects.toMatchObject({ code: '42501' });
    } finally {
      client.release();
    }
  });
});

describe('tramo 2 · patient, patient_link y medical_history', () => {
  it('el inquilino A no lee ni una fila del B en las cuatro tablas nuevas', async () => {
    expect({
      patient: await whatItSees(app, ctxPractitionerA, 'select id from patient where practice_id = $1', [B.practice]),
      patient_by_id: await whatItSees(app, ctxPractitionerA, 'select id from patient where id = $1', [B.patient]),
      // Y tampoco por el correo exacto, que es el intento que de verdad se escribe: el
      // duplicado del alta es POR CONSULTA, no global (cuentas.md, §12.2.1).
      patient_by_email: await whatItSees(
        app,
        ctxPractitionerA,
        'select id from patient where email = $1 and id = $2',
        ['paciente@prueba.local', B.patient],
      ),
      patient_link: await whatItSees(app, ctxPractitionerA, 'select id from patient_link where id = $1', [B.link]),
      // La cara por cuenta de `patient_link` no le sirve a la doctora para saltar el
      // inquilino: su política es la otra, y las políticas se suman por rol, no por tabla.
      link_by_account: await whatItSees(
        app,
        ctxPractitionerA,
        'select id from patient_link where account_id = $1 and practice_id = $2',
        [PATIENT.account, B.practice],
      ),
      medical_history: await whatItSees(app, ctxPractitionerA, 'select id from medical_history where id = $1', [
        B.history,
      ]),
      history_notes: await whatItSees(app, ctxPractitionerA, 'select notes from medical_history where patient_id = $1', [
        B.patient,
      ]),
    }).toEqual({
      patient: '0 filas',
      patient_by_id: '0 filas',
      patient_by_email: '0 filas',
      patient_link: '0 filas',
      link_by_account: '0 filas',
      medical_history: '0 filas',
      history_notes: '0 filas',
    });

    // Y no pasa por estar todo vacío: con su propio contexto, A ve lo suyo y entero.
    expect({
      patient: (await read(app, ctxPractitionerA, 'select id from patient')).map((r) => r.id),
      link: (await read(app, ctxPractitionerA, 'select id from patient_link')).map((r) => r.id),
      history: (await read(app, ctxPractitionerA, 'select id from medical_history')).map((r) => r.id),
      // El correo del acceso y el estado del vínculo: lo que la doctora puede saber del
      // acceso de SU paciente, y sale de `patient_link`, nunca de `account`.
      vinculo: (
        await read(app, ctxPractitionerA, 'select status, email::text as email from patient_link')
      ).map((r) => `${r.status} ${r.email}`),
    }).toEqual({
      patient: [A.patient],
      link: [A.link],
      history: [A.history],
      vinculo: ['vinculada paciente@prueba.local'],
    });
  });

  it('la paciente ve sus dos vínculos, de dos inquilinos distintos, y seis columnas', async () => {
    // La única lectura del sistema que cruza inquilinos, y cruza solo las fichas de quien
    // pregunta. Sin contexto de inquilino: `app_patient` no fija ninguno.
    const links = await read(app, ctxPatient, 'select practice_name, practitioner_name, city, status from patient_link');
    expect(links.map((r) => `${r.practice_name} · ${r.city} · ${r.status}`).sort()).toEqual([
      'Clinica A · Santa Cruz · vinculada',
      'Clinica B · La Paz · invitada',
    ]);

    expect({
      // Las tres cadenas están copiadas justo para que esto siga cerrado (pregunta 7).
      practice: await whatItSees(app, ctxPatient, 'select name from practice'),
      practitioner: await whatItSees(app, ctxPatient, 'select first_name from practitioner'),
      // La ficha es de la consulta: no tiene política aquí NI grant, que es la forma
      // fuerte de «no lee nada»: no hay consulta que escribir.
      patient: await whatItSees(app, ctxPatient, 'select id from patient'),
      // Y de su propio vínculo no lee ni cuándo le mandaron el acceso ni el correo:
      // columnas que no están en su grant.
      access_sent_at: await whatItSees(app, ctxPatient, 'select access_sent_at from patient_link'),
      email: await whatItSees(app, ctxPatient, 'select email from patient_link'),
    }).toEqual({
      practice: 'permiso denegado',
      practitioner: 'permiso denegado',
      patient: 'permiso denegado',
      access_sent_at: 'permiso denegado',
      email: 'permiso denegado',
    });
  });

  it('los antecedentes se abren con el vínculo aceptado, y sin fototipo ni notas', async () => {
    const seen = await read(app, ctxPatient, 'select practice_id, has_allergies::text from medical_history');
    // Uno, no dos: el de B está `invitada` y su política exige `vinculada`.
    expect(seen).toEqual([{ practice_id: A.practice, has_allergies: 'true' }]);

    expect({
      phototype: await whatItSees(app, ctxPatient, 'select phototype from medical_history'),
      notes: await whatItSees(app, ctxPatient, 'select notes from medical_history'),
      write_notes: await whatItSees(app, ctxPatient, `update medical_history set notes = 'colada'`),
      write_phototype: await whatItSees(app, ctxPatient, 'update medical_history set phototype = 6'),
    }).toEqual({
      phototype: 'permiso denegado',
      notes: 'permiso denegado',
      write_notes: 'permiso denegado',
      write_phototype: 'permiso denegado',
    });
  });

  it('«la doctora gana» es un predicado por columna, y la base lo sostiene', async () => {
    // Lo que escribe el endpoint de la paciente: solo si el campo está vacío o lo escribió
    // ella. `allergies_source` es 'doctora', así que no toca ninguna fila y el endpoint
    // tiene con qué contestar `no_guardado: [{campo, por_que}]`.
    const blocked = await withTenantContext(app, ctxPatient, async (client) =>
      client.query(
        `update medical_history
            set has_allergies = false, allergies = '{}'::text[],
                allergies_source = 'paciente', allergies_source_at = now()
          where patient_id = $1
            and (allergies_source is null or allergies_source = 'paciente')`,
        [A.patient],
      ),
    );
    expect(blocked.rowCount).toBe(0);

    // Y el campo que nadie llenó sí lo escribe, con su procedencia.
    const written = await withTenantContext(app, ctxPatient, async (client) =>
      client.query(
        `update medical_history
            set takes_medication = false, medication_source = 'paciente', medication_source_at = now()
          where patient_id = $1
            and (medication_source is null or medication_source = 'paciente')`,
        [A.patient],
      ),
    );
    expect(written.rowCount).toBe(1);

    // Y su fila de bitácora no puede apuntar al inquilino de otra: el `WITH CHECK` no es
    // `true`, es su propio vínculo aceptado.
    expect({
      own: await whatItSees(
        app,
        ctxPatient,
        `insert into medical_history_audit (practice_id, patient_id, field, previous_value, actor_source)
         values ($1, $2, 'medicacion', 'null'::jsonb, 'paciente')`,
        [A.practice, A.patient],
      ),
      other_tenant: await whatItSees(
        app,
        ctxPatient,
        `insert into medical_history_audit (practice_id, patient_id, field, previous_value, actor_source)
         values ($1, $2, 'medicacion', 'null'::jsonb, 'paciente')`,
        [B.practice, B.patient],
      ),
      // Y no la lee: la bitácora de la ficha es de la consulta.
      read: await whatItSees(app, ctxPatient, 'select id from medical_history_audit'),
    }).toEqual({ own: '0 filas', other_tenant: 'permiso denegado', read: 'permiso denegado' });
  });

  it('el rol de plataforma no lee NADA de las cuatro tablas, que es el punto', async () => {
    expect({
      patient: await whatItSees(app, ctxPlatform, 'select id from patient'),
      patient_link: await whatItSees(app, ctxPlatform, 'select id from patient_link'),
      medical_history: await whatItSees(app, ctxPlatform, 'select id from medical_history'),
      medical_history_audit: await whatItSees(app, ctxPlatform, 'select id from medical_history_audit'),
      // Ni por el correo, que es lo que la consola sí tiene en `account`.
      by_email: await whatItSees(app, ctxPlatform, 'select id from patient where email = $1', [
        'paciente@prueba.local',
      ]),
    }).toEqual({
      patient: 'permiso denegado',
      patient_link: 'permiso denegado',
      medical_history: 'permiso denegado',
      medical_history_audit: 'permiso denegado',
      by_email: 'permiso denegado',
    });
  });

  it('nadie borra una ficha ni un vínculo: la salida es archivar', async () => {
    expect({
      patient: await whatItSees(app, ctxPractitionerA, 'delete from patient where id = $1', [A.patient]),
      link: await whatItSees(app, ctxPractitionerA, 'delete from patient_link where id = $1', [A.link]),
      history: await whatItSees(app, ctxPractitionerA, 'delete from medical_history where id = $1', [A.history]),
      audit: await whatItSees(app, ctxPractitionerA, 'delete from medical_history_audit where practice_id = $1', [
        A.practice,
      ]),
      audit_update: await whatItSees(
        app,
        ctxPractitionerA,
        `update medical_history_audit set previous_value = 'null'::jsonb where practice_id = $1`,
        [A.practice],
      ),
    }).toEqual({
      patient: 'permiso denegado',
      link: 'permiso denegado',
      history: 'permiso denegado',
      audit: 'permiso denegado',
      audit_update: 'permiso denegado',
    });
  });
});

describe('a través de PgBouncer en modo transacción (6432)', () => {
  it('el aislamiento se mantiene cuando dos inquilinos se turnan la misma conexión', async () => {
    // Las dos transacciones salen por el mismo socket de cliente y, con un solo cliente
    // activo, por la misma conexión al servidor. Si el contexto se filtrara, A vería B.
    const ofA = (await read(pooler, ctxPractitionerA, 'select id from practice')).map((r) => r.id);
    const ofB = (await read(pooler, ctxPractitionerB, 'select id from practice')).map((r) => r.id);
    const aAgain = (await read(pooler, ctxPractitionerA, 'select id from practice')).map((r) => r.id);

    expect(ofA).toEqual([A.practice]);
    expect(ofB).toEqual([B.practice]);
    expect(aAgain).toEqual([A.practice]);

    expect({
      aSeesB: await whatItSees(pooler, ctxPractitionerA, 'select id from practice where id = $1', [B.practice]),
      bSeesA: await whatItSees(pooler, ctxPractitionerB, 'select id from practice where id = $1', [A.practice]),
    }).toEqual({ aSeesB: '0 filas', bSeesA: '0 filas' });
  });

  it('el rol adoptado tampoco sobrevive al COMMIT detrás del pooler', async () => {
    await read(pooler, ctxPlatform, 'select id from practice limit 1');

    const client = await pooler.connect();
    try {
      const { rows } = await client.query<{ role: string; practice: string }>(
        `select current_user as role, coalesce(current_setting('medskin.practice_id', true), '') as practice`,
      );
      expect(rows[0]).toEqual({ role: 'medskin', practice: '' });
      await expect(client.query('select id from practice')).rejects.toMatchObject({ code: '42501' });
    } finally {
      client.release();
    }
  });

  it('la fuga que justifica la regla: un SET de sesión SÍ se filtra al siguiente cliente', async () => {
    // Esta prueba no comprueba nuestro código: comprueba el motor. Existe para que la
    // regla 2 de §7.3 no sea folclore. Son tres pasos, en este orden a propósito, porque
    // el segundo ensucia la conexión del servidor y el tercero la deja limpia otra vez.

    // 1 · Lo que hace el ayudante: `set_config(..., true)`. No se filtra.
    await read(pooler, ctxPractitionerA, 'select 1');
    const clean1 = new Pool({ connectionString: poolerUrl, max: 1 });
    try {
      const { rows } = await clean1.query<{ inherited: string }>(
        `select coalesce(current_setting('medskin.practice_id', true), '') as inherited`,
      );
      expect(rows[0]?.inherited).toBe('');
    } finally {
      await clean1.end();
    }

    // 2 · Lo que nadie hace nunca: un `SET` de sesión. Dos sockets de cliente distintos,
    // uno detrás del otro, sobre el mismo PgBouncer en modo transacción.
    const first = new Pool({ connectionString: poolerUrl, max: 1 });
    await first.query(`select set_config('medskin.practice_id', $1, false)`, [A.practice]);
    await first.end(); // el cliente se va; la conexión al servidor vuelve al pool tal cual

    const second = new Pool({ connectionString: poolerUrl, max: 1 });
    let inherited: string;
    try {
      const { rows } = await second.query<{ inherited: string }>(
        `select coalesce(current_setting('medskin.practice_id', true), '') as inherited`,
      );
      inherited = rows[0]?.inherited ?? '';
    } finally {
      await second.end();
    }
    // Si esto dejara de filtrar, hay que revisar la configuración del pooler antes de
    // alegrarse: la regla se escribió porque filtra.
    expect(inherited).toBe(A.practice);

    // 3 · Y se deja la conexión como estaba, que es la otra cara de la misma moneda: lo
    // que un cliente ensucia en sesión se lo come el siguiente, incluida esta prueba.
    const third = new Pool({ connectionString: poolerUrl, max: 1 });
    try {
      await third.query(`select set_config('medskin.practice_id', '', false)`);
      const { rows } = await third.query<{ inherited: string }>(
        `select coalesce(current_setting('medskin.practice_id', true), '') as inherited`,
      );
      expect(rows[0]?.inherited).toBe('');
    } finally {
      await third.end();
    }
  });
});

// =========================================================================================
// LOS PLANES · regla 5 de §7.3: sin un índice que empiece por el inquilino, el predicado de
// la política provoca recorridos completos de tabla. Esto no se razona, se mide:
// `EXPLAIN (ANALYZE, BUFFERS)` por la ruta caliente y con el rol y el contexto de verdad,
// porque el plan CAMBIA cuando la política añade su predicado.
//
// Con cuatro filas cualquier plan es un recorrido y no probaría nada, así que esta suite
// siembra 8 000 fichas con sus antecedentes en cada una de las dos consultas y hace `ANALYZE`. Va al final del archivo a
// propósito: las suites anteriores cuentan filas y esta las multiplica.
// =========================================================================================
describe('los planes de las rutas calientes del tramo 2', () => {
  beforeAll(async () => {
    await owner.query(
      `insert into account (email, role, region, first_name, last_name)
       select 'bulk-' || g || '@prueba.local', 'paciente', 'latam', 'Bulk', 'Paciente'
         from generate_series(1, 1600) g`,
    );
    const bulkPatients = async (t: typeof A, howMany: number) =>
      owner.query(
        `insert into patient (practice_id, first_name, last_name, birth_date, email, phone,
                              how_arrived, status, archived_at)
         select $1::uuid, left(md5(g::text), 9), left(md5((g * 7)::text), 9), '1990-01-01',
                'ficha-' || g || '-' || left($1::uuid::text, 4) || '@prueba.local',
                '+5917' || lpad(g::text, 7, '0'), 'instagram',
                case when g % 10 = 0 then 'archivada' else 'activa' end,
                case when g % 10 = 0 then now() end
           from generate_series(1, $2::int) g`,
        [t.practice, howMany],
      );
    // Una de cada diez archivada, con su `archived_at`: sin él no entra, lo impide
    // `patient_archived_ck`, y así el índice se mide sobre datos con las dos clases.
    await bulkPatients(A, 8_000);
    await bulkPatients(B, 8_000);
    // El `not exists` de aquí abajo no es un adorno: sin él este `insert … select`
    // empareja TODAS las fichas de la base contra las 1 600 cuentas en bloque, y la que
    // siembra `pnpm db:seed` ya tiene vínculo, así que chocaba contra
    // `patient_link_patient_uq` y se llevaba el `beforeAll` entero. La lista de `$1` nombra
    // las dos fichas de esta siembra; lo que faltaba era no contar NINGUNA que ya tuviera
    // uno, venga de donde venga. Con la base sembrada —que es lo normal— fallaba sola, sin
    // que nadie más estuviera corriendo.
    await owner.query(
      `insert into patient_link (practice_id, patient_id, account_id, email, practice_name, practitioner_name)
       select p.practice_id, p.id, a.id, a.email, 'Clinica', 'Dra. Andrea Paz'
         from (select id, practice_id, row_number() over (order by id) as rn
                 from patient p2
                where p2.id <> all($1::uuid[])
                  and not exists (select 1 from patient_link l where l.patient_id = p2.id)) p
         join (select id, email, row_number() over (order by id) as rn
                 from account where email like 'bulk-%') a using (rn)`,
      [[A.patient, B.patient]],
    );
    await owner.query(
      `insert into medical_history (practice_id, patient_id, has_allergies, phototype, phototype_source,
                                    phototype_source_at)
       select p.practice_id, p.id, false, 1 + (random() * 5)::int, 'doctora', now()
         from patient p where p.email like 'ficha-%@prueba.local'`,
    );
    // Las dos bitácoras, para medir los índices de «lo último primero» del tramo 1 sobre
    // una tabla con filas de verdad: 20 000 líneas de auditoría y 10 000 fallos en A, y la
    // mitad en B, que es lo que obliga al motor a elegir entre leer 50 por el índice y
    // ordenar veinte mil.
    const bulkLogs = async (t: typeof A, howMany: number) => {
      await owner.query(
        `insert into access_audit (practice_id, actor_account_id, actor_label, action, occurred_at)
         select $1::uuid, $2::uuid, 'Andrea Paz',
                (array['patient.open', 'patient.create', 'access.resend'])[1 + g % 3],
                now() - (g || ' minutes')::interval
           from generate_series(1, $3::int) g`,
        [t.practice, t.account, howMany],
      );
      await owner.query(
        `insert into service_failure (service, operation, severity, error_code, error_message,
                                      practice_id, trace_id, will_retry, occurred_at)
         select 'api', 'pacientes.alta', 'error',
                (array['fallo_de_servicio', 'imagen_no_procesada'])[1 + g % 2],
                'VipsJpeg: Premature end of input file', $1::uuid, 'bulk-' || g, false,
                now() - (g || ' seconds')::interval
           from generate_series(1, $2::int) g`,
        [t.practice, howMany / 2],
      );
    };
    await bulkLogs(A, 20_000);
    await bulkLogs(B, 10_000);
    // Sesiones: 40 de la paciente y una por cada cuenta en bloque. Las de las otras
    // cuentas son las que hacen que la tabla no quepa en un suspiro, que es lo que obliga
    // al motor a entrar por el índice de la cuenta en vez de recorrerla.
    await owner.query(
      `insert into session (account_id, scope, device_id, last_seen_at)
       select $1::uuid, 'completo', 'disp-plan-' || g, now() - (g || ' hours')::interval
         from generate_series(1, 40) g`,
      [PATIENT.account],
    );
    await owner.query(
      `insert into session (account_id, scope, device_id, last_seen_at)
       select a.id, 'completo', 'disp-bulk', now() - (random() * 100 || ' hours')::interval
         from account a where a.email like 'bulk-%@prueba.local'`,
    );
    await owner.query('vacuum analyze access_audit');
    await owner.query('vacuum analyze service_failure');
    await owner.query('vacuum analyze session');

    // `VACUUM` y no solo `ANALYZE`, y esto es un hallazgo que vale para producción: un GIN
    // recién cargado en bloque tiene TODAS sus entradas en la lista pendiente, y el coste
    // de la lista pendiente entra en el cálculo del planificador, así que mientras no se
    // vacíe el motor prefiere el recorrido completo. En producción lo hace el autovacuum
    // solo; aquí hay que pedirlo, o esta suite mediría el plan de una tabla que acaba de
    // nacer y no el de una tabla viva.
    await owner.query('vacuum analyze patient');
    await owner.query('vacuum analyze patient_link');
    await owner.query('vacuum analyze medical_history');
  }, 120_000);

  afterAll(async () => {
    await owner.query(`delete from patient where email like 'ficha-%@prueba.local'`);
    await owner.query(`delete from account where email like 'bulk-%@prueba.local'`);
    // Las sesiones de las cuentas en bloque se van con sus cuentas; las 40 de la paciente
    // no, porque su cuenta sigue viva. Una suite que mide planes no puede dejar filas
    // detrás: las de después cuentan.
    await owner.query(`delete from session where device_id like 'disp-plan-%'`);
  }, 120_000);

  /** El plan tal cual lo ejecuta el rol de la aplicación, con su política puesta. */
  async function plan(ctx: TenantContext, sql: string, params: unknown[] = []) {
    const rows = await read<{ 'QUERY PLAN': string }>(app, ctx, `explain (analyze, buffers) ${sql}`, params);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  }

  it('la lista de pacientes entra por el índice que empieza por el inquilino', async () => {
    // `GET /v1/patients` sin búsqueda: las activas, las últimas primero. Y sin
    // `where practice_id`: lo pone la política, que es justo lo que hay que medir.
    const used = await plan(
      ctxPractitionerA,
      `select id, first_name, last_name from patient where status = 'activa'
        order by created_at desc limit 50`,
    );
    expect(used).toContain('patient_practice_status_idx');
    expect(used).not.toContain('Seq Scan on patient');
  });

  it('la búsqueda por trigramas entra por el GIN que empieza por el inquilino', async () => {
    // Una búsqueda de verdad es selectiva: «apellido1234» es una ficha, no mil. Con un
    // patrón que acierta a una de cada veinte, el motor hace bien en entrar por el btree
    // del inquilino y filtrar, y eso también es un plan correcto; lo que el GIN evita es
    // el recorrido completo cuando la aguja es fina, que es el caso que la pantalla manda.
    // La aguja sale de una ficha real de A: es el caso de la pantalla —teclear un trozo
    // de un nombre— y no un patrón inventado. Los nombres de la siembra son resúmenes
    // hexadecimales justo para que sus trigramas no sean todos el mismo: con «Nombre1,
    // Nombre2, …» cada trigrama está en las 8 000 filas y el motor hace bien en no entrar
    // por el GIN, que es un artefacto de la siembra y no de los datos de una consulta.
    //
    // Y la aguja sale de una ficha DE LA SIEMBRA EN BLOQUE, no de cualquiera: sin ese
    // filtro, `limit 1` sin `order by` devuelve la fila que esté físicamente primera, que
    // puede ser la ficha a mano de «Valeria Antelo», y entonces la aguja es `aleria a` —con
    // espacio y con una palabra de una sola letra—. pg_trgm parte por palabras, así que los
    // trigramas de «a» están en casi todas las filas, la aguja deja de ser fina y el motor
    // hace bien en entrar por el btree: medido el 28 oct, `Index Scan using
    // patient_practice_status_idx` con `Rows Removed by Filter: 8000`. El plan era correcto
    // y la prueba fallaba igual, y en qué fila cae el `limit 1` depende de cómo esté
    // compactada la tabla ese día. Con el filtro, la aguja son 8 caracteres hexadecimales
    // de UNA palabra, que es lo que esta prueba dice que mide.
    const { rows: needle } = await owner.query<{ needle: string }>(
      `select substr(search_text, 2, 8) as needle from patient
        where practice_id = $1 and email like 'ficha-%@prueba.local' limit 1`,
      [A.practice],
    );
    const used = await plan(ctxPractitionerA, `select id from patient where search_text like $1 limit 50`, [
      `%${needle[0]?.needle}%`,
    ]);
    expect(used).toContain('patient_search_idx');
    expect(used).not.toContain('Seq Scan on patient');
  });

  it('los vínculos de la paciente entran por el índice de cuenta, sin inquilino delante', async () => {
    // La única lectura que cruza inquilinos. No hay `practice_id` que poner delante porque
    // quien pregunta no tiene uno, y por eso este índice es de una sola columna.
    const used = await plan(ctxPatient, 'select id, practice_name from patient_link');
    expect(used).toContain('patient_link_account_idx');
    expect(used).not.toContain('Seq Scan on patient_link');
  });

  it('la autorización del reenvío de acceso entra por (practice_id, account_id)', async () => {
    // `POST /v1/accounts/{account_id}/access`: `EXISTS (... where account_id = $1)` bajo la
    // política del inquilino. Es la consulta literal del contrato.
    const used = await plan(ctxPractitionerA, 'select exists (select 1 from patient_link where account_id = $1)', [
      PATIENT.account,
    ]);
    // `Index ONLY Scan` sobre el compuesto: las dos columnas del predicado están en el
    // índice —la del inquilino la pone la política, la de la cuenta la pone el contrato—,
    // así que la autorización se resuelve sin tocar la tabla. 3 bloques, 0,04 ms.
    expect(used).toMatch(/Index Only Scan using patient_link_practice_account_idx/);
    expect(used).not.toContain('Seq Scan on patient_link');
  });

  it('la bitácora de la consulta se lee por índice, sin ordenar veinte mil líneas', async () => {
    // `order by occurred_at desc` sin `where practice_id`: el inquilino lo pone la
    // política. Es la forma de «lo último primero» que repiten las dos bitácoras.
    const used = await plan(ctxPractitionerA, 'select id, action from access_audit order by occurred_at desc limit 50');
    expect(used).toContain('access_audit_practice_idx');
    expect(used).not.toContain('Sort');
    expect(used).not.toContain('Seq Scan');
  });

  it('los fallos de la consulta y el panel de la consola, lo mismo', async () => {
    const own = await plan(ctxPractitionerA, 'select id from service_failure order by occurred_at desc limit 50');
    expect(own).toContain('service_failure_practice_idx');
    expect(own).not.toContain('Sort');

    // El panel de la consola (§10.4) NO se comprueba aquí, y la razón es un hallazgo que
    // vale escribir: la política de plataforma es `current_user = 'app_platform'`, un
    // predicado opaco sobre el que el planificador aplica su selectividad por omisión
    // —estimó 38 filas de 7 502— y con esa estimación descarta el índice y recorre la
    // tabla. No se arregla con un índice: se arregla con una ventana de tiempo en la
    // consulta (`occurred_at >= $2`, que sí es condición de índice) o particionando
    // `service_failure` por mes, que ya está anotado como respuesta al volumen. No es un
    // problema de aislamiento: es el panel interno leyendo de más.
  });

  it('las sesiones activas de una cuenta entran por su índice parcial', async () => {
    // `GET /v1/access/sessions`: las de SU cuenta, las vivas, la última primero. El índice
    // es parcial (`where revoked_at is null`) y la consulta tiene que decir lo mismo para
    // poder usarlo.
    const used = await plan(
      ctxPatient,
      'select id, device_id from session where revoked_at is null order by last_seen_at desc limit 20',
    );
    expect(used).toContain('session_account_active_idx');
    expect(used).not.toContain('Seq Scan');
  });

  it('los antecedentes de la paciente no recorren la tabla de nadie', async () => {
    const used = await plan(ctxPatient, 'select has_allergies from medical_history where patient_id = $1', [A.patient]);
    expect(used).toContain('medical_history_patient_uq');
    // Y el `EXISTS` de su política tampoco recorre nada: el motor lo convierte en un
    // subplan por `patient_link_account_idx`, que es el índice de SU cara de la política.
    expect(used).toContain('patient_link_account_idx');
    expect(used).not.toContain('Seq Scan');
  });
});

// =========================================================================================
// app_account (0013) · «sé quién eres y no sé qué eres»
//
// El rol del token de recuperación, que a propósito no lleva el rol dentro. Por aquí entra
// una paciente y entra una doctora, así que lo que tiene que poder hacer es exactamente lo
// que los dos endpoints de ese token necesitan —`POST /v1/access/new-password` y
// `GET /v1/accounts/mine`— y nada más. Que una doctora lo adopte NO le da su consulta.
// =========================================================================================
describe('app_account · el rol del token que no dice qué eres', () => {
  it('lee su cuenta, su credencial, sus sesiones y sus vínculos, y nada clínico', async () => {
    expect({
      account: (await read(app, ctxAccountPatient, 'select id from account')).map((r) => r.id),
      credential: (await read(app, ctxAccountPatient, 'select account_id from credential')).map((r) => r.account_id),
      session: (await read(app, ctxAccountPatient, 'select id from session')).map((r) => r.id),
      // Los dos vínculos: `GET /v1/accounts/mine` devuelve `doctoras[]` también con una
      // sesión restringida, y si no pudiera leerlos le mentiría con una lista vacía.
      links: (await read(app, ctxAccountPatient, 'select practice_name from patient_link'))
        .map((r) => r.practice_name)
        .sort(),
    }).toEqual({
      account: [PATIENT.account],
      credential: [PATIENT.account],
      session: [PATIENT.session],
      links: ['Clinica A', 'Clinica B'],
    });

    expect({
      hash: await whatItSees(app, ctxAccountPatient, 'select hash from credential'),
      medical_history: await whatItSees(app, ctxAccountPatient, 'select id from medical_history'),
      medical_history_audit: await whatItSees(app, ctxAccountPatient, 'select id from medical_history_audit'),
      patient: await whatItSees(app, ctxAccountPatient, 'select id from patient'),
      practice: await whatItSees(app, ctxAccountPatient, 'select name from practice'),
      practitioner: await whatItSees(app, ctxAccountPatient, 'select first_name from practitioner'),
      license: await whatItSees(app, ctxAccountPatient, 'select id from license'),
      recovery_code: await whatItSees(app, ctxAccountPatient, 'select id from recovery_code'),
      // Aceptar o rechazar a una doctora es un acto de una sesión completa, no de una a
      // medio abrir: no hay `UPDATE` sobre el vínculo.
      accept: await whatItSees(app, ctxAccountPatient, `update patient_link set status = 'vinculada'`),
      // Y la cuenta de otra no se ve ni nombrándola.
      otherAccount: await whatItSees(app, ctxAccountPatient, 'select id from account where id = $1', [A.account]),
    }).toEqual({
      hash: 'permiso denegado',
      medical_history: 'permiso denegado',
      medical_history_audit: 'permiso denegado',
      patient: 'permiso denegado',
      practice: 'permiso denegado',
      practitioner: 'permiso denegado',
      license: 'permiso denegado',
      recovery_code: 'permiso denegado',
      accept: 'permiso denegado',
      otherAccount: '0 filas',
    });
  });

  it('una doctora que entra por este rol no se trae su consulta con ella', async () => {
    // Es el caso que da nombre al rol: su token de recuperación no dice que es doctora, y
    // adoptar este rol no le abre nada de su inquilino. Lo suyo propio sí: si no, no podría
    // elegir su contraseña.
    expect({
      account: (await read(app, ctxAccountPractitioner, 'select id from account')).map((r) => r.id),
      practice: await whatItSees(app, ctxAccountPractitioner, 'select id from practice'),
      practitioner: await whatItSees(app, ctxAccountPractitioner, 'select id from practitioner'),
      patient: await whatItSees(app, ctxAccountPractitioner, 'select id from patient'),
      // Puede consultar `patient_link`, y no ve ninguno: no tiene vínculos de paciente, y
      // los de SU consulta no son suyos por cuenta. Cero filas, no las de su inquilino.
      links: await whatItSees(app, ctxAccountPractitioner, 'select id from patient_link'),
    }).toEqual({
      account: [A.account],
      practice: 'permiso denegado',
      practitioner: 'permiso denegado',
      patient: 'permiso denegado',
      links: '0 filas',
    });
  });

  it('el ayudante no le deja fijar un inquilino', async () => {
    await expect(
      withTenantContext(app, { role: 'app_account', accountId: A.account, practiceId: A.practice }, () =>
        Promise.resolve(null),
      ),
    ).rejects.toThrow(/app_account no fija practiceId/);
    await expect(
      withTenantContext(app, { role: 'app_account' }, () => Promise.resolve(null)),
    ).rejects.toThrow(/exige accountId/);
  });
});
