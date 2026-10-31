// Los tres endpoints de consola CONTRA LA BASE REAL, porque es lo único que puede probar lo
// que decide de verdad qué ve soporte: los `GRANT` por columna y las políticas de
// `app_platform`. Con dobles eso es invisible.
//
// Mismas reglas que `isolation.spec.ts` y `practice-license.spec.ts`: siembra el DUEÑO del
// esquema, que es quien migra; todo lo que se COMPRUEBA pasa por `app_platform` y por
// `withTenantContext()`. En ningún momento se desactiva RLS.
//
// Lo que NO se repite aquí porque ya está probado en otro archivo: que la fila de `license`
// nace con la consulta (0015) y que `app_platform` no lee `patient` ni `session.practice_id`.
// Lo que sí se comprueba es que ESTE código no los nombra: las dos consultas que los
// necesitan van por la función.
//
// SE FUERON DE AQUÍ, con la revisión manual de licencias (migración 0072): el describe entero
// de `POST /{id}/license/decision`, su carrera de dos decisiones simultáneas, el filtro por
// estado de la búsqueda y el describe de la bandeja `GET /v1/platform/licenses`.

import { Pool, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { CreatedTenant, PlatformActor } from '../domain/platform-ports';
import { PlatformRepository, fingerprintOf } from './platform.repository';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl =
  process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

const HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$c2VtaWxsYWRlcHJ1ZWJh$BcVqHhiTZ4RrQZ4kYgVvxCuUAneDdfTxZ6qz6hUwcLY';

const ACTOR: PlatformActor = {
  // `sub` es un uuid y es lo que se fija en `medskin.account_id`: no hay fila en `account`
  // detrás, y por eso `access_audit.actor_account_id` no tiene clave foránea.
  subject: 'cccccccc-0000-4000-8000-00000000000f',
  label: 'Soporte MedSkin',
  region: 'latam',
};
/** Otra persona de soporte: su clave de idempotencia no repite nada de la primera. */
const OTHER_ACTOR: PlatformActor = { ...ACTOR, subject: 'cccccccc-0000-4000-8000-00000000000e' };

/** La consulta ya instalada: la que la consola abre en `Consola.dc.html` · 2. */
const FILE = {
  practice: 'cccccccc-0000-4000-8000-00000000000b',
  account: 'cccccccc-0000-4000-8000-00000000001b',
};
/**
 * Una segunda consulta, para que la búsqueda y su cursor tengan más de una fila que atravesar.
 *
 * ERAN TRES MÁS: `REVIEW` nacía `en_revision`, `UNSENT` en `sin_enviar` para el `409
 * licencia_sin_enviar`, y `RACE` existía solo para la carrera de dos decisiones simultáneas.
 * Las tres se sembraban por un estado de licencia que ya no existe.
 */
const OTHER = {
  practice: 'cccccccc-0000-4000-8000-00000000000c',
  account: 'cccccccc-0000-4000-8000-00000000001c',
};

const SEEDED = [FILE.practice, OTHER.practice];

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
// `max: 2` y no 1: la prueba de concurrencia del alta abre DOS transacciones a la vez, y con
// una sola conexión la segunda esperaría a que la primera la suelte en vez de competir por la
// clave.
const app = new Pool({ connectionString: appUrl, max: 2 });
const repository = new PlatformRepository(app, 'America/La_Paz');

const ctxPlatform: TenantContext = { role: 'app_platform', accountId: ACTOR.subject };

async function read<T extends QueryResultRow>(
  context: TenantContext,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withTenantContext(app, context, async (c) => (await c.query<T>(sql, params)).rows);
}

/**
 * Sin `licenseStatus`: la licencia no tiene estado desde la 0072. Lo que se siembra son los
 * tres datos declarados y su fecha, que es todo lo que esa fila guarda.
 */
async function seed(p: { practice: string; account: string; name: string }) {
  await owner.query(
    `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit,
                           internal_note, created_at)
     values ($1, $2, 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300,
             'Vino por el webinar', '2026-03-14T18:00:00Z')`,
    [p.practice, p.name],
  );
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'doctor', 'latam', 'Andrea', 'Paz')`,
    [p.account, `duena.${p.practice.slice(-1)}@plataforma.local`],
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
  await owner.query(
    `insert into license (practice_id, practice_country, specialty, license_number, declared_at)
     values ($1, 'BO', 'medicina_estetica', '48921', now() - interval '1 day')`,
    [p.practice],
  );
}

async function clean() {
  // Las consultas que el alta crea dentro de la prueba no tienen un `id` fijo: se buscan por
  // su nombre, que es el que esta prueba escribe.
  //
  // `Consultorio Con Matrícula` entra en la lista el 31 de octubre de 2026, y faltaba desde
  // que se escribió esa prueba: la creaba y NADIE la borraba, así que cada corrida de la suite
  // dejaba una fila viva. Se vio al querer el padrón local vacío para probar la consola — 22
  // consultas de ese nombre, una por corrida. Si se añade otra prueba que cree una consulta,
  // su nombre va aquí en el mismo commit.
  const { rows } = await owner.query<{ id: string }>(
    `select id from practice
      where name in ('Clínica Nueva', 'Clínica Repetida', 'Consultorio Con Matrícula')`,
  );
  const created = rows.map((row) => row.id);
  await owner.query('delete from practice where id = any($1::uuid[])', [[...SEEDED, ...created]]);
  await owner.query(`delete from account where email like '%@plataforma.local'`);
  await owner.query('delete from access_audit where practice_id = any($1::uuid[])', [
    [...SEEDED, ...created],
  ]);
  await owner.query(`delete from idempotency_key where key like 'consola-%'`);
  await owner.query('delete from idempotency_key where account_id = any($1::uuid[])', [
    [ACTOR.subject, OTHER_ACTOR.subject],
  ]);
}

beforeAll(async () => {
  await clean();
  await seed({ ...FILE, name: 'Clínica Paz' });
  await seed({ ...OTHER, name: 'Clínica Segunda' });

  // Tres fichas activas y una archivada: el recuento del plan es de tres, el MISMO que ve la
  // doctora (las archivadas no cuentan contra el límite).
  await owner.query(
    `insert into patient (practice_id, first_name, last_name, birth_date, email, how_arrived,
                          status, archived_at)
     select $1::uuid, 'Ficha' || g, 'Paz', '1990-01-01',
            'ficha-' || g || '-' || left($1::uuid::text, 8) || '@plataforma.local', 'instagram',
            case when g = 4 then 'archivada' else 'activa' end,
            case when g = 4 then now() end
       from generate_series(1, 4) g`,
    [FILE.practice],
  );
  // Las sesiones de las que salen `versiones_app` y `sesiones_activas`. La revocada lleva una
  // versión que no existe a propósito: si saliera, el filtro no estaría puesto.
  await owner.query(
    `insert into session (account_id, practice_id, scope, device_id, platform, app_version,
                          last_seen_at, revoked_at)
     values ($1, $2, 'completo', 'disp-ios', 'ios', '2.4.1', now() - interval '1 hour', null),
            ($1, $2, 'completo', 'disp-android', 'android', '2.4.0', now() - interval '2 hours', null),
            ($1, $2, 'completo', 'disp-viejo', 'ios', '9.9.9', now(), now())`,
    [FILE.account, FILE.practice],
  );
});

afterAll(async () => {
  await clean();
  await owner.end();
  await app.end();
});

describe('POST /v1/platform/tenants · contra la función del alta', () => {
  it('los tres datos de la licencia que recogió la consola quedan en la fila', async () => {
    // Decidido por el dueño el 30 de octubre de 2026: el formulario del alta pregunta lo
    // mismo que la app le preguntará después a la doctora, así que se recoge una vez.
    const admission = await repository.create({
      actor: ACTOR,
      idempotency: { key: 'consola-licencia', bodyHash: 'huella-licencia' },
      practice: {
        name: 'Consultorio Con Matrícula',
        region: 'latam',
        country: 'BO',
        timeZone: 'America/La_Paz',
        currency: 'BOB',
        plan: 'consultorio',
        patientLimit: 300,
        internalNote: null,
      },
      owner: {
        firstName: 'Rocío',
        lastName: 'Villarroel',
        email: 'rocio.villarroel@plataforma.local',
        hash: HASH,
        phone: null,
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      },
      license: {
        practiceCountry: 'BO',
        specialty: 'dermatologia',
        licenseNumber: 'MP-98765',
      },
      respond: (created) => created,
    });

    expect(admission.verdict).toBe('created');
    const creada = admission.served?.response as CreatedTenant;

    const { rows } = await owner.query<{
      practice_country: string | null;
      specialty: string | null;
      license_number: string | null;
    }>(
      `select practice_country, specialty, license_number from license where practice_id = $1`,
      [creada.practiceId],
    );

    const licencia = rows[0];
    expect(licencia?.practice_country).toBe('BO');
    expect(licencia?.specialty).toBe('dermatologia');
    expect(licencia?.license_number).toBe('MP-98765');

    // AQUÍ SE COMPROBABA LA LÍNEA QUE NO SE CRUZABA: que la fila siguiera `sin_enviar`, sin
    // credencial y sin las dos aceptaciones, para que la bandeja de revisión no la viera.
    // Las cinco columnas se fueron con la revisión, así que no hay línea que vigilar: lo que
    // la consola recoge es lo que se guarda, y nadie lo aprueba.
  });

  it('crea consulta, dueña, credencial y la FILA DE LICENCIA sin insertarla a mano', async () => {
    const admission = await repository.create({
      actor: ACTOR,
      idempotency: { key: 'consola-1', bodyHash: 'huella-1' },
      practice: {
        name: 'Clínica Nueva',
        region: 'latam',
        country: 'BO',
        timeZone: 'America/La_Paz',
        currency: 'BOB',
        plan: 'consultorio',
        patientLimit: 300,
        internalNote: 'Vino por el webinar',
      },
      owner: {
        firstName: 'Andrea',
        lastName: 'Nueva',
        email: 'andrea.nueva@plataforma.local',
        hash: HASH,
        phone: null,
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      },
      license: null,
      respond: (created) => created,
    });

    expect(admission.verdict).toBe('created');
    const created = admission.served?.response;
    expect(created?.practiceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(admission.served?.status).toBe(201);

    // La fila de `license` la creó la FUNCIÓN (0015): aquí nadie la insertó, y antes de esa
    // migración la dueña se quedaba sin poder declarar nada y nadie se enteraba. Nace VACÍA:
    // este alta no mandó bloque de licencia, así que no hay matrícula ni fecha.
    const license = await read<{ license_number: string | null; declared_at: Date | null }>(
      ctxPlatform,
      'select license_number, declared_at from license where practice_id = $1',
      [created?.practiceId],
    );
    expect(license).toEqual([{ license_number: null, declared_at: null }]);

    // Y la dueña quedó atada a su consulta, que es lo que «una consulta sin dueña no existe»
    // significa en la base.
    const practice = await read<{ owner_account_id: string }>(
      ctxPlatform,
      'select owner_account_id from practice where id = $1',
      [created?.practiceId],
    );
    expect(practice[0]?.owner_account_id).toBe(created?.accountId);
  });

  it('un correo ya tomado NO deja una consulta huérfana: la transacción se deshace entera', async () => {
    const admission = await repository.create({
      actor: ACTOR,
      idempotency: { key: 'consola-2', bodyHash: 'huella-2' },
      practice: {
        name: 'Clínica Repetida',
        region: 'latam',
        country: 'BO',
        timeZone: 'America/La_Paz',
        currency: 'BOB',
        plan: 'individual',
        patientLimit: 100,
        internalNote: null,
      },
      owner: {
        // El de la consulta ya instalada.
        firstName: 'Andrea',
        lastName: 'Paz',
        email: `duena.${FILE.practice.slice(-1)}@plataforma.local`,
        hash: HASH,
        phone: null,
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      },
      license: null,
      respond: (created) => created,
    });

    expect(admission.verdict).toBe('email_taken');
    expect(admission.served).toBeNull();
    // Esto es lo que la prueba existe para medir: sin el `ROLLBACK`, la consola vería una
    // «Clínica Repetida» sin dueña, que según el contrato no existe.
    const orphans = await read(
      ctxPlatform,
      `select id from practice where name = 'Clínica Repetida'`,
    );
    expect(orphans).toEqual([]);
  });

  it('con `Idempotency-Key` el reintento repite la respuesta guardada, contraseña incluida', async () => {
    const body = { nombre: 'Clínica Nueva', doctora: { correo: 'andrea.dos@plataforma.local' } };
    const idempotency = { key: 'alta-1', bodyHash: fingerprintOf(body) };
    const practice = {
      name: 'Clínica Nueva',
      region: 'latam' as const,
      country: 'BO',
      timeZone: 'America/La_Paz',
      currency: 'BOB',
      plan: 'consultorio',
      patientLimit: 300,
      internalNote: null,
    };
    const ownerData = {
      firstName: 'Andrea',
      lastName: 'Dos',
      email: 'andrea.dos@plataforma.local',
      hash: HASH,
      phone: null,
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    };

    const first = await repository.create({
      actor: ACTOR,
      idempotency,
      practice,
      owner: ownerData,
      license: null,
      respond: (created) => ({ ...created, contrasena_temporal: 'tejado-lila-07' }),
    });
    expect(first.served?.replayed).toBe(false);

    // El mismo acto otra vez: no crea una segunda consulta y devuelve la respuesta ORIGINAL
    // —«la repetición devuelve la respuesta completa, contraseña temporal incluida»—.
    const again = await repository.create({
      actor: ACTOR,
      idempotency,
      practice,
      owner: ownerData,
      license: null,
      respond: () => ({
        practiceId: 'no',
        accountId: 'se',
        createdAt: new Date(0),
        contrasena_temporal: 'usa',
      }),
    });
    expect(again.served?.replayed).toBe(true);
    expect(again.served?.status).toBe(201);
    expect(again.served?.response).toEqual({
      ...first.served?.response,
      // El `jsonb` devuelve la fecha como texto: es la MISMA respuesta que se guardó.
      createdAt: (first.served?.response.createdAt as Date).toISOString(),
    });

    const howMany = await read<{ count: string }>(
      ctxPlatform,
      `select count(*) as count from account where email = 'andrea.dos@plataforma.local'`,
    );
    expect(howMany).toEqual([{ count: '1' }]);
  });

  it('la misma clave con OTRO cuerpo es `409`, y la clave de otra persona de soporte no se cruza', async () => {
    const idempotency = { key: 'alta-1', bodyHash: fingerprintOf({ otra: 'cosa' }) };
    const practice = {
      name: 'Clínica Nueva',
      region: 'latam' as const,
      country: 'BO',
      timeZone: 'America/La_Paz',
      currency: 'BOB',
      plan: 'consultorio',
      patientLimit: 300,
      internalNote: null,
    };

    await expect(
      repository.create({
        actor: ACTOR,
        idempotency,
        practice,
        owner: {
          firstName: 'Andrea',
          lastName: 'Tres',
          email: 'andrea.tres@plataforma.local',
          hash: HASH,
          phone: null,
          expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        },
        license: null,
      respond: (created) => created,
      }),
    ).rejects.toMatchObject({ code: 'clave_idempotencia_reutilizada', status: 409 });

    // La política de `idempotency_key` es `account_id = medskin_current_account()`: la misma
    // clave de OTRA persona de soporte es otra operación y no ve nada de la primera.
    const other = await repository.create({
      actor: OTHER_ACTOR,
      idempotency: { key: 'alta-1', bodyHash: fingerprintOf({ otra: 'cosa' }) },
      practice,
      owner: {
        firstName: 'Andrea',
        lastName: 'Cuatro',
        email: 'andrea.cuatro@plataforma.local',
        hash: HASH,
        phone: null,
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      },
      license: null,
      respond: (created) => created,
    });
    expect(other.verdict).toBe('created');
    expect(other.served?.replayed).toBe(false);
  });
});

// -------------------------------------------------------------------------------------
// LA CONCURRENCIA, QUE A ESTE ARCHIVO LE FALTABA Y ES LO QUE DEJÓ VIVO EL MECANISMO VIEJO.
// Los otros tres caminos ya la tenían; estos dos, no, y por eso sobrevivieron dos pasadas
// con la reserva al final, el `ON CONFLICT DO NOTHING` sin mirar `rowCount` y la lectura sin
// `expires_at > now()`.
// -------------------------------------------------------------------------------------
/**
 * La respuesta tal y como la ve un cliente: `jsonb` reordena las claves y convierte las
 * fechas en cadenas, así que lo que se compara entre la original y la repetida es el
 * significado, que es lo que el contrato puede prometer.
 */
function comoJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('dos peticiones idénticas a la vez, con la misma clave', () => {
  const alta = (key: string) => ({
    actor: ACTOR,
    idempotency: { key, bodyHash: 'huella-carrera' },
    practice: {
      name: 'Clínica Repetida',
      region: 'latam' as const,
      country: 'BO',
      timeZone: 'America/La_Paz',
      currency: 'BOB',
      plan: 'consultorio',
      patientLimit: 300,
      internalNote: null,
    },
    owner: {
      firstName: 'Andrea',
      lastName: 'Carrera',
      email: 'andrea.carrera@plataforma.local',
      hash: HASH,
      phone: null,
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    },
    license: null,
    respond: (created: CreatedTenant) => created,
  });

  it('el alta de consulta deja UNA consulta, y la perdedora repite la respuesta', async () => {
    // Antes del arreglo: las dos pasaban la lectura vacía, las dos insertaban `practice`, y
    // la perdedora recibía `email_taken` —un 409 por una petición que salió bien, y sin la
    // contraseña de la dueña, que solo existe en la respuesta de la ganadora—.
    const [una, otra] = await Promise.all([
      repository.create(alta('consola-carrera')),
      repository.create(alta('consola-carrera')),
    ]);

    // Las dos salen bien: una creó y la otra repitió. Ninguna 409 y ninguna 500.
    expect([una.verdict, otra.verdict]).toEqual(['created', 'created']);
    const repetidas = [una, otra].filter((r) => r.served?.replayed === true);
    expect(repetidas).toHaveLength(1);
    // El `status` que vuelve es el GUARDADO —201—: el `200` de la repetición lo pone el
    // controlador con `served.replayed`, que es donde vive esa decisión.
    expect(repetidas[0]?.served?.status).toBe(201);
    // Comparadas COMO JSON, y no con `toEqual` a secas: es exactamente lo que «byte a byte»
    // no podía prometer. La repetida vuelve de una columna `jsonb`, así que su `createdAt` es
    // la cadena ISO y no un `Date`. Idéntica en significado, que es lo que un cliente JSON
    // necesita y lo único que se puede comprobar.
    expect(comoJson(una.served?.response)).toEqual(comoJson(otra.served?.response));

    // Y LO QUE IMPORTA: una consulta, una cuenta de dueña y una clave.
    const { rows } = await owner.query<{
      consultas: string;
      cuentas: string;
      claves: string;
    }>(
      `select (select count(*) from practice where name = 'Clínica Repetida')::text as consultas,
              (select count(*) from account
                where email = 'andrea.carrera@plataforma.local'::citext)::text as cuentas,
              (select count(*) from idempotency_key where key = 'consola-carrera')::text as claves`,
    );
    expect(rows[0]).toEqual({ consultas: '1', cuentas: '1', claves: '1' });
  });

  // AQUÍ ESTABA «la decisión de licencia no da `already_decided` a la perdedora», que probaba
  // que `claim()` va DELANTE del `FOR UPDATE`: el `FOR UPDATE` serializa la licencia, no la
  // clave, así que sin la reserva por delante la segunda decisión simultánea recibía el `409`
  // que el contrato prometía que no iba a ver. Comprobaba también los dos avisos a la dueña,
  // uno por canal, y que el aviso no llevara el motivo del rechazo.
  //
  // Se fue con la decisión. **Lo que probaba sigue probado** por la carrera del alta de
  // arriba, que es el otro camino con `claim()` por delante y el mismo mecanismo.

  it('una clave CADUCADA no sirve una respuesta vieja, y se puede volver a usar', async () => {
    // Era el tercer defecto de este camino, y el peor: sin `expires_at > now()` la consola
    // repetía una contraseña temporal de hace diez días, y el `do nothing` dejaba esa fila
    // atascada para siempre —ni se refrescaba ni dejaba de servirse—.
    // La carrera anterior dejó su consulta y su dueña: sin esto, el alta de aquí daría
    // `email_taken` y no estaríamos probando nada de la clave.
    await owner.query(`delete from practice where name = 'Clínica Repetida'`);
    await owner.query(
      `delete from account where email = 'andrea.carrera@plataforma.local'::citext`,
    );

    const primera = await repository.create(alta('consola-caducada'));
    expect(primera.served?.replayed).toBe(false);

    await owner.query(
      `update idempotency_key set expires_at = now() - interval '10 days' where key = $1`,
      ['consola-caducada'],
    );
    await owner.query(`delete from practice where name = 'Clínica Repetida'`);
    await owner.query(
      `delete from account where email = 'andrea.carrera@plataforma.local'::citext`,
    );

    // Con la fila caducada el alta se vuelve a atender de verdad —no repite nada— y la clave
    // se refresca en vez de quedarse atascada.
    const segunda = await repository.create(alta('consola-caducada'));
    expect(segunda.served?.replayed).toBe(false);
    expect(segunda.served?.status).toBe(201);
    expect(segunda.served?.response.practiceId).not.toBe(primera.served?.response.practiceId);

    const { rows } = await owner.query<{ viva: boolean }>(
      `select expires_at > now() as viva from idempotency_key where key = $1`,
      ['consola-caducada'],
    );
    expect(rows[0]?.viva).toBe(true);
  });
});

describe('GET /v1/platform/tenants/{id} · la ficha de la consola', () => {
  it('sirve metadatos, lo declarado y TRES números, sin leer una sola fila de paciente', async () => {
    const file = await repository.read({ actor: ACTOR, practiceId: FILE.practice });

    expect(file).toMatchObject({
      id: FILE.practice,
      name: 'Clínica Paz',
      plan: 'consultorio',
      patientLimit: 300,
      // Tres de cuatro: la archivada no cuenta contra el límite del plan, y el número sale de
      // `medskin_platform_practice_stats()` porque este rol NO puede leer `patient`.
      activePatients: 3,
      region: 'latam',
      // La fecha en la zona del despliegue: `created_at` es 18:00Z del 14 de marzo, que en La
      // Paz sigue siendo el 14. Un instante pasado a texto sin zona mueve el día.
      createdOn: '2026-03-14',
      // Las versiones de las sesiones VIVAS: la revocada traía `9.9.9`.
      appVersions: { ios: '2.4.1', android: '2.4.0' },
    });
    // Lo que el doctor declaró, sin estado: nadie lo aprueba (0072).
    expect(file?.license).toMatchObject({
      practiceCountry: 'BO',
      specialty: 'medicina_estetica',
      licenseNumber: '48921',
    });
    expect(file?.license.declaredAt).toBeInstanceOf(Date);
    expect(file?.owner).toMatchObject({
      accountId: FILE.account,
      email: `duena.${FILE.practice.slice(-1)}@plataforma.local`,
      status: 'activa',
      lockedUntil: null,
      // Dos vivas de tres: la revocada no se cuenta.
      liveSessions: 2,
    });
  });

  it('un `id` que no es de ninguna consulta devuelve nulo, que es el `404` del contrato', async () => {
    const file = await repository.read({
      actor: ACTOR,
      practiceId: '00000000-0000-4000-8000-000000000000',
    });
    expect(file).toBeNull();
  });

  it('lo que este rol NO puede leer sigue cerrado, y por eso las dos consultas van por la función', async () => {
    // Si alguien «simplifica» el repositorio contando fichas o leyendo `session.practice_id`
    // a pelo, la ficha entera muere con «permiso denegado». Esto es lo que lo recuerda.
    await expect(
      read(ctxPlatform, 'select count(*) from patient where practice_id = $1', [FILE.practice]),
    ).rejects.toThrow(/permission denied for table patient/i);
    await expect(read(ctxPlatform, 'select practice_id from session limit 1')).rejects.toThrow(
      /permission denied for table session/i,
    );
    // Y la credencial de la dueña no se toca: soporte no ve contraseñas, lo promete la pantalla.
    await expect(read(ctxPlatform, 'select id from credential limit 1')).rejects.toThrow(
      /permission denied for table credential/i,
    );
  });
});

// =========================================================================================
// LA LECTURA DE LISTA, CONTRA LA BASE · `consultas.md`, 30 de octubre de 2026
//
// Lo que no se puede probar con dobles: que el cursor atraviese las filas sin saltarse ni
// repetir ninguna, y que `ilike` encuentre por nombre y por correo.
// =========================================================================================
describe('GET /v1/platform/tenants · buscar contra la base', () => {
  it('encuentra por nombre y por correo de la doctora, y lo que no existe da lista vacía', async () => {
    const porNombre = await repository.searchTenants({
      actor: ACTOR,
      search: { query: 'Clínica', cursor: null, perPage: 25 },
    });
    expect(porNombre.length).toBeGreaterThan(0);

    const unCorreo = porNombre[0]?.ownerEmail;
    expect(unCorreo).not.toBeNull();

    const porCorreo = await repository.searchTenants({
      actor: ACTOR,
      search: { query: unCorreo ?? '', cursor: null, perPage: 25 },
    });
    expect(porCorreo.map((r) => r.id)).toContain(porNombre[0]?.id);

    const nada = await repository.searchTenants({
      actor: ACTOR,
      search: { query: 'no-existe-esta-consulta', cursor: null, perPage: 25 },
    });
    expect(nada).toEqual([]);
  });

  it('el cursor no se salta ni repite: página a página sale el mismo conjunto', async () => {
    const todas = await repository.searchTenants({
      actor: ACTOR,
      search: { query: null, cursor: null, perPage: 100 },
    });
    expect(todas.length).toBeGreaterThan(1);

    // De una en una, siguiendo el cursor.
    const recorrido: string[] = [];
    let cursor: { at: Date; id: string } | null = null;
    for (let i = 0; i < todas.length + 2; i += 1) {
      const pagina: readonly { id: string; createdAt: Date }[] = await repository.searchTenants({
        actor: ACTOR,
        search: { query: null, cursor, perPage: 1 },
      });
      const fila = pagina[0];
      if (fila === undefined) break;
      recorrido.push(fila.id);
      cursor = { at: fila.createdAt, id: fila.id };
    }

    expect(recorrido).toEqual(todas.map((r) => r.id));
    expect(new Set(recorrido).size).toBe(recorrido.length);
  });

  // AQUÍ ESTABA «filtra por estado de licencia», con `?licencia=sin_enviar`. Y debajo, el
  // describe de `GET /v1/platform/licenses`, la bandeja: traía la matrícula, la clave de la
  // credencial y el orden ascendente por fecha de envío. Los dos se fueron con la revisión
  // manual el 30 de octubre de 2026: no hay estados que filtrar ni bandeja que servir.
});
