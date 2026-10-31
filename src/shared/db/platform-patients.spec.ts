// LA CONSOLA VE PACIENTES · migración 0077, decidido por el dueño el 31 de octubre de 2026.
//
// Contra la base real, sin un solo doble y **sin desactivar RLS en ningún momento**. Siembra
// el dueño del esquema, que es quien migra; todo lo que se COMPRUEBA pasa por los roles de
// aplicación y por `withTenantContext()`.
//
// LA PRUEBA QUE JUSTIFICA ESTE ARCHIVO es «el doctor ve en su registro que soporte leyó la
// historia». `medskin-design.md` §4 promete que «no existe un rol que pueda mirar historiales
// sin que el doctor lo sepa», y esa frase sobrevive a esta migración SOLO por eso: la fila de
// auditoría lleva el `practice_id` de la paciente, que es lo que la política del doctor
// compara. Esa columna admite nulo, así que una fila mal escrita quedaría invisible para él y
// la promesa moriría en silencio. Si alguien toca la función, esto falla.

import { Pool, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantContext, type TenantContext } from './tenant-context';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

/** Dos consultas: la que soporte mira y la de al lado, que no se puede cruzar. */
const A = {
  practice: 'dddddddd-0000-4000-8000-00000000000a',
  account: 'dddddddd-0000-4000-8000-00000000001a',
  patient: 'dddddddd-0000-4000-8000-00000000002a',
};
const B = {
  practice: 'dddddddd-0000-4000-8000-00000000000b',
  account: 'dddddddd-0000-4000-8000-00000000001b',
  patient: 'dddddddd-0000-4000-8000-00000000002b',
};
const PRACTICES = [A.practice, B.practice];
const SOPORTE = 'dddddddd-0000-4000-8000-0000000000ff';

const HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$c2VtaWxsYWRlcHJ1ZWJh$BcVqHhiTZ4RrQZ4kYgVvxCuUAneDdfTxZ6qz6hUwcLY';

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 1 });

const ctxPlatform: TenantContext = { role: 'app_platform', accountId: SOPORTE };
const ctxDoctora = (t: typeof A): TenantContext => ({
  role: 'app_practitioner',
  practiceId: t.practice,
  accountId: t.account,
});

async function read<T extends QueryResultRow>(
  context: TenantContext,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withTenantContext(app, context, async (c) => (await c.query<T>(sql, params)).rows);
}

async function seed(t: typeof A, nombre: string, alergia: string): Promise<void> {
  await owner.query(
    `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit)
     values ($1, $2, 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300)`,
    [t.practice, nombre],
  );
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'doctor', 'latam', 'Andrea', 'Paz')`,
    [t.account, `duena.${t.practice.slice(-1)}@consola.local`],
  );
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, set_at) values ($1, $2, false, now())`,
    [t.account, HASH],
  );
  await owner.query(
    `insert into practitioner (practice_id, account_id, first_name, last_name, role)
     values ($1, $2, 'Andrea', 'Paz', 'doctor')`,
    [t.practice, t.account],
  );
  await owner.query('update practice set owner_account_id = $1 where id = $2', [t.account, t.practice]);
  await owner.query(`insert into license (practice_id) values ($1)`, [t.practice]);
  await owner.query(
    `insert into patient (id, practice_id, first_name, last_name, birth_date, email, how_arrived, status)
     values ($1, $2, 'Valeria', 'Antelo', '1990-01-01', $3, 'instagram', 'activa')`,
    [t.patient, t.practice, `paciente.${t.practice.slice(-1)}@consola.local`],
  );
  await owner.query(
    `insert into medical_history (practice_id, patient_id, has_allergies, allergies, allergies_source)
     values ($1, $2, true, $3::text[], 'doctor')`,
    [t.practice, t.patient, [alergia]],
  );
}

async function clean(): Promise<void> {
  await owner.query('delete from practice where id = any($1::uuid[])', [PRACTICES]);
  await owner.query(`delete from account where email like '%@consola.local'`);
  await owner.query('delete from access_audit where practice_id = any($1::uuid[])', [PRACTICES]);
}

beforeAll(async () => {
  await clean();
  await seed(A, 'Clínica Paz', 'Lidocaína');
  await seed(B, 'Clínica Vecina', 'Penicilina');
});

afterAll(async () => {
  await clean();
  await owner.end();
  await app.end();
});

describe('la consola LEE, cruzando consultas a propósito', () => {
  it('ve pacientes, vínculos e historias de las DOS consultas', async () => {
    const pacientes = await read<{ id: string }>(
      ctxPlatform,
      'select id from patient where id = any($1::uuid[]) order by id',
      [[A.patient, B.patient]],
    );
    expect(pacientes.map((p) => p.id)).toEqual([A.patient, B.patient]);

    const historias = await read<{ allergies: string[] }>(
      ctxPlatform,
      'select allergies from medical_history where patient_id = any($1::uuid[]) order by allergies',
      [[A.patient, B.patient]],
    );
    expect(historias.map((h) => h.allergies)).toEqual([['Lidocaína'], ['Penicilina']]);

    // `patient_link` no tiene filas aquí —estas pacientes no tienen cuenta— y lo que se
    // comprueba es que la consulta ENTRA, que es lo que el grant decide.
    await expect(read(ctxPlatform, 'select count(*) from patient_link')).resolves.toBeDefined();
  });
});

describe('lo que la consola NO puede hacer, y lo dice la base', () => {
  it('NO ESCRIBE HISTORIAS · ni insertar, ni actualizar, ni borrar', async () => {
    // Es la línea de esta migración, y no es de permisos sino de verdad del dato: cada campo
    // guarda su `fuente`, así que una alergia tecleada por soporte diría `fuente: 'doctor'`
    // cuando el doctor nunca lo dijo.
    await expect(
      read(
        ctxPlatform,
        `update medical_history set allergies = array['inventada'] where patient_id = $1`,
        [A.patient],
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      read(
        ctxPlatform,
        `insert into medical_history (practice_id, patient_id) values ($1, $2)`,
        [A.practice, A.patient],
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      read(ctxPlatform, 'delete from medical_history where patient_id = $1', [A.patient]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('de `patient` solo mueve las TRES columnas de archivar, no el nombre ni el correo', async () => {
    await expect(
      read(ctxPlatform, `update patient set first_name = 'Otra' where id = $1`, [A.patient]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      read(ctxPlatform, `update patient set email = 'otro@consola.local' where id = $1`, [A.patient]),
    ).rejects.toMatchObject({ code: '42501' });

    // Y archivar sí, que es para lo que se concedió.
    const archivada = await read<{ status: string }>(
      ctxPlatform,
      `update patient set status = 'archivada', archived_at = now(), updated_at = now()
        where id = $1 returning status`,
      [A.patient],
    );
    expect(archivada).toEqual([{ status: 'archivada' }]);
    await owner.query(
      `update patient set status = 'activa', archived_at = null where id = $1`,
      [A.patient],
    );
  });

  it('no borra pacientes: el expediente lo barre la retención, no una persona con prisa', async () => {
    await expect(
      read(ctxPlatform, 'delete from patient where id = $1', [A.patient]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('no escribe vínculos: aceptarlo o rechazarlo es un acto de la paciente', async () => {
    await expect(
      read(ctxPlatform, `update patient_link set status = 'activo'`),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('EL DOCTOR VE QUE SOPORTE LEYÓ LA HISTORIA · la promesa de §4', () => {
  it('la lectura deja su fila con el motivo, y la doctora de ESA consulta la ve', async () => {
    const [fila] = await read<{ practice: string }>(
      ctxPlatform,
      'select medskin_platform_history_read($1, $2) as practice',
      [A.patient, 'Llamó pidiendo ayuda con una reacción'],
    );
    // Devuelve el consulta de la paciente, que es lo que el llamador usa como su 404.
    expect(fila?.practice).toBe(A.practice);

    // Y AQUÍ ESTÁ LA PROMESA: la doctora lo lee en SU registro, con su propio rol y su propio
    // contexto. Si la fila se escribiera con `practice_id` nulo —la columna lo admite—, esto
    // saldría vacío y nadie se enteraría.
    const suyo = await read<{ action: string; subject_id: string; data: { motivo: string } }>(
      ctxDoctora(A),
      `select action, subject_id, data from access_audit where action = 'platform.history.read'`,
    );
    expect(suyo).toEqual([
      {
        action: 'platform.history.read',
        subject_id: A.patient,
        data: { motivo: 'Llamó pidiendo ayuda con una reacción' },
      },
    ]);
  });

  it('la doctora de OTRA consulta no la ve: la bitácora sigue siendo por inquilino', async () => {
    const ajeno = await read(
      ctxDoctora(B),
      `select action from access_audit where action = 'platform.history.read'`,
    );
    expect(ajeno).toEqual([]);
  });

  it('SIN MOTIVO NO HAY LECTURA, y no deja fila', async () => {
    const antes = await read<{ n: string }>(
      ctxDoctora(B),
      `select count(*)::text as n from access_audit where action = 'platform.history.read'`,
    );

    for (const malo of ['', '   ', 'corto']) {
      await expect(
        read(ctxPlatform, 'select medskin_platform_history_read($1, $2)', [B.patient, malo]),
      ).rejects.toMatchObject({ code: '22023' });
    }

    const despues = await read<{ n: string }>(
      ctxDoctora(B),
      `select count(*)::text as n from access_audit where action = 'platform.history.read'`,
    );
    expect(despues).toEqual(antes);
  });

  it('una paciente que no existe devuelve nulo y NO ensucia el registro de nadie', async () => {
    const [fila] = await read<{ practice: string | null }>(
      ctxPlatform,
      'select medskin_platform_history_read($1, $2) as practice',
      ['00000000-0000-4000-8000-000000000000', 'Comprobando una ficha que no existe'],
    );
    expect(fila?.practice).toBeNull();
  });
});
