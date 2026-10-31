// El repositorio de `consultas.md` CONTRA LA BASE REAL, porque es lo único que puede
// probar lo que decide de verdad qué lee este rol: los `GRANT` por columna y las políticas.
// Con dobles eso es invisible —una columna de más no falla al compilar— y en la pantalla
// real muere con «permiso denegado».
//
// Mismas reglas que `isolation.spec.ts` y `practice-license.spec.ts`: siembra el DUEÑO del
// esquema, que es quien migra; todo lo que se COMPRUEBA pasa por `app_practitioner` y por
// `withTenantContext()`. En ningún momento se desactiva RLS.
//
// Lo que NO se repite aquí porque ya está probado en `practice-license.spec.ts`: que la
// fila de `license` nace con la consulta, que la doctora no tiene `INSERT` sobre `license`, y
// el plan del recuento del plan con 4.400 fichas.

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
/** B es la consulta de al lado, con sus propias fichas: es la que mide el aislamiento. */
const B = {
  practice: 'eeeeeeee-0000-4000-8000-00000000000b',
  owner: 'eeeeeeee-0000-4000-8000-00000000001b',
};
/** C ya declaró su matrícula cinco veces hoy: es la del `429`. */
const C = {
  practice: 'eeeeeeee-0000-4000-8000-00000000000c',
  owner: 'eeeeeeee-0000-4000-8000-00000000001c',
};
/** D tiene dueña y otra persona del equipo: la que prueba que esa otra no es la dueña. */
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

/** Sin `licenseStatus`: la licencia no tiene estado desde la 0072. */
async function seedPractice(p: {
  practice: string;
  account: string;
  name: string;
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
     values ($1, $2, 'doctor', 'latam', 'Andrea', 'Paz')`,
    [p.account, `duena.${p.practice.slice(-1)}@tenants.local`],
  );
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, set_at) values ($1, $2, false, now())`,
    [p.account, HASH],
  );
  await owner.query(
    `insert into practitioner (practice_id, account_id, first_name, last_name, role)
     values ($1, $2, 'Andrea', 'Paz', 'doctor')`,
    [p.practice, p.account],
  );
  await owner.query('update practice set owner_account_id = $1 where id = $2', [
    p.account,
    p.practice,
  ]);
  // La fila de `license` la pone aquí la siembra del dueño del esquema, igual que
  // `practice-license.spec.ts`: una consulta insertada a mano no pasa ni por la función del
  // alta ni por el relleno de la 0015.
  await owner.query(`insert into license (practice_id) values ($1)`, [p.practice]);
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
  await seedPractice({ practice: A.practice, account: A.owner, name: 'Clínica Paz' });
  await seedPractice({ practice: B.practice, account: B.owner, name: 'Clínica Vecina' });
  await seedPractice({ practice: C.practice, account: C.owner, name: 'Clínica Insistente' });
  await seedPractice({ practice: D.practice, account: D.owner, name: 'Clínica Equipo' });

  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, 'otra.del.equipo@tenants.local', 'doctor', 'latam', 'Lucía', 'Vargas')`,
    [D.reception],
  );
  await owner.query(
    `insert into practitioner (practice_id, account_id, first_name, last_name, role)
     values ($1, $2, 'Lucía', 'Vargas', 'doctor')`,
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
  it('sirve la consulta, lo declarado y el recuento de fichas ACTIVAS de ESTA consulta', async () => {
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
      // La semilla no declaró nada: los cuatro campos nulos, y NO un estado inventado.
      license: {
        practiceCountry: null,
        specialty: null,
        licenseNumber: null,
        declaredAt: null,
      },
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

  it('la consulta A no ve ni una fila del B: una consulta, una licencia, sus fichas', async () => {
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
    // misma consulta, dos consultas, dos respuestas.
    const vecina = await repository.read({ accountId: B.owner, practiceId: B.practice });
    expect(vecina?.name).toBe('Clínica Vecina');
    expect(vecina?.activePatients).toBe(30);
  });
});

describe('POST /v1/tenants/mine/license · contra las políticas y los grants de verdad', () => {
  // TRES CAMPOS, no seis: `credencial_clave`, `declaracion_aceptada` y `terminos_aceptados` se
  // fueron con la revisión manual (migración 0072).
  const form = {
    practiceCountry: 'BO',
    specialty: 'medicina_estetica',
    licenseNumber: '48921',
  };

  /**
   * La clave de cada guardado, distinta por caso: la misma dos veces es una repetición a
   * propósito y tiene su propio caso. `respond` es lo que el repositorio guarda DENTRO de la
   * transacción, y devuelve nulo para los veredictos que no se repiten.
   */
  let claves = 0;
  const envio = (): { idempotency: IdempotencyRecord; respond: (s: Submission) => RememberedResponse } => {
    claves += 1;
    return {
      idempotency: { key: `licencia-${claves}`, bodyHash: `huella-${claves}` },
      respond: (s) =>
        s.verdict === 'saved' ? { status: 200, response: { declarada_en: s.declaredAt } } : null,
    };
  };

  it('escribe las tres columnas bajo SU grant y deja su fila en la bitácora', async () => {
    const { submission } = await repository.submit({
      owner: { accountId: A.owner, practiceId: A.practice },
      form,
      ...envio(),
    });

    expect(submission.verdict).toBe('saved');
    // La hora la pone la BASE, con el `returning updated_at` del mismo `UPDATE`: no se
    // reconstruye con el reloj del proceso.
    expect(submission.declaredAt).toBeInstanceOf(Date);

    // Las tres columnas entraron bajo el `GRANT UPDATE` de la doctora, y ya no hay función de
    // base en medio: `medskin_license_to_review()` se borró con la 0072.
    const license = await read<{ license_number: string; specialty: string; practice_country: string }>(
      ctx(A.practice, A.owner),
      'select license_number, specialty, practice_country from license',
    );
    expect(license[0]).toEqual({
      license_number: '48921',
      specialty: 'medicina_estetica',
      practice_country: 'BO',
    });

    // La bitácora es la que cuenta los cinco guardados del día, así que su fila no es un
    // adorno: sin ella el `429` no existe. Y es además el registro que sostiene «responde
    // quien lo declaró», que es la razón por la que MedSkin puede guardar esto sin verificarlo.
    const audit = await read<{ action: string; actor_label: string }>(
      ctx(A.practice, A.owner),
      `select action, actor_label from access_audit where action = 'license.declared'`,
    );
    expect(audit).toEqual([{ action: 'license.declared', actor_label: 'Andrea Paz' }]);
  });

  it('EL SEGUNDO GUARDADO GANA: es un formulario y ya no hay transición que lo pare', async () => {
    // Antes esto era `already_in_review`: la política de la doctora solo la dejaba escribir
    // con la licencia en `sin_enviar` o `rechazada`, así que el segundo `UPDATE` tocaba cero
    // filas y la matrícula vieja se quedaba. La 0072 le quitó ese `AND status IN (...)`.
    const { submission } = await repository.submit({
      owner: { accountId: A.owner, practiceId: A.practice },
      form: { ...form, licenseNumber: '00000' },
      ...envio(),
    });

    expect(submission.verdict).toBe('saved');
    const license = await read<{ license_number: string }>(
      ctx(A.practice, A.owner),
      'select license_number from license',
    );
    expect(license).toEqual([{ license_number: '00000' }]);
  });

  it('otra persona del equipo no es la dueña: `not_owner`, y lo decide `practice.owner_account_id`', async () => {
    // Llega con el mismo cuerpo y el mismo rol de base que la dueña —`app_practitioner` es uno
    // para las dos—, y la para el `exists` del `UPDATE` contra `owner_account_id`, comparado
    // con `medskin_current_account()`. Esa guarda la hacía `medskin_license_to_review()`;
    // ahora está en el `WHERE`.
    const { submission } = await repository.submit({
      owner: { accountId: D.reception, practiceId: D.practice },
      form,
      ...envio(),
    });

    expect(submission.verdict).toBe('not_owner');
    // Y NO ESCRIBIÓ NADA: el `exists` está en el mismo `UPDATE`, no en una segunda sentencia
    // que pudiera dejar el formulario puesto y la guarda después.
    const license = await read<{ license_number: string | null }>(
      ctx(D.practice, D.reception),
      'select license_number from license',
    );
    expect(license).toEqual([{ license_number: null }]);
  });

  it('con cinco guardados en la bitácora de las últimas 24 h, el sexto es `too_many`', async () => {
    await owner.query(
      `insert into access_audit (practice_id, actor_account_id, actor_label, action, subject_type,
                                 region, occurred_at)
       select $1::uuid, $2::uuid, 'Andrea Paz', 'license.declared', 'license', 'latam',
              now() - (g || ' hours')::interval
         from generate_series(1, 5) g`,
      [C.practice, C.owner],
    );

    const { submission } = await repository.submit({
      owner: { accountId: C.owner, practiceId: C.practice },
      form,
      ...envio(),
    });

    expect(submission.verdict).toBe('too_many');
    // El límite va PRIMERO y dentro de la transacción: no se escribió ni el formulario, así
    // que no hay nada a medias.
    const license = await read<{ license_number: string | null }>(
      ctx(C.practice, C.owner),
      'select license_number from license',
    );
    expect(license).toEqual([{ license_number: null }]);
  });

  it('los guardados de otra consulta no cuentan contra los cinco: el recuento va por política', async () => {
    // Los cinco de C siguen en la bitácora. D manda el suyo y entra: si el recuento no
    // estuviera acotado por la consulta, este sería el sexto.
    const { submission } = await repository.submit({
      owner: { accountId: D.owner, practiceId: D.practice },
      form,
      ...envio(),
    });

    expect(submission.verdict).toBe('saved');
  });
});
