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
