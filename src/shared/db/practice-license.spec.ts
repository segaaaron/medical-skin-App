// La prueba de lo que añade la 0015, y solo de eso: `inquilinos.md` · los cinco endpoints.
//
// Mismas reglas que `isolation.spec.ts` y `access-functions.spec.ts`: contra la base real
// en Docker, sin un solo doble, y en ningún momento se desactiva RLS. Siembra el DUEÑO del
// esquema, que es quien migra; todo lo que se COMPRUEBA pasa por los roles de aplicación y
// por `withTenantContext()`.
//
// Lo que NO se repite aquí porque ya está probado en otro archivo: que la doctora no mueve
// `license.status` por `UPDATE` directo, que `medskin_license_to_review` valida la
// transición y exige ser la dueña, que la consola lee cinco columnas de `session` y ninguna
// más, y que el inquilino A no lee las filas de `practice` ni de `license` del B. Eso es de
// la 0002 y de la 0003, y sus pruebas siguen verdes.
//
// Identificadores en inglés, descripciones en español: norma del 27 de octubre.

import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantContext, type TenantContext } from './tenant-context';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ?? 'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

// Hash con la forma que la función exige (`$argon2id$…`), de una contraseña aleatoria que
// no se guardó: aquí no se verifica ninguna contraseña, solo se mueve el hash.
const HASH = '$argon2id$v=19$m=65536,p=4,t=3$c2VtaWxsYWRlcHJ1ZWJh$BcVqHhiTZ4RrQZ4kYgVvxCuUAneDdfTxZ6qz6hUwcLY';

// A es la consulta que la consola da de alta DENTRO de la prueba: su `id` lo pone el
// `INSERT` del endpoint, no la siembra, porque es justo ese camino el que se mide.
const A = { practice: 'ffffffff-0000-4000-8000-00000000000a', email: 'duena.alta@inquilinos.local' };
// B es la consulta ya instalada: la que la consola abre en `Consola.dc.html` · 2.
const B = {
  practice: 'ffffffff-0000-4000-8000-00000000000b',
  account: 'ffffffff-0000-4000-8000-00000000001b',
  practitioner: 'ffffffff-0000-4000-8000-00000000002b',
  email: 'duena.ficha@inquilinos.local',
};
// Las dos consultas del plan: una pequeña, que es la que pregunta, y una grande al lado,
// que es lo que obliga al motor a elegir entre el índice y el recorrido completo.
const SMALL = { practice: 'ffffffff-0000-4000-8000-00000000000c', account: 'ffffffff-0000-4000-8000-00000000001c' };
const BULK = { practice: 'ffffffff-0000-4000-8000-00000000000d' };
const PLATFORM = { account: 'ffffffff-0000-4000-8000-00000000000e' };

const ctxPlatform: TenantContext = { role: 'app_platform', accountId: PLATFORM.account };
const ctxPractitionerB: TenantContext = { role: 'app_practitioner', practiceId: B.practice, accountId: B.account };
const ctxSmall: TenantContext = { role: 'app_practitioner', practiceId: SMALL.practice, accountId: SMALL.account };

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 1 });

async function read<T extends QueryResultRow>(ctx: TenantContext, sql: string, params: unknown[] = []): Promise<T[]> {
  return withTenantContext(app, ctx, async (client: PoolClient) => (await client.query<T>(sql, params)).rows);
}

async function clean() {
  await owner.query('delete from practice where id = any($1::uuid[])', [
    [A.practice, B.practice, SMALL.practice, BULK.practice],
  ]);
  await owner.query(`delete from account where email like '%@inquilinos.local'`);
  await owner.query(`delete from access_audit where actor_label = 'Soporte MedSkin'`);
}

beforeAll(async () => {
  await clean();
  await owner.query(
    `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit, city)
     values ($1, 'Clínica Paz', 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300, 'Santa Cruz')`,
    [B.practice],
  );
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'practitioner', 'latam', 'Andrea', 'Paz')`,
    [B.account, B.email],
  );
  await owner.query(`insert into credential (account_id, hash, is_temporary, set_at) values ($1, $2, false, now())`, [
    B.account,
    HASH,
  ]);
  await owner.query(
    `insert into practitioner (id, practice_id, account_id, first_name, last_name, role)
     values ($1, $2, $3, 'Andrea', 'Paz', 'doctora')`,
    [B.practitioner, B.practice, B.account],
  );
  await owner.query('update practice set owner_account_id = $1 where id = $2', [B.account, B.practice]);
  // La licencia de B la pone la siembra, no la 0015: el relleno de la migración cubrió las
  // consultas que ya existían y el `INSERT` de la función del alta cubre las que nacen por
  // el endpoint. Una consulta insertada a mano por el dueño del esquema —esto— no pasa por
  // ninguno de los dos, y es la diferencia que la primera prueba de este archivo mide.
  await owner.query(
    `insert into license (practice_id, status, practice_country, specialty, license_number, credential_key,
                          declaration_accepted, terms_accepted, submitted_at, response_estimated_at)
     values ($1, 'en_revision', 'BO', 'medicina_estetica', '48921', 'lic/b/4f2a.pdf', true, true,
             now() - interval '1 day', now() + interval '1 day')`,
    [B.practice],
  );
  // Tres fichas activas y una archivada: el recuento del plan es de tres, y eso es la
  // pregunta de producto que la 0015 deja escrita.
  await owner.query(
    `insert into patient (practice_id, first_name, last_name, birth_date, email, how_arrived, status, archived_at)
     select $1::uuid, 'Ficha' || g, 'Paz', '1990-01-01', 'ficha-b-' || g || '@inquilinos.local', 'instagram',
            case when g = 4 then 'archivada' else 'activa' end,
            case when g = 4 then now() end
       from generate_series(1, 4) g`,
    [B.practice],
  );
  // Las sesiones de las que sale `versiones_app`. La revocada lleva una versión que no
  // existe a propósito: si saliera, el filtro no estaría puesto.
  await owner.query(
    `insert into session (account_id, practice_id, scope, device_id, platform, app_version, last_seen_at, revoked_at)
     values ($1, $2, 'completo', 'disp-ios', 'ios', '2.4.1', now() - interval '1 hour', null),
            ($1, $2, 'completo', 'disp-android', 'android', '2.4.0', now() - interval '2 hours', null),
            ($1, $2, 'completo', 'disp-viejo', 'ios', '9.9.9', now(), now())`,
    [B.account, B.practice],
  );
});

afterAll(async () => {
  await clean();
  await owner.end();
  await app.end();
});

describe('el alta de una consulta · su licencia nace con ella (0015)', () => {
  it('la consola crea consulta, dueña y licencia en `sin_enviar`, y la doctora la envía sin que nadie inserte la fila', async () => {
    // Paso 1 y 2 de `POST /v1/platform/tenants`, tal cual los va a escribir el
    // endpoint: el `INSERT` de la consulta y la función del alta de la dueña.
    const created = await read<{ id: string }>(
      ctxPlatform,
      `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit, internal_note)
       values ($1, 'Clínica Nueva', 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300, 'Vino por el webinar')
       returning id`,
      [A.practice],
    );
    expect(created[0]?.id).toBe(A.practice);

    const alta = await read<{ verdict: string; account_id: string }>(
      ctxPlatform,
      `select * from medskin_create_practice_owner($1, $2::citext, 'Andrea', 'Paz', $3, now() + interval '72 hours')`,
      [A.practice, A.email, HASH],
    );
    expect(alta[0]?.verdict).toBe('created');
    const ownerAccount = alta[0]!.account_id;

    // El 201 del contrato: `licencia: { estado: "sin_enviar" }`. Nadie la insertó.
    const licencia = await read<{ status: string; submitted_at: string | null }>(
      ctxPlatform,
      'select status, submitted_at from license where practice_id = $1',
      [A.practice],
    );
    expect(licencia).toEqual([{ status: 'sin_enviar', submitted_at: null }]);

    // Y `POST /v1/tenants/mine/license` de esa dueña recién creada funciona de una:
    // su `UPDATE` toca su fila, y la función la mueve a revisión.
    const ctxOwner: TenantContext = { role: 'app_practitioner', practiceId: A.practice, accountId: ownerAccount };
    const filled = await read<{ id: string }>(
      ctxOwner,
      `update license set practice_country = 'BO', specialty = 'medicina_estetica', license_number = '48921',
              credential_key = 'lic/a/4f2a.pdf', declaration_accepted = true, terms_accepted = true,
              updated_at = now()
        where practice_id = $1 returning id`,
      [A.practice],
    );
    expect(filled).toHaveLength(1);

    const sent = await read<{ verdict: string; status: string }>(
      ctxOwner,
      `select verdict, status from medskin_license_to_review(now() + interval '2 days')`,
    );
    expect(sent[0]).toMatchObject({ verdict: 'submitted', status: 'en_revision' });
  });

  it('la doctora no tiene `INSERT` sobre `license`: sin la fila del alta se quedaría sin enviar nada', async () => {
    // Esta es la razón de que la fila vaya dentro de la función del alta. Si algún día
    // alguien «arregla» el alta quitándole el `INSERT`, esta prueba sigue pasando y la de
    // arriba falla, que es el orden correcto de los dos hechos.
    await expect(
      read(ctxPractitionerB, 'insert into license (practice_id) values ($1)', [B.practice]),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('la decisión de la licencia · la consola la mueve sin función (0015)', () => {
  it('mueve `en_revision` a `verificada` una vez, deja su auditoría, y la segunda vez no mueve nada', async () => {
    const decision = `update license set status = 'verificada', decided_at = now(), rejection_reason = null,
                             reviewed_by = $2, updated_at = now()
                        where practice_id = $1 and status = 'en_revision'
                        returning status, decided_at`;

    const first = await read<{ status: string; decided_at: string }>(ctxPlatform, decision, [
      B.practice,
      PLATFORM.account,
    ]);
    expect(first).toHaveLength(1);
    expect(first[0]?.status).toBe('verificada');

    const audit = await read<{ id: string }>(
      ctxPlatform,
      `insert into access_audit (practice_id, actor_account_id, actor_label, action, subject_type, data, region)
       values ($1, $2, 'Soporte MedSkin', 'license.decision', 'license', '{"decision": "verificada"}'::jsonb, 'latam')
       returning id`,
      [B.practice, PLATFORM.account],
    );
    expect(audit).toHaveLength(1);

    // La misma decisión dos veces no mueve nada: cero filas es el `409
    // licencia_ya_decidida` del contrato, y no hace falta ninguna función para saberlo.
    const second = await read(ctxPlatform, decision, [B.practice, PLATFORM.account]);
    expect(second).toHaveLength(0);
  });

  it('un rechazo sin motivo no entra, y lo para la base y no el controlador (0016)', async () => {
    // El `CHECK` de la 0000 dejaba pasar el motivo NULO —`false OR NULL` no es `false`—, y
    // lo levantó esta prueba. La mitad que faltaba es `license_rejection_reason_present_ck`.
    await owner.query(`update license set status = 'en_revision' where practice_id = $1`, [B.practice]);
    await expect(
      read(
        ctxPlatform,
        `update license set status = 'rechazada', decided_at = now(), updated_at = now()
          where practice_id = $1 and status = 'en_revision'`,
        [B.practice],
      ),
    ).rejects.toThrow(/license_rejection_reason_present_ck/);
  });
});

describe('la ficha de la consola · cuenta fichas sin leer ninguna (0015)', () => {
  it('`app_platform` no lee `patient` ni con la función delante: de ella salen tres números y ni una fila', async () => {
    await expect(read(ctxPlatform, 'select count(*) from patient where practice_id = $1', [B.practice])).rejects.toThrow(
      /permission denied for table patient/i,
    );
    await expect(read(ctxPlatform, 'select practice_id from session limit 1')).rejects.toThrow(
      /permission denied for table session/i,
    );

    const stats = await read<{ patient_count: string; app_version_ios: string; app_version_android: string }>(
      ctxPlatform,
      'select * from medskin_platform_practice_stats($1)',
      [B.practice],
    );
    // Tres fichas activas de cuatro: la archivada no cuenta contra el límite del plan. Y
    // las versiones de las sesiones VIVAS: la revocada traía `9.9.9`.
    expect(stats).toEqual([{ patient_count: '3', app_version_ios: '2.4.1', app_version_android: '2.4.0' }]);
  });

  it('una consulta sin sesiones devuelve las dos versiones nulas, que también es una respuesta', async () => {
    const stats = await read<{ patient_count: string; app_version_ios: string | null }>(
      ctxPlatform,
      'select * from medskin_platform_practice_stats($1)',
      [A.practice],
    );
    expect(stats).toEqual([{ patient_count: '0', app_version_ios: null, app_version_android: null }]);
  });

  it('la función es de la consola y de nadie más: la doctora no la ejecuta', async () => {
    await expect(read(ctxPractitionerB, 'select * from medskin_platform_practice_stats($1)', [B.practice])).rejects.toThrow(
      /permission denied for function/i,
    );
  });
});

describe('el plan del recuento del plan de `GET /v1/tenants/mine`', () => {
  beforeAll(async () => {
    for (const [id, name] of [
      [SMALL.practice, 'Pequeña'],
      [BULK.practice, 'Grande'],
    ] as const) {
      await owner.query(
        `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit)
         values ($1, $2, 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300)`,
        [id, name],
      );
    }
    const fichas = async (practice: string, howMany: number) =>
      owner.query(
        `insert into patient (practice_id, first_name, last_name, birth_date, email, how_arrived, status, archived_at)
         select $1::uuid, left(md5(g::text), 9), left(md5((g * 7)::text), 9), '1990-01-01',
                'plan-' || g || '-' || left($1::uuid::text, 4) || '@inquilinos.local', 'instagram',
                case when g % 10 = 0 then 'archivada' else 'activa' end,
                case when g % 10 = 0 then now() end
           from generate_series(1, $2::int) g`,
        [practice, howMany],
      );
    await fichas(SMALL.practice, 400);
    await fichas(BULK.practice, 4_000);
    // Sin esto se mediría el plan de una tabla que acaba de nacer: las entradas del GIN
    // recién cargado están en la lista pendiente y su coste empuja al recorrido completo.
    await owner.query('vacuum analyze patient');
  }, 120_000);

  it('el recuento entra por el índice que empieza por el inquilino, y sin recorrer la tabla', async () => {
    // Tal cual lo manda el contrato («148 de 300») y SIN `where practice_id`: lo pone la
    // política, que es justo lo que hay que medir. Con el dueño este `EXPLAIN` no llevaría
    // ni un predicado de política y mediría otra consulta (§1.12 del napkin).
    const rows = await read<{ 'QUERY PLAN': string }>(
      ctxSmall,
      `explain (analyze, buffers) select count(*) from patient where status = 'activa'`,
    );
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toContain('patient_practice_status_idx');
    expect(plan).not.toContain('Seq Scan on patient');
  });
});
