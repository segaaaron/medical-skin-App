// El repositorio de `inquilinos.md` CONTRA LA BASE REAL, porque es lo único que puede
// probar lo que decide de verdad qué lee este rol: los `GRANT` por columna y las políticas.
// Con dobles eso es invisible —una columna de más no falla al compilar— y en la pantalla
// real muere con «permiso denegado».
//
// Mismas reglas que `isolation.spec.ts` y `practice-license.spec.ts`: siembra el DUEÑO del
// esquema, que es quien migra; todo lo que se COMPRUEBA pasa por `app_practitioner` y por
// `withTenantContext()`. En ningún momento se desactiva RLS.
//
// Lo que NO se repite aquí porque ya está probado en `practice-license.spec.ts`: que la
// fila de `license` nace con la consulta, que la doctora no tiene `INSERT` sobre `license`,
// que no mueve `status` por `UPDATE` directo, y el plan del recuento del plan con 4.400
// fichas.

import { Pool, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import type { RememberedResponse, Submission } from '../domain/ports';
import { TenantsRepository } from './tenants.repository';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl =
  process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

// Hash con la forma que exige el `CHECK` de `credential`, de una contraseña que no se
// guardó: aquí no se verifica ninguna.
const HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$c2VtaWxsYWRlcHJ1ZWJh$BcVqHhiTZ4RrQZ4kYgVvxCuUAneDdfTxZ6qz6hUwcLY';

/** A envía su licencia. Es también la que mide el aislamiento: tiene a B al lado. */
const A = {
  practice: 'eeeeeeee-0000-4000-8000-00000000000a',
  owner: 'eeeeeeee-0000-4000-8000-00000000001a',
};
/** B es la consulta de al lado, con licencia verificada y sus propias fichas. */
const B = {
  practice: 'eeeeeeee-0000-4000-8000-00000000000b',
  owner: 'eeeeeeee-0000-4000-8000-00000000001b',
};
/** C ya mandó su licencia cinco veces hoy. */
const C = {
  practice: 'eeeeeeee-0000-4000-8000-00000000000c',
  owner: 'eeeeeeee-0000-4000-8000-00000000001c',
};
/** D tiene dueña y recepción: la que prueba que recepción no es la dueña. */
const D = {
  practice: 'eeeeeeee-0000-4000-8000-00000000000d',
  owner: 'eeeeeeee-0000-4000-8000-00000000001d',
  reception: 'eeeeeeee-0000-4000-8000-00000000002d',
};

const PRACTICES = [A.practice, B.practice, C.practice, D.practice];

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 1 });
const repository = new TenantsRepository(app);

function ctx(practice: string, account: string): TenantContext {
  return { role: 'app_practitioner', practiceId: practice, accountId: account };
}

async function read<T extends QueryResultRow>(
  context: TenantContext,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withTenantContext(app, context, async (c) => (await c.query<T>(sql, params)).rows);
}

async function seedPractice(p: {
  practice: string;
  account: string;
  name: string;
  licenseStatus: string;
  city?: string | null;
}) {
  await owner.query(
    `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit,
                           plan_renews_on, address, city, phone, internal_note)
     values ($1, $2, 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300,
             '2026-11-14', 'Av. Ballivián 1240', $3, '+591 3 342 1180', 'Vino por el webinar')`,
    [p.practice, p.name, p.city ?? 'Santa Cruz'],
  );
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'practitioner', 'latam', 'Andrea', 'Paz')`,
    [p.account, `duena.${p.practice.slice(-1)}@tenants.local`],
  );
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, set_at) values ($1, $2, false, now())`,
    [p.account, HASH],
  );
  await owner.query(
    `insert into practitioner (practice_id, account_id, first_name, last_name, role)
     values ($1, $2, 'Andrea', 'Paz', 'doctora')`,
    [p.practice, p.account],
  );
  await owner.query('update practice set owner_account_id = $1 where id = $2', [
    p.account,
    p.practice,
  ]);
  // La fila de `license` la pone aquí la siembra del dueño del esquema, igual que
  // `practice-license.spec.ts`: una consulta insertada a mano no pasa ni por la función del
  // alta ni por el relleno de la 0015.
  await owner.query(`insert into license (practice_id, status) values ($1, $2)`, [
    p.practice,
    p.licenseStatus,
  ]);
}

/** `howMany` fichas, una de cada cuatro archivada: las archivadas no cuentan en el plan. */
async function seedPatients(practice: string, howMany: number) {
  await owner.query(
    `insert into patient (practice_id, first_name, last_name, birth_date, email, how_arrived,
                          status, archived_at)
     select $1::uuid, 'Ficha' || g, 'Paz', '1990-01-01',
            'ficha-' || g || '-' || left($1::uuid::text, 8) || '@tenants.local', 'instagram',
            case when g % 4 = 0 then 'archivada' else 'activa' end,
            case when g % 4 = 0 then now() end
       from generate_series(1, $2::int) g`,
    [practice, howMany],
  );
}

async function clean() {
  await owner.query('delete from practice where id = any($1::uuid[])', [PRACTICES]);
  await owner.query(`delete from account where email like '%@tenants.local'`);
  // `access_audit` no tiene claves foráneas a propósito (§12.2.8): sobrevive a lo que
  // describe, así que se limpia a mano.
  await owner.query('delete from access_audit where practice_id = any($1::uuid[])', [PRACTICES]);
  // Las claves de idempotencia de este spec: ahora el envío guarda su fila, así que sin esta
  // línea la segunda corrida encontraría la clave de la primera y leería su respuesta
  // guardada —que es exactamente lo que el mecanismo tiene que hacer, y no lo que este caso
  // quiere probar—.
  await owner.query('delete from idempotency_key where key like $1', ['licencia-%']);
}

beforeAll(async () => {
  await clean();
  await seedPractice({
    practice: A.practice,
    account: A.owner,
    name: 'Clínica Paz',
    licenseStatus: 'sin_enviar',
  });
  await seedPractice({
    practice: B.practice,
    account: B.owner,
    name: 'Clínica Vecina',
    licenseStatus: 'verificada',
  });
  await seedPractice({
    practice: C.practice,
    account: C.owner,
    name: 'Clínica Insistente',
    licenseStatus: 'sin_enviar',
  });
  await seedPractice({
    practice: D.practice,
    account: D.owner,
    name: 'Clínica Equipo',
    licenseStatus: 'sin_enviar',
  });

  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, 'recepcion@tenants.local', 'practitioner', 'latam', 'Lucía', 'Vargas')`,
    [D.reception],
  );
  await owner.query(
    `insert into practitioner (practice_id, account_id, first_name, last_name, role)
     values ($1, $2, 'Lucía', 'Vargas', 'recepcion')`,
    [D.practice, D.reception],
  );

  await seedPatients(A.practice, 8); // 6 activas, 2 archivadas
  await seedPatients(B.practice, 40); // la consulta de al lado, que no se cuenta
});

afterAll(async () => {
  await clean();
  await owner.end();
  await app.end();
});

describe('GET /v1/tenants/mine · contra las políticas y los grants de verdad', () => {
  it('sirve la consulta, su licencia y el recuento de fichas ACTIVAS de ESTA consulta', async () => {
    const snapshot = await repository.read({ accountId: A.owner, practiceId: A.practice });

    expect(snapshot).toMatchObject({
      id: A.practice,
      name: 'Clínica Paz',
      address: 'Av. Ballivián 1240',
      city: 'Santa Cruz',
      phone: '+591 3 342 1180',
      logoUrl: null,
      region: 'latam',
      timeZone: 'America/La_Paz',
      currency: 'BOB',
      plan: 'consultorio',
      patientLimit: 300,
      // `date` de Postgres llega ya como texto: no hay hora que convertir ni zona que elegir.
      planRenewsOn: '2026-11-14',
      // Ocho fichas, dos archivadas: seis. Las 40 de la consulta de al lado no entran, y no
      // porque el `where` las excluya —no las nombra— sino porque la política no las deja.
      activePatients: 6,
      license: { status: 'sin_enviar', submittedAt: null, rejectionReason: null },
      firstDay: { practiceData: false, schedule: false, firstTreatment: false, dismissed: false },
    });
  });

  it('`internal_note` no se puede leer: es «solo consola» por un grant que no existe', async () => {
    // Si alguien añade esta columna al `select` del repositorio, la pantalla entera muere
    // con «permiso denegado» y no con un campo de más. Un privilegio de columna se comprueba
    // ANTES que la política.
    await expect(
      read(ctx(A.practice, A.owner), 'select internal_note from practice'),
    ).rejects.toThrow(/permission denied for (table|column)/i);
  });

  it('el inquilino A no ve ni una fila del B: una consulta, una licencia, sus fichas', async () => {
    const practices = await read<{ id: string }>(
      ctx(A.practice, A.owner),
      'select id from practice',
    );
    expect(practices).toEqual([{ id: A.practice }]);

    const licenses = await read<{ practice_id: string }>(
      ctx(A.practice, A.owner),
      'select practice_id from license',
    );
    expect(licenses).toEqual([{ practice_id: A.practice }]);

    // Y la lectura del vecino desde su propio contexto devuelve lo suyo, no lo de A: la
    // misma consulta, dos inquilinos, dos respuestas.
    const vecina = await repository.read({ accountId: B.owner, practiceId: B.practice });
    expect(vecina?.name).toBe('Clínica Vecina');
    expect(vecina?.activePatients).toBe(30);
    expect(vecina?.license.status).toBe('verificada');
  });
});

describe('POST /v1/tenants/mine/license · contra la función de verdad', () => {
  const form = {
    practiceCountry: 'BO',
    specialty: 'medicina_estetica',
    licenseNumber: '48921',
    credentialKey: `lic/${A.practice}/4f2a.pdf`,
  };
  const inTwoDays = () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

  /**
   * La clave de cada envío, distinta por caso: la misma dos veces es una repetición a
   * propósito y tiene su propio caso. `respond` es lo que el repositorio guarda DENTRO de la
   * transacción, y devuelve nulo para los veredictos que no se repiten.
   */
  let claves = 0;
  const envio = (): { idempotency: IdempotencyRecord; respond: (s: Submission) => RememberedResponse } => {
    claves += 1;
    return {
      idempotency: { key: `licencia-${claves}`, bodyHash: `huella-${claves}` },
      respond: (s) => (s.verdict === 'submitted' ? { status: 202, response: { estado: s.status } } : null),
    };
  };

  it('escribe el formulario, mueve el estado con la función y deja su fila en la bitácora', async () => {
    const { submission } = await repository.submit({
      owner: { accountId: A.owner, practiceId: A.practice },
      form,
      responseEstimatedAt: inTwoDays(),
      ...envio(),
    });

    expect(submission.verdict).toBe('submitted');
    expect(submission.status).toBe('en_revision');
    expect(submission.submittedAt).toBeInstanceOf(Date);
    expect(submission.responseEstimatedAt).toBeInstanceOf(Date);

    // Las seis columnas del formulario entraron bajo el grant de la doctora, y el estado lo
    // movió la función: ella no tiene `UPDATE` sobre `status`.
    const license = await read<{
      status: string;
      license_number: string;
      credential_key: string;
      declaration_accepted: boolean;
      terms_accepted: boolean;
    }>(
      ctx(A.practice, A.owner),
      `select status, license_number, credential_key, declaration_accepted, terms_accepted
         from license`,
    );
    expect(license[0]).toEqual({
      status: 'en_revision',
      license_number: '48921',
      credential_key: `lic/${A.practice}/4f2a.pdf`,
      declaration_accepted: true,
      terms_accepted: true,
    });

    // La bitácora es la que cuenta los cinco envíos del día, así que su fila no es un
    // adorno: sin ella el `429` no existe.
    const audit = await read<{ action: string; actor_label: string }>(
      ctx(A.practice, A.owner),
      `select action, actor_label from access_audit where action = 'license.to_review'`,
    );
    expect(audit).toEqual([{ action: 'license.to_review', actor_label: 'Andrea Paz' }]);
  });

  it('el segundo envío del mismo caso es `already_in_review`, y no escribe nada', async () => {
    const { submission } = await repository.submit({
      owner: { accountId: A.owner, practiceId: A.practice },
      form: { ...form, licenseNumber: '00000' },
      responseEstimatedAt: inTwoDays(),
      ...envio(),
    });

    expect(submission.verdict).toBe('already_in_review');
    // El `UPDATE` tocó cero filas porque su política solo deja escribir en `sin_enviar` o
    // `rechazada`: el acotado está en la base y no en el `where` del repositorio.
    const license = await read<{ license_number: string }>(
      ctx(A.practice, A.owner),
      'select license_number from license',
    );
    expect(license).toEqual([{ license_number: '48921' }]);
  });

  it('una licencia ya verificada es `already_verified`', async () => {
    const { submission } = await repository.submit({
      owner: { accountId: B.owner, practiceId: B.practice },
      form: { ...form, credentialKey: `lic/${B.practice}/4f2a.pdf` },
      responseEstimatedAt: inTwoDays(),
      ...envio(),
    });

    expect(submission.verdict).toBe('already_verified');
  });

  it('recepción no es la dueña: `not_owner`, y lo decide `practice.owner_account_id`', async () => {
    const { submission } = await repository.submit({
      owner: { accountId: D.reception, practiceId: D.practice },
      form: { ...form, credentialKey: `lic/${D.practice}/4f2a.pdf` },
      responseEstimatedAt: inTwoDays(),
      ...envio(),
    });

    expect(submission.verdict).toBe('not_owner');
    // El estado no se movió: el formulario sí se escribió —su política lo deja, porque es de
    // su consulta— y la transición no.
    const license = await read<{ status: string }>(
      ctx(D.practice, D.reception),
      'select status from license',
    );
    expect(license).toEqual([{ status: 'sin_enviar' }]);
  });

  it('con cinco envíos en la bitácora de las últimas 24 h, el sexto es `too_many`', async () => {
    await owner.query(
      `insert into access_audit (practice_id, actor_account_id, actor_label, action, subject_type,
                                 region, occurred_at)
       select $1::uuid, $2::uuid, 'Andrea Paz', 'license.to_review', 'license', 'latam',
              now() - (g || ' hours')::interval
         from generate_series(1, 5) g`,
      [C.practice, C.owner],
    );

    const { submission } = await repository.submit({
      owner: { accountId: C.owner, practiceId: C.practice },
      form: { ...form, credentialKey: `lic/${C.practice}/4f2a.pdf` },
      responseEstimatedAt: inTwoDays(),
      ...envio(),
    });

    expect(submission.verdict).toBe('too_many');
    // El límite va PRIMERO y dentro de la transacción: no se escribió ni el formulario, así
    // que «espera a que la revisemos» es verdad y no hay nada a medias.
    const license = await read<{ status: string; license_number: string | null }>(
      ctx(C.practice, C.owner),
      'select status, license_number from license',
    );
    expect(license).toEqual([{ status: 'sin_enviar', license_number: null }]);
  });

  it('los envíos de otra consulta no cuentan contra los cinco: el recuento va por política', async () => {
    // Los cinco de C siguen en la bitácora. D manda el suyo y entra: si el recuento no
    // estuviera acotado por el inquilino, este sería el sexto.
    await owner.query(`update license set status = 'sin_enviar' where practice_id = $1`, [
      D.practice,
    ]);

    const { submission } = await repository.submit({
      owner: { accountId: D.owner, practiceId: D.practice },
      form: { ...form, credentialKey: `lic/${D.practice}/4f2a.pdf` },
      responseEstimatedAt: inTwoDays(),
      ...envio(),
    });

    expect(submission.verdict).toBe('submitted');
  });
});
