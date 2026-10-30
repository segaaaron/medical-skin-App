// Los tres endpoints de consola CONTRA LA BASE REAL, porque es lo único que puede probar lo
// que decide de verdad qué ve soporte: los `GRANT` por columna y las políticas de
// `app_platform`. Con dobles eso es invisible.
//
// Mismas reglas que `isolation.spec.ts` y `practice-license.spec.ts`: siembra el DUEÑO del
// esquema, que es quien migra; todo lo que se COMPRUEBA pasa por `app_platform` y por
// `withTenantContext()`. En ningún momento se desactiva RLS.
//
// Lo que NO se repite aquí porque ya está probado en otro archivo: que la fila de `license`
// nace con la consulta (0015), que la decisión mueve el estado con un `UPDATE` acotado, y que
// `app_platform` no lee `patient` ni `session.practice_id`. Lo que sí se comprueba es que
// ESTE código no los nombra: las dos consultas que los necesitan van por la función.

import { Pool, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { CreatedTenant, DecidedLicense, PlatformActor } from '../domain/platform-ports';
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
  // detrás, y por eso `license.reviewed_by` y `access_audit.actor_account_id` no tienen clave
  // foránea.
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
/** La de la decisión: nace en `en_revision`. */
const REVIEW = {
  practice: 'cccccccc-0000-4000-8000-00000000000c',
  account: 'cccccccc-0000-4000-8000-00000000001c',
};
/** La que nunca mandó su licencia: el `409 licencia_sin_enviar`. */
const UNSENT = {
  practice: 'cccccccc-0000-4000-8000-00000000000d',
  account: 'cccccccc-0000-4000-8000-00000000001d',
};

/** La de la carrera de decisiones: propia, para no moverle el estado a las otras pruebas. */
const RACE = {
  // El último carácter decide el correo de su dueña en `seed()`, así que es distinto del de
  // las otras tres: con `c` chocaba con `REVIEW` contra `account_email_uq`.
  practice: 'cccccccc-0000-4000-8000-0000000000a9',
  account: 'cccccccc-0000-4000-8000-0000000001a9',
};

const SEEDED = [FILE.practice, REVIEW.practice, UNSENT.practice, RACE.practice];

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
// `max: 2` y no 1: la prueba de concurrencia abre DOS transacciones a la vez, y con una sola
// conexión la segunda esperaría a que la primera la suelte en vez de competir por la clave.
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

async function seed(p: { practice: string; account: string; name: string; licenseStatus: string }) {
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
    `insert into license (practice_id, status, practice_country, specialty, license_number,
                          credential_key, declaration_accepted, terms_accepted, submitted_at,
                          response_estimated_at)
     values ($1, $2, 'BO', 'medicina_estetica', '48921', 'lic/x/4f2a.pdf', true, true,
             now() - interval '1 day', now() + interval '1 day')`,
    [p.practice, p.licenseStatus],
  );
}

async function clean() {
  // Las consultas que el alta crea dentro de la prueba no tienen un `id` fijo: se buscan por
  // su nombre, que es el que esta prueba escribe.
  const { rows } = await owner.query<{ id: string }>(
    `select id from practice where name in ('Clínica Nueva', 'Clínica Repetida')`,
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
  await seed({ ...FILE, name: 'Clínica Paz', licenseStatus: 'verificada' });
  await owner.query(
    `update license set decided_at = now(), reviewed_by = $2 where practice_id = $1`,
    [FILE.practice, ACTOR.subject],
  );
  await seed({ ...REVIEW, name: 'Clínica En Revisión', licenseStatus: 'en_revision' });
  await seed({ ...UNSENT, name: 'Clínica Sin Enviar', licenseStatus: 'sin_enviar' });
  await seed({ ...RACE, name: 'Clínica De La Carrera', licenseStatus: 'en_revision' });
  await owner.query(
    `update license set submitted_at = null, response_estimated_at = null where practice_id = $1`,
    [UNSENT.practice],
  );

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
  it('crea consulta, dueña, credencial y LICENCIA `sin_enviar` sin insertar la licencia', async () => {
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
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      },
      respond: (created) => created,
    });

    expect(admission.verdict).toBe('created');
    const created = admission.served?.response;
    expect(created?.practiceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(admission.served?.status).toBe(201);

    // La fila de `license` la creó la FUNCIÓN (0015): aquí nadie la insertó, y antes de esa
    // migración la dueña se quedaba sin poder enviar nada y nadie se enteraba.
    const license = await read<{ status: string; submitted_at: Date | null }>(
      ctxPlatform,
      'select status, submitted_at from license where practice_id = $1',
      [created?.practiceId],
    );
    expect(license).toEqual([{ status: 'sin_enviar', submitted_at: null }]);

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
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      },
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
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    };

    const first = await repository.create({
      actor: ACTOR,
      idempotency,
      practice,
      owner: ownerData,
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
          expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        },
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
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      },
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
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    },
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

  it('la decisión de licencia no da `already_decided` a la perdedora', async () => {
    // El `FOR UPDATE` serializa la licencia, NO la clave: sin `claim()` delante, la segunda
    // esperaba, encontraba el estado ya movido y recibía el 409 que el propio contrato
    // promete que no va a ver («la misma decisión dos veces no manda dos avisos»).
    const decision = {
      actor: ACTOR,
      practiceId: RACE.practice,
      decision: { status: 'verificada' as const, rejectionReason: null },
      idempotency: { key: 'consola-carrera-decision', bodyHash: 'huella-decision' },
      respond: (decided: DecidedLicense) => decided,
    };

    const [una, otra] = await Promise.all([
      repository.decide(decision),
      repository.decide(decision),
    ]);

    expect([una.outcome, otra.outcome]).toEqual(['decided', 'decided']);
    expect([una.served?.replayed, otra.served?.replayed].filter(Boolean)).toHaveLength(1);
    // Lo mismo, y aquí además MEDIDO: `jsonb` devolvió las claves en otro orden
    // —`patientLimit` antes de `activePatients`—, así que ni comparar las dos cadenas sirve.
    // Lo que se repite es la misma respuesta, no los mismos bytes.
    expect(comoJson(una.served?.response)).toEqual(comoJson(otra.served?.response));

    // Una sola decisión en la bitácora: no se mandaron dos avisos.
    const { rows } = await owner.query<{ total: string }>(
      `select count(*)::text as total from access_audit
        where practice_id = $1 and action = 'license.decision'`,
      [RACE.practice],
    );
    expect(rows[0]?.total).toBe('1');

    // Y A LA DUEÑA SE LE AVISA, por los dos canales y una sola vez. Antes la decisión se
    // escribía y la doctora no se enteraba de nada: abría la app y mirába si había cambiado.
    const { rows: avisos } = await owner.query<{
      channel: string;
      subject_key: string;
      data: Record<string, unknown>;
    }>(
      `select channel, subject_key, data from notification_outbox
        where practice_id = $1 and kind = 'seguridad' order by channel`,
      [RACE.practice],
    );
    expect(avisos.map((a) => a.channel)).toEqual(['correo', 'push']);
    expect(avisos[0]?.subject_key).toBe('licencia_aprobada');
    // Y el aviso no lleva el motivo de nada: solo el estado.
    expect(avisos[0]?.data).toEqual({ estado: 'verificada' });
  });

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
  it('sirve metadatos, estados y TRES números, sin leer una sola fila de paciente', async () => {
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
    expect(file?.license.status).toBe('verificada');
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

describe('POST /v1/platform/tenants/{id}/license/decision · sin función', () => {
  const inReview = () => ({ status: 'verificada' as const, rejectionReason: null });

  it('sin licencia es `no_license`, y `sin_enviar` es su propio resultado', async () => {
    const missing = await repository.decide({
      actor: ACTOR,
      practiceId: '00000000-0000-4000-8000-000000000000',
      decision: inReview(),
      idempotency: { key: 'consola-3', bodyHash: 'huella-3' },
      respond: (decided) => decided,
    });
    expect(missing.outcome).toBe('no_license');

    const unsent = await repository.decide({
      actor: ACTOR,
      practiceId: UNSENT.practice,
      decision: inReview(),
      idempotency: { key: 'consola-4', bodyHash: 'huella-4' },
      respond: (decided) => decided,
    });
    // El código nuevo del 28 de octubre: decirle «ya se decidió» a soporte le haría buscar
    // una decisión que no existe.
    expect(unsent.outcome).toBe('not_submitted');
  });

  it('verifica una vez, deja su fila de auditoría con quién decidió, y la segunda vez es `already_decided`', async () => {
    const decided = await repository.decide({
      actor: ACTOR,
      practiceId: REVIEW.practice,
      decision: inReview(),
      idempotency: { key: 'consola-5', bodyHash: 'huella-5' },
      respond: (result) => result,
    });

    expect(decided.outcome).toBe('decided');
    expect(decided.served?.response).toMatchObject({
      status: 'verificada',
      activePatients: 0,
      patientLimit: 300,
    });

    const license = await read<{ status: string; reviewed_by: string; decided_at: Date }>(
      ctxPlatform,
      'select status, reviewed_by, decided_at from license where practice_id = $1',
      [REVIEW.practice],
    );
    // `reviewed_by` es el `sub` del token de plataforma: un `uuid` SIN clave foránea, porque
    // esa persona no tiene fila en `account` y no vive en esta región.
    expect(license[0]?.status).toBe('verificada');
    expect(license[0]?.reviewed_by).toBe(ACTOR.subject);

    const audit = await read<{
      action: string;
      actor_label: string;
      actor_account_id: string;
      data: unknown;
    }>(
      ctxPlatform,
      `select action, actor_label, actor_account_id, data
         from access_audit where practice_id = $1 and action = 'license.decision'`,
      [REVIEW.practice],
    );
    expect(audit).toEqual([
      {
        action: 'license.decision',
        actor_label: 'Soporte MedSkin',
        actor_account_id: ACTOR.subject,
        // La decisión, y NUNCA el motivo del rechazo: esta tabla la lee soporte entera.
        data: { decision: 'verificada' },
      },
    ]);

    const again = await repository.decide({
      actor: ACTOR,
      practiceId: REVIEW.practice,
      decision: inReview(),
      idempotency: { key: 'consola-6', bodyHash: 'huella-6' },
      respond: (result) => result,
    });
    expect(again.outcome).toBe('already_decided');
    // Y no hay una segunda línea de bitácora: la transacción del `409` se deshizo entera.
    const audits = await read<{ count: string }>(
      ctxPlatform,
      `select count(*) as count from access_audit
        where practice_id = $1 and action = 'license.decision'`,
      [REVIEW.practice],
    );
    expect(audits).toEqual([{ count: '1' }]);
  });

  it('un rechazo escribe su motivo, y con su clave el reintento repite el 200 en vez del 409', async () => {
    await owner.query(
      `update license set status = 'en_revision', decided_at = null,
                              rejection_reason = null where practice_id = $1`,
      [REVIEW.practice],
    );

    const idempotency = { key: 'decision-1', bodyHash: fingerprintOf({ decision: 'rechazada' }) };
    const decision = {
      status: 'rechazada' as const,
      rejectionReason: 'La credencial está vencida: manda la vigente.',
    };

    const first = await repository.decide({
      actor: ACTOR,
      practiceId: REVIEW.practice,
      decision,
      idempotency,
      respond: (result) => result,
    });
    expect(first.outcome).toBe('decided');
    expect(first.served?.replayed).toBe(false);

    const license = await read<{ status: string; rejection_reason: string }>(
      ctxPlatform,
      'select status, rejection_reason from license where practice_id = $1',
      [REVIEW.practice],
    );
    expect(license).toEqual([
      { status: 'rechazada', rejection_reason: 'La credencial está vencida: manda la vigente.' },
    ]);

    // «La misma decisión dos veces no manda dos avisos»: con su clave, el reintento devuelve
    // el 200 de la primera y no el `409` de «ya se decidió».
    const again = await repository.decide({
      actor: ACTOR,
      practiceId: REVIEW.practice,
      decision,
      idempotency,
      respond: (result) => result,
    });
    expect(again.outcome).toBe('decided');
    expect(again.served?.replayed).toBe(true);
    expect(again.served?.status).toBe(200);
  });
});
