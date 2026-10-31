// La prueba de lo que añade la 0014: el borrado de la propia cuenta, el alta del equipo y
// el reenvío de acceso de la consola.
//
// Hermana de `isolation.spec.ts` y de `access-functions.spec.ts`, con las mismas reglas:
// contra la base real en Docker, sin un solo doble, y EN NINGÚN MOMENTO SE DESACTIVA RLS.
// Siembra el DUEÑO del esquema, que es quien migra; todo lo que se COMPRUEBA pasa por los
// roles de aplicación y por `withTenantContext()`.
//
// Archivo aparte y no dentro de `access-functions.spec.ts` por lo mismo que aquel está
// aparte del primero: la siembra es otra. Aquí hacen falta CUATRO consultas en estados
// distintos —una con equipo y fichas, una limpia, una con plan vigente y una ajena— porque
// los tres `409` del borrado y el `409` del equipo son justamente estados de la consulta, y
// una sola consulta no puede tenerlos todos a la vez sin que un caso pise al siguiente.

import { Pool, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantContext, type TenantContext } from './tenant-context';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ?? 'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

// Forma de Argon2id, de contraseñas aleatorias que no se guardaron. Aquí no se verifica
// ninguna: eso es de Node. La base solo mueve el hash de un lado a otro.
const HASH = '$argon2id$v=19$m=65536,p=4,t=3$Y2ljbG9kZXZpZGExMg$BcVqHhiTZ4RrQZ4kYgVvxCuUAneDdfTxZ6qz6hUwcLY';
const NEW_HASH = '$argon2id$v=19$m=65536,p=4,t=3$Y2ljbG9kZXZpZGEzNA$GVnsaFqlkimVX8dDYgVvxCuUAneDdfTxZ6qz6hUwcLY';

// Consulta con equipo Y fichas: los dos primeros `409` del borrado de la dueña.
const BUSY = {
  practice: 'ffffffff-0000-4000-8000-00000000001a',
  owner: 'ffffffff-0000-4000-8000-00000000002a',
  team: 'ffffffff-0000-4000-8000-00000000003a',
  patient: 'ffffffff-0000-4000-8000-00000000004a',
  link: 'ffffffff-0000-4000-8000-00000000005a',
  ownerEmail: 'duena.ocupada@ciclo.local',
  teamEmail: 'recepcion.ocupada@ciclo.local',
};
// La consulta de quien probó MedSkin y no siguió: sin equipo, sin fichas, sin plan vigente.
const CLEAN = {
  practice: 'ffffffff-0000-4000-8000-00000000001b',
  owner: 'ffffffff-0000-4000-8000-00000000002b',
  ownerEmail: 'duena.limpia@ciclo.local',
};
// Igual de limpia, pero con el plan renovando el mes que viene: `409 suscripcion_activa`.
const PAID = {
  practice: 'ffffffff-0000-4000-8000-00000000001c',
  owner: 'ffffffff-0000-4000-8000-00000000002c',
  ownerEmail: 'duena.conplan@ciclo.local',
};
// La consulta ajena: lo que el alta de equipo de BUSY no puede tocar ni ver.
const OTHER = {
  practice: 'ffffffff-0000-4000-8000-00000000001d',
  owner: 'ffffffff-0000-4000-8000-00000000002d',
  ownerEmail: 'duena.ajena@ciclo.local',
};
// La paciente que se borra: dos doctoras, dos fichas, dos vínculos y dos teléfonos.
const LEAVING = {
  account: 'ffffffff-0000-4000-8000-00000000001e',
  patientBusy: 'ffffffff-0000-4000-8000-00000000002e',
  linkBusy: 'ffffffff-0000-4000-8000-00000000003e',
  patientOther: 'ffffffff-0000-4000-8000-00000000004e',
  linkOther: 'ffffffff-0000-4000-8000-00000000005e',
  sessionOne: 'ffffffff-0000-4000-8000-00000000006e',
  sessionTwo: 'ffffffff-0000-4000-8000-00000000007e',
  email: 'seva@ciclo.local',
};
// La que YA eligió su contraseña: el `409` del reenvío de la consola.
const CHOSEN = { account: 'ffffffff-0000-4000-8000-00000000001f', email: 'yaelegi@ciclo.local' };
// La que sigue con la temporal: el `200` del reenvío de la consola.
const WAITING = { account: 'ffffffff-0000-4000-8000-00000000002f', email: 'esperando@ciclo.local' };

const PLATFORM = { account: 'ffffffff-0000-4000-8000-0000000000d0' };
const NOBODY = 'ffffffff-0000-4000-8000-0000000000e0';
const NEW_TEAM_EMAIL = 'nueva.recepcion@ciclo.local';

const ctxBusyOwner: TenantContext = {
  role: 'app_practitioner',
  practiceId: BUSY.practice,
  accountId: BUSY.owner,
};
const ctxBusyTeam: TenantContext = { role: 'app_practitioner', practiceId: BUSY.practice, accountId: BUSY.team };
const ctxCleanOwner: TenantContext = {
  role: 'app_practitioner',
  practiceId: CLEAN.practice,
  accountId: CLEAN.owner,
};
const ctxPaidOwner: TenantContext = { role: 'app_practitioner', practiceId: PAID.practice, accountId: PAID.owner };
const ctxLeaving: TenantContext = { role: 'app_patient', accountId: LEAVING.account };
const ctxLeavingRestricted: TenantContext = { role: 'app_account', accountId: LEAVING.account };
const ctxPlatform: TenantContext = { role: 'app_platform', accountId: PLATFORM.account };

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 1 });

// El plazo legal sale de la configuración del despliegue (`CONSERVACION_ANOS`), no de una
// tabla: decisión del 28 de octubre, la misma forma que `REGION_ETIQUETA`. Aquí se pasa
// como lo que es, un argumento calculado por el llamador.
const RETENTION_UNTIL = '2033-10-27';

// El día que renueva el plan de PAID, y lo pone el RELOJ DE LA BASE en la siembra. Escrito
// a mano era una fecha que caduca: la función compara `plan_renews_on >= current_date`
// contra el `current_date` DEL SERVIDOR, así que un literal deja de ser «vigente» el día
// que lo pasa y el `409 suscripcion_activa` se convierte en un borrado. Se guarda como
// texto `AAAA-MM-DD` y se compara como texto: convertirlo a `Date` en Node lo movería un
// día entero en cualquier zona al este de Greenwich.
let paidRenewsOn = '';

async function seedPractice(t: { practice: string; owner: string; ownerEmail: string }, name: string, renews: string | null) {
  await owner.query(
    `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit, plan_renews_on)
     values ($1, $2, 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300, $3)`,
    [t.practice, name, renews],
  );
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name, phone)
     values ($1, $2, 'doctor', 'latam', 'Andrea', 'Paz', '+59170000001')`,
    [t.owner, t.ownerEmail],
  );
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, set_at) values ($1, $2, false, now())`,
    [t.owner, HASH],
  );
  await owner.query(
    `insert into practitioner (practice_id, account_id, first_name, last_name, role)
     values ($1, $2, 'Andrea', 'Paz', 'doctor')`,
    [t.practice, t.owner],
  );
  await owner.query('update practice set owner_account_id = $1 where id = $2', [t.owner, t.practice]);
  await owner.query(
    `insert into license (practice_id, license_number) values ($1, '48921')`,
    [t.practice],
  );
}

async function seed() {
  await clean();
  await seedPractice(BUSY, 'Consulta ocupada', null);
  await seedPractice(CLEAN, 'Consulta limpia', null);
  // El plan renueva dentro de un mes: vigente, así que su dueña no puede borrarse.
  const { rows: renewal } = await owner.query<{ day: string }>('select (current_date + 31)::text as day');
  paidRenewsOn = renewal[0]?.day ?? '';
  await seedPractice(PAID, 'Consulta con plan', paidRenewsOn);
  await seedPractice(OTHER, 'Consulta ajena', null);

  // Recepción de BUSY: no es la dueña, y es lo que el `not_allowed` del borrado y el
  // `not_owner` del alta de equipo comprueban.
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'doctor', 'latam', 'Rosa', 'Mamani')`,
    [BUSY.team, BUSY.teamEmail],
  );
  await owner.query(
    `insert into practitioner (practice_id, account_id, first_name, last_name, role)
     values ($1, $2, 'Rosa', 'Mamani', 'doctor')`,
    [BUSY.practice, BUSY.team],
  );

  // La paciente que se va: una cuenta, DOS fichas de DOS consultas que no comparten nada.
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name, phone)
     values ($1, $2, 'patient', 'latam', 'Valeria', 'Antelo', '+59177124408')`,
    [LEAVING.account, LEAVING.email],
  );
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, set_at) values ($1, $2, false, now())`,
    [LEAVING.account, HASH],
  );
  await owner.query(
    `insert into session (id, account_id, scope, device_id) values ($1, $2, 'completo', 'disp-1'),
            ($3, $2, 'completo', 'disp-2')`,
    [LEAVING.sessionOne, LEAVING.account, LEAVING.sessionTwo],
  );
  const ficha = async (practice: string, patientId: string, linkId: string, practiceName: string) => {
    await owner.query(
      `insert into patient (id, practice_id, first_name, last_name, birth_date, email, phone, how_arrived)
       values ($1, $2, 'Valeria', 'Antelo', '1992-04-18', $3, '+59177124408', 'instagram')`,
      [patientId, practice, LEAVING.email],
    );
    await owner.query(
      `insert into patient_link (id, practice_id, patient_id, account_id, status, email,
                                 practice_name, practitioner_name)
       values ($1, $2, $3, $4, 'vinculada', $5, $6, 'Dra. Andrea Paz')`,
      [linkId, practice, patientId, LEAVING.account, LEAVING.email, practiceName],
    );
  };
  await ficha(BUSY.practice, LEAVING.patientBusy, LEAVING.linkBusy, 'Consulta ocupada');
  await ficha(OTHER.practice, LEAVING.patientOther, LEAVING.linkOther, 'Consulta ajena');

  // La ficha propia de BUSY, que es lo que dispara su `409 consulta_con_pacientes`.
  await owner.query(
    `insert into patient (id, practice_id, first_name, last_name, birth_date, email, how_arrived)
     values ($1, $2, 'Rocio', 'Vargas', '1990-02-02', 'rocio@ciclo.local', 'referida')`,
    [BUSY.patient, BUSY.practice],
  );

  // Las dos del reenvío de la consola: una que ya eligió y una que sigue con la temporal.
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'patient', 'latam', 'Carla', 'Rojas'), ($3, $4, 'patient', 'latam', 'Lucia', 'Suarez')`,
    [CHOSEN.account, CHOSEN.email, WAITING.account, WAITING.email],
  );
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, set_at, temp_used_at)
     values ($1, $2, false, now(), now())`,
    [CHOSEN.account, HASH],
  );
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, temp_expires_at)
     values ($1, $2, true, now() + interval '72 hours')`,
    [WAITING.account, HASH],
  );
}

async function clean() {
  const practices = [BUSY.practice, CLEAN.practice, PAID.practice, OTHER.practice];
  await owner.query('delete from practice where id = any($1::uuid[])', [practices]);
  await owner.query('delete from access_audit where practice_id = any($1::uuid[])', [practices]);
  // Las cuentas por correo y no por id: el borrado les cambia el correo, así que se barre
  // también el patrón que la anonimización deja.
  await owner.query(
    `delete from account where email = any($1::citext[])
        or email like 'borrada+%@medskin.invalid'`,
    [
      [
        BUSY.ownerEmail,
        BUSY.teamEmail,
        CLEAN.ownerEmail,
        PAID.ownerEmail,
        OTHER.ownerEmail,
        LEAVING.email,
        CHOSEN.email,
        WAITING.email,
        NEW_TEAM_EMAIL,
      ],
    ],
  );
  await owner.query(`delete from access_audit where action = 'account.delete'`);
}

function read<T extends QueryResultRow = Record<string, string>>(
  pool: Pool,
  ctx: TenantContext,
  sql: string,
  params: unknown[] = [],
) {
  return withTenantContext(pool, ctx, async (client) => (await client.query<T>(sql, params)).rows);
}

async function whatItSees(pool: Pool, ctx: TenantContext, sql: string, params: unknown[] = []) {
  try {
    return `${(await read(pool, ctx, sql, params)).length} filas`;
  } catch (failure) {
    if ((failure as { code?: string }).code === '42501') return 'permiso denegado';
    throw failure;
  }
}

beforeAll(seed, 60_000);
afterAll(async () => {
  await clean();
  await Promise.all([owner.end(), app.end()]);
}, 60_000);

// =========================================================================================
// DELETE /v1/accounts/mine · medskin_delete_own_account()
// =========================================================================================
describe('el borrado de la propia cuenta', () => {
  it('a la paciente le quita el acceso, le suelta el correo y le deja el expediente', async () => {
    const [result] = await read(app, ctxLeaving, 'select * from medskin_delete_own_account($1::date, $2)', [
      RETENTION_UNTIL,
      'ya_no_la_uso',
    ]);
    expect({
      verdict: result?.verdict,
      sessions: Number(result?.sessions_revoked),
      links: Number(result?.links_detached),
      practice: result?.practice_deleted,
    }).toEqual({ verdict: 'deleted', sessions: 2, links: 2, practice: false });

    // La cuenta: anonimizada, no borrada. Y el correo SUELTO del índice único, que es la
    // mitad de «vuelve si tu doctora te da de alta otra vez con este mismo correo».
    const { rows: account } = await owner.query<{ email: string }>(
      `select email::text, first_name, last_name, phone, status, deletion_reason,
              deleted_at is not null as marked
         from account where id = $1`,
      [LEAVING.account],
    );
    expect(account[0]).toMatchObject({
      first_name: 'Cuenta',
      last_name: 'borrada',
      phone: null,
      status: 'borrada',
      deletion_reason: 'ya_no_la_uso',
      marked: true,
    });
    expect(account[0]?.email).toBe(`borrada+${LEAVING.account}@medskin.invalid`);

    // El acceso: fila fuera, no marca. Lo que se conserva no puede ser una contraseña viva.
    const { rows: credential } = await owner.query('select 1 from credential where account_id = $1', [
      LEAVING.account,
    ]);
    expect(credential).toHaveLength(0);

    // «Todas las sesiones se revocan en el acto, en todos los dispositivos», la que llama
    // incluida: no queda cuenta a la que volver.
    const { rows: live } = await owner.query<{ n: number }>(
      'select count(*)::int as n from session where account_id = $1 and revoked_at is null',
      [LEAVING.account],
    );
    expect(live[0]?.n).toBe(0);

    // Los dos vínculos, uno por cada doctora que la tenía: desenganchados, de vuelta a
    // `invitada`, y CON SU CORREO INTACTO, que es la llave del «vuelve_si».
    const { rows: links } = await owner.query(
      'select account_id, status, email::text from patient_link where id = any($1::uuid[]) order by id',
      [[LEAVING.linkBusy, LEAVING.linkOther]],
    );
    expect(links).toEqual([
      { account_id: null, status: 'invitada', email: LEAVING.email },
      { account_id: null, status: 'invitada', email: LEAVING.email },
    ]);

    // Y el expediente sigue ahí, las dos fichas de las dos consultas.
    const { rows: fichas } = await owner.query<{ n: number }>(
      'select count(*)::int as n from patient where id = any($1::uuid[])',
      [[LEAVING.patientBusy, LEAVING.patientOther]],
    );
    expect(fichas[0]?.n).toBe(2);
  });

  it('el plazo con el que se borró queda en la bitácora, que es el dato que una variable de entorno no cuenta hacia atrás', async () => {
    const { rows } = await owner.query(
      `select data->>'retention_until' as until, data->>'reason' as reason,
              (data->>'practice_deleted')::boolean as practice_deleted
         from access_audit where action = 'account.delete' and subject_id = $1`,
      [LEAVING.account],
    );
    expect(rows[0]).toEqual({ until: RETENTION_UNTIL, reason: 'ya_no_la_uso', practice_deleted: false });

    // Y LA FECHA QUEDA TAMBIÉN EN EL VÍNCULO SUELTO, que es la única fila desde la que un
    // barrendero puede volver a la ficha: en `access_audit` no sirve, porque el correo de la
    // cuenta se anonimiza y desde la bitácora ya no se llega a nadie.
    const { rows: vinculos } = await owner.query<{ retention_until: string | null }>(
      `select to_char(retention_until, 'YYYY-MM-DD') as retention_until
         from patient_link where patient_id = any($1::uuid[])`,
      [[LEAVING.patientBusy, LEAVING.patientOther]],
    );
    expect(vinculos.map((v) => v.retention_until)).toEqual([RETENTION_UNTIL, RETENTION_UNTIL]);
  });

  it('cumplido el plazo, el barrendero anonimiza la ficha y deja los libros de la consulta', async () => {
    // El plazo vence: se adelanta la fecha, que es lo que haría el calendario.
    await owner.query(
      `update patient_link set retention_until = current_date - 1
        where patient_id = any($1::uuid[])`,
      [[LEAVING.patientBusy, LEAVING.patientOther]],
    );

    const { rows: barridas } = await owner.query<{ n: number }>(
      'select medskin_purge_retained(50) as n',
    );
    expect(Number(barridas[0]?.n)).toBe(2);

    // La ficha se QUEDA, anonimizada: borrar la fila arrastraría en cascada `payment` y
    // `appointment`, que son los libros de la consulta y no son dato de la paciente.
    const { rows: fichas } = await owner.query<{
      first_name: string;
      email: string | null;
      phone: string | null;
      status: string;
      purged: boolean;
    }>(
      `select first_name, email, phone, status, purged_at is not null as purged
         from patient where id = $1`,
      [LEAVING.patientBusy],
    );
    // El correo se ANONIMIZA en vez de irse: la columna es `NOT NULL` y tiene razón —el correo
    // de la ficha es por dónde la doctora le escribe—, así que queda uno del dominio inválido
    // que no es de nadie, igual que en el borrado de la cuenta.
    expect(fichas[0]).toMatchObject({
      first_name: 'Ficha',
      phone: null,
      status: 'archivada',
      purged: true,
    });
    expect(fichas[0]?.email).toContain('@medskin.invalid');

    // El dato de salud, fuera. Y el vínculo suelto también: su correo era la llave del
    // «vuelve_si», y pasado el plazo ya no hay nada a lo que volver.
    const { rows: resto } = await owner.query<{ historias: string; vinculos: string }>(
      `select (select count(*)::text from medical_history where patient_id = $1) as historias,
              (select count(*)::text from patient_link where patient_id = $1) as vinculos`,
      [LEAVING.patientBusy],
    );
    expect(resto[0]).toEqual({ historias: '0', vinculos: '0' });

    // Y queda la línea de que se fue, con la fecha que se le prometió.
    const { rows: linea } = await owner.query<{ n: string }>(
      `select count(*)::text as n from access_audit
        where action = 'paciente.plazo_cumplido' and subject_id = $1`,
      [LEAVING.patientBusy],
    );
    expect(linea[0]?.n).toBe('1');

    // Segunda pasada: nada que hacer. Idempotente por `purged_at`.
    const { rows: otra } = await owner.query<{ n: number }>(
      'select medskin_purge_retained(50) as n',
    );
    expect(Number(otra[0]?.n)).toBe(0);
  });

  it('borrar lo ya borrado devuelve el mismo 200, con la fecha del borrado de verdad', async () => {
    const { rows: before } = await owner.query<{ deleted_at: string }>(
      'select deleted_at from account where id = $1',
      [LEAVING.account],
    );
    // El contexto sigue valiendo: el token ya no, pero eso es del borde. Lo que la base
    // tiene que garantizar es que el segundo intento no vuelva a escribir nada.
    const [again] = await read(app, ctxLeaving, 'select * from medskin_delete_own_account($1::date, $2)', [
      RETENTION_UNTIL,
      null,
    ]);
    expect(again?.verdict).toBe('already_deleted');
    expect(again?.deleted_at).toEqual(before[0]?.deleted_at);
    // Y ni una segunda línea de bitácora: un reintento no es un segundo borrado.
    const { rows: audit } = await owner.query<{ n: number }>(
      `select count(*)::int as n from access_audit where action = 'account.delete' and subject_id = $1`,
      [LEAVING.account],
    );
    expect(audit[0]?.n).toBe(1);
  });

  it('recepción no puede borrarse desde aquí, y no es una comprobación del controlador', async () => {
    const [result] = await read(app, ctxBusyTeam, 'select * from medskin_delete_own_account($1::date, $2)', [
      RETENTION_UNTIL,
      null,
    ]);
    expect(result?.verdict).toBe('not_allowed');
    const { rows } = await owner.query<{ deleted_at: string | null }>(
      'select deleted_at from account where id = $1',
      [BUSY.team],
    );
    expect(rows[0]?.deleted_at).toBeNull();
  });

  it('los tres 409 de la dueña, en el orden del contrato y sin escribir nada', async () => {
    // 1 · equipo, que es lo único que ella puede desarmar sola.
    const [withTeam] = await read(app, ctxBusyOwner, 'select * from medskin_delete_own_account($1::date, $2)', [
      RETENTION_UNTIL,
      null,
    ]);
    expect(withTeam?.verdict).toBe('practice_has_team');

    // 2 · fichas, con el número dentro porque la frase lo lleva («tiene 148 pacientes»).
    await owner.query(`update practitioner set status = 'retirada' where account_id = $1`, [BUSY.team]);
    const [withPatients] = await read(app, ctxBusyOwner, 'select * from medskin_delete_own_account($1::date, $2)', [
      RETENTION_UNTIL,
      null,
    ]);
    expect({ verdict: withPatients?.verdict, count: Number(withPatients?.patient_count) }).toEqual({
      verdict: 'practice_has_patients',
      count: 2,
    });

    // 3 · suscripción, con la fecha por lo mismo.
    // El día se pide YA EN TEXTO al motor: es lo que la frase del error interpola («Tu plan
    // sigue activo hasta el 14 de noviembre») y así no pasa por `Date`, que lo movería un
    // día en cualquier zona al este de Greenwich.
    const [withPlan] = await read(
      app,
      ctxPaidOwner,
      'select verdict, plan_renews_on::text as plan_renews_on from medskin_delete_own_account($1::date, $2)',
      [RETENTION_UNTIL, null],
    );
    expect({ verdict: withPlan?.verdict, renews: withPlan?.plan_renews_on }).toEqual({
      verdict: 'subscription_active',
      renews: paidRenewsOn,
    });

    // Y ninguno de los tres escribió: la consulta y las dos cuentas siguen vivas.
    const { rows } = await owner.query<{ n: number }>(
      'select count(*)::int as n from account where id = any($1::uuid[]) and deleted_at is null',
      [[BUSY.owner, PAID.owner]],
    );
    expect(rows[0]?.n).toBe(2);
  });

  it('la dueña sin una sola ficha sí puede borrarse, y la consulta se va con ella', async () => {
    const [result] = await read(app, ctxCleanOwner, 'select * from medskin_delete_own_account($1::date, $2)', [
      RETENTION_UNTIL,
      null,
    ]);
    expect({ verdict: result?.verdict, practice: result?.practice_deleted }).toEqual({
      verdict: 'deleted',
      practice: true,
    });
    const { rows } = await owner.query('select 1 from practice where id = $1', [CLEAN.practice]);
    expect(rows).toHaveLength(0);
    // La licencia se fue con la consulta por `cascade`, y no había expediente que conservar.
    const { rows: license } = await owner.query('select 1 from license where practice_id = $1', [CLEAN.practice]);
    expect(license).toHaveLength(0);
  });

  it('ni la consola ni una sesión restringida pueden borrar una cuenta', async () => {
    // `app_platform`: borrar la cuenta de alguien es el traspaso de una consulta, y eso es
    // otro tramo. `app_account`: el token de recuperación es una sesión a medio abrir y la
    // pantalla que borra pide la contraseña actual, que es lo que esa sesión no tiene.
    expect({
      platform: await whatItSees(app, ctxPlatform, 'select * from medskin_delete_own_account($1::date, null)', [
        RETENTION_UNTIL,
      ]),
      restricted: await whatItSees(
        app,
        ctxLeavingRestricted,
        'select * from medskin_delete_own_account($1::date, null)',
        [RETENTION_UNTIL],
      ),
    }).toEqual({ platform: 'permiso denegado', restricted: 'permiso denegado' });
  });
});

// =========================================================================================
// POST /v1/team · medskin_create_team_member()
// =========================================================================================
describe('el reenvío de acceso de la consola', () => {
  const expires = () => new Date(Date.now() + 72 * 3600_000).toISOString();
  const resend = (ctx: TenantContext, accountId: string) =>
    read(ctx === ctxPlatform ? app : app, ctx, 'select * from medskin_platform_resend_access($1, $2, $3::timestamptz)', [
      accountId,
      NEW_HASH,
      expires(),
    ]);

  it('acuña una temporal nueva y no devuelve ni el hash ni el correo', async () => {
    const [result] = await resend(ctxPlatform, WAITING.account);
    expect(result?.outcome).toBe('acceso_renovado');
    // «Soporte no la ve»: la función devuelve dos columnas y ninguna es la contraseña.
    expect(Object.keys(result ?? {}).sort()).toEqual(['expires_at', 'outcome']);

    const { rows } = await owner.query(
      'select hash, is_temporary, temp_first_used_at from credential where account_id = $1',
      [WAITING.account],
    );
    // La anterior muere aquí, y `temp_first_used_at` vuelve a nulo: esta temporal es otra.
    expect(rows[0]).toEqual({ hash: NEW_HASH, is_temporary: true, temp_first_used_at: null });
  });

  it('no resetea la contraseña de quien ya eligió la suya, ni alcanza una cuenta borrada', async () => {
    expect({
      chosen: (await resend(ctxPlatform, CHOSEN.account))[0]?.outcome,
      // Misma respuesta que un `cuenta_id` inventado: no se distingue «borrada» de «no existe».
      deleted: (await resend(ctxPlatform, LEAVING.account))[0]?.outcome,
      missing: (await resend(ctxPlatform, NOBODY))[0]?.outcome,
    }).toEqual({
      chosen: 'ya_eligio_su_contrasena',
      deleted: 'cuenta_no_existe',
      missing: 'cuenta_no_existe',
    });
    // Y la contraseña elegida sigue siendo la que era.
    const { rows } = await owner.query<{ hash: string }>('select hash from credential where account_id = $1', [
      CHOSEN.account,
    ]);
    expect(rows[0]?.hash).toBe(HASH);
  });

  it('una doctora no puede llamarla, y es un grant y no un predicado', async () => {
    // `current_user` dentro de una `SECURITY DEFINER` es `medskin_access`, no quien llama,
    // así que el portero es el `GRANT EXECUTE` a `app_platform` y nadie más.
    expect(
      await whatItSees(app, ctxBusyOwner, 'select * from medskin_platform_resend_access($1, $2, $3::timestamptz)', [
        WAITING.account,
        NEW_HASH,
        expires(),
      ]),
    ).toBe('permiso denegado');
  });

  it('y la consola sigue sin leer una sola fila clínica', async () => {
    // La otra mitad del contrato: las dos acciones están marcadas «Seguro» en la pantalla
    // porque no tocan ningún dato clínico, y eso tiene que ser verdad en la base.
    expect({
      patient: await whatItSees(app, ctxPlatform, 'select id from patient'),
      patient_link: await whatItSees(app, ctxPlatform, 'select id from patient_link'),
      medical_history: await whatItSees(app, ctxPlatform, 'select id from medical_history'),
      credential: await whatItSees(app, ctxPlatform, 'select account_id from credential'),
    }).toEqual({
      patient: 'permiso denegado',
      patient_link: 'permiso denegado',
      medical_history: 'permiso denegado',
      credential: 'permiso denegado',
    });
  });
});
