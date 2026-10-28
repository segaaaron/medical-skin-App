// Las TRES consultas nuevas contra la base real, y existen por una razón que un doble no
// puede sostener: **lo que un rol de aplicación puede leer no lo decide este código, lo
// deciden sus `GRANT` por columna y sus políticas.** Una columna de más en el `select` no
// falla al compilar ni en una prueba con dobles: falla con «permiso denegado» en la pantalla
// de arranque de las dos apps.
//
// Lo que se comprueba aquí:
//   · `GET /v1/cuentas/mia` servido por los TRES roles que lo pueden pedir —`app_patient`,
//     `app_account` (la sesión restringida) y `app_practitioner`— sin un solo `where`: la
//     fila que vuelve es la de quien pregunta porque lo dicen `account_own` y
//     `credential_own`, y el `hash` no se nombra porque no hay `GRANT` que lo permita;
//   · `doctoras` cruzando inquilinos, que es la única lectura del sistema que lo hace, y
//     cruzando SOLO las fichas de quien pregunta;
//   · el `desde` en la zona del despliegue: con el UTC de la conexión, un vínculo creado a
//     las 22:00 en La Paz se mostraría al día siguiente;
//   · `POST /v1/equipo` con el nombre de la consulta leído en la MISMA transacción y su
//     línea de bitácora, y el `email_taken` de un correo que ya tiene cuenta en la región.
//
// Siembra el DUEÑO del esquema, que es quien migra; todo lo que se comprueba pasa por
// `withTenantContext()` con el rol y el contexto de verdad. En ningún momento se desactiva
// RLS.

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AccountOwner } from '../domain/ports';
import { AccountsRepository } from './accounts.repository';
import { TeamRepository } from './team.repository';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl =
  process.env.DATABASE_URL_POOLER ??
  process.env.DATABASE_URL ??
  'postgresql://medskin:dev_local_only@localhost:5433/medskin';

// Espacio de identificadores propio: ninguna otra prueba usa este prefijo. Dos semillas con
// el mismo uuid se pisan y el fallo sale en el `beforeAll` de quien llegue segundo.
const CONSULTA = '7b7b7b7b-0000-4000-8000-000000000001';
const OTRA_CONSULTA = '7b7b7b7b-0000-4000-8000-000000000002';
const DUENA = '7b7b7b7b-0000-4000-8000-000000000003';
const OTRA_DUENA = '7b7b7b7b-0000-4000-8000-000000000004';
const PACIENTE = '7b7b7b7b-0000-4000-8000-000000000005';
const FICHA = '7b7b7b7b-0000-4000-8000-000000000006';
const FICHA_AJENA = '7b7b7b7b-0000-4000-8000-000000000007';
const VINCULO = '7b7b7b7b-0000-4000-8000-000000000008';
const VINCULO_AJENO = '7b7b7b7b-0000-4000-8000-000000000009';
const SESION = '7b7b7b7b-0000-4000-8000-00000000000a';

const CORREO_DUENA = 'andrea.perfil@cuentamia.local';
const CORREO_OTRA_DUENA = 'ajena.perfil@cuentamia.local';
const CORREO_PACIENTE = 'carla.perfil@cuentamia.local';
const CORREO_NUEVA = 'rosa.nueva@cuentamia.local';

const HASH =
  '$argon2id$v=19$m=19456,p=1,t=2$c2VtaWxsYWRlcHJ1ZWJh$BcVqHhiTZ4RrQZ4kYgVvxCuUAneDdfTxZ6qz6hUwcLY';
// El segundo hash, para comprobar que acuñar de verdad reemplaza el anterior.
const NUEVO_HASH =
  '$argon2id$v=19$m=19456,p=1,t=2$c2VndW5kYXNlbWlsbGE$BcVqHhiTZ4RrQZ4kYgVvxCuUAneDdfTxZ6qz6hUwcLY';
const ZONA = 'America/La_Paz';

// 00:00 del 1 de marzo en La Paz, y 22:00 del mismo día: en UTC caen en días distintos, y es
// exactamente lo que el `::date` tiene que resolver en la zona del despliegue.
const VINCULADA_EN = '2026-03-01T04:00:00.000Z';
const VINCULADA_EN_LA_NOCHE = '2026-03-02T02:00:00.000Z';

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 2 });

const repo = new AccountsRepository(app, ZONA);
const team = new TeamRepository(app);

const comoPaciente: AccountOwner = {
  accountId: PACIENTE,
  practiceId: null,
  accountRole: 'paciente',
  sessionId: SESION,
};
const comoDuena: AccountOwner = {
  accountId: DUENA,
  practiceId: CONSULTA,
  accountRole: 'practitioner',
  sessionId: SESION,
};

// El miembro que crea el alta, y que es quien el reenvío necesita: se rellenan ahí porque
// los dos identificadores los acuña la base.
let miembroCreado = '';
let cuentaDelMiembro = '';

async function sembrarConsulta(id: string, cuenta: string, correo: string, nombre: string) {
  await owner.query(
    `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit)
     values ($1, $2, 'latam', 'BO', $3, 'BOB', 'consultorio', 300)`,
    [id, nombre, ZONA],
  );
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name, phone)
     values ($1, $2, 'practitioner', 'latam', 'Andrea', 'Paz', '+59170000001')`,
    [cuenta, correo],
  );
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, set_at) values ($1, $2, false, now())`,
    [cuenta, HASH],
  );
  await owner.query(
    `insert into practitioner (practice_id, account_id, first_name, last_name, role)
     values ($1, $2, 'Andrea', 'Paz', 'doctora')`,
    [id, cuenta],
  );
  await owner.query('update practice set owner_account_id = $1 where id = $2', [cuenta, id]);
}

async function sembrarFicha(
  consulta: string,
  ficha: string,
  vinculo: string,
  nombreConsulta: string,
  creadoEn: string,
) {
  await owner.query(
    `insert into patient (id, practice_id, first_name, last_name, birth_date, email, how_arrived)
     values ($1, $2, 'Carla', 'Rojas', '1992-04-18', $3, 'instagram')`,
    [ficha, consulta, CORREO_PACIENTE],
  );
  await owner.query(
    `insert into patient_link (id, practice_id, patient_id, account_id, status, email,
                               practice_name, practitioner_name, created_at)
     values ($1, $2, $3, $4, 'vinculada', $5, $6, 'Dra. Paz Villarroel', $7)`,
    [vinculo, consulta, ficha, PACIENTE, CORREO_PACIENTE, nombreConsulta, creadoEn],
  );
}

async function limpiar(): Promise<void> {
  await owner.query('delete from practice where id = any($1::uuid[])', [[CONSULTA, OTRA_CONSULTA]]);
  await owner.query('delete from access_audit where practice_id = any($1::uuid[])', [
    [CONSULTA, OTRA_CONSULTA],
  ]);
  await owner.query(
    `delete from account where email = any($1::citext[])
        or email like 'borrada+%@medskin.invalid'`,
    [[CORREO_DUENA, CORREO_OTRA_DUENA, CORREO_PACIENTE, CORREO_NUEVA]],
  );
}

beforeAll(async () => {
  await limpiar();
  await sembrarConsulta(CONSULTA, DUENA, CORREO_DUENA, 'Clínica Paz');
  await sembrarConsulta(OTRA_CONSULTA, OTRA_DUENA, CORREO_OTRA_DUENA, 'Clínica Ajena');

  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name, phone)
     values ($1, $2, 'paciente', 'latam', 'Carla', 'Rojas', '+59171234567')`,
    [PACIENTE, CORREO_PACIENTE],
  );
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, temp_expires_at)
     values ($1, $2, true, now() + interval '72 hours')`,
    [PACIENTE, HASH],
  );
  await sembrarFicha(CONSULTA, FICHA, VINCULO, 'Clínica Paz', VINCULADA_EN);
  await sembrarFicha(OTRA_CONSULTA, FICHA_AJENA, VINCULO_AJENO, 'Clínica Ajena', VINCULADA_EN_LA_NOCHE);
}, 60_000);

afterAll(async () => {
  await limpiar();
  await Promise.all([owner.end(), app.end()]);
}, 60_000);

describe('GET /v1/cuentas/mia contra la base', () => {
  it('la paciente ve su cuenta y sus dos doctoras, con el día en la zona del despliegue', async () => {
    const perfil = await repo.readProfile({
      owner: comoPaciente,
      restricted: false,
      withLinks: true,
    });

    expect(perfil).toEqual({
      email: CORREO_PACIENTE,
      firstName: 'Carla',
      lastName: 'Rojas',
      phone: '+59171234567',
      status: 'activa',
      region: 'latam',
      passwordIsTemporary: true,
      doctoras: [
        {
          practiceId: CONSULTA,
          practiceName: 'Clínica Paz',
          practitionerName: 'Dra. Paz Villarroel',
          status: 'vinculada',
          // Las dos del mismo día en La Paz: la segunda se creó a las 22:00, que en UTC ya
          // es el día siguiente. Si el `::date` se hiciera en UTC, aquí diría `2026-03-02`.
          since: '2026-03-01',
        },
        {
          practiceId: OTRA_CONSULTA,
          practiceName: 'Clínica Ajena',
          practitionerName: 'Dra. Paz Villarroel',
          status: 'vinculada',
          since: '2026-03-01',
        },
      ],
    });
  });

  it('la sesión restringida lee lo mismo con `app_account`, que es lo único que alcanza', async () => {
    const perfil = await repo.readProfile({
      owner: comoPaciente,
      restricted: true,
      withLinks: true,
    });

    expect({
      correo: perfil?.email,
      temporal: perfil?.passwordIsTemporary,
      doctoras: perfil?.doctoras.length,
    }).toEqual({ correo: CORREO_PACIENTE, temporal: true, doctoras: 2 });
  });

  it('la doctora ve su cuenta, y no se le preguntan vínculos que no son suyos', async () => {
    const perfil = await repo.readProfile({
      owner: comoDuena,
      restricted: false,
      withLinks: false,
    });

    expect(perfil).toMatchObject({
      email: CORREO_DUENA,
      firstName: 'Andrea',
      status: 'activa',
      passwordIsTemporary: false,
      doctoras: [],
    });
  });
});

describe('POST /v1/equipo contra la base', () => {
  it('la dueña crea recepción, y el nombre de la consulta sale de la misma transacción', async () => {
    const creada = await team.create({
      owner: comoDuena,
      email: CORREO_NUEVA,
      firstName: 'Rosa',
      lastName: 'Mamani',
      role: 'recepcion',
      hash: HASH,
      expiresAt: new Date(Date.now() + 72 * 3600_000),
    });

    expect({
      verdict: creada.verdict,
      consulta: creada.practiceName,
      cuenta: creada.accountId !== null,
      miembro: creada.practitionerId !== null,
    }).toEqual({ verdict: 'created', consulta: 'Clínica Paz', cuenta: true, miembro: true });

    // Los dos identificadores del miembro recién creado: los usa el reenvío de abajo, que
    // es el endpoint que existe para esta persona exacta —la que quedó con cuenta y con una
    // temporal que el relé no entregó—.
    miembroCreado = creada.practitionerId ?? '';
    cuentaDelMiembro = creada.accountId ?? '';

    // La línea de la bitácora, con el rol y sin el correo ni la contraseña.
    const { rows } = await owner.query<{ action: string; data: { rol: string }; subject_id: string }>(
      `select action, data, subject_id from access_audit
        where practice_id = $1 and action = 'equipo.creado'`,
      [CONSULTA],
    );
    expect(rows[0]).toMatchObject({ action: 'equipo.creado', data: { rol: 'recepcion' } });
    expect(rows[0]?.subject_id).toBe(creada.accountId);
  });

  it('un correo que ya tiene cuenta en la región da un solo veredicto, sin decir de quién es', async () => {
    // El correo de la paciente de la OTRA consulta: la dueña no tiene por qué saber que
    // tiene cuenta, y el veredicto es el mismo que si ya estuviera en su equipo.
    const tomado = await team.create({
      owner: comoDuena,
      email: CORREO_PACIENTE,
      firstName: 'Carla',
      lastName: 'Rojas',
      role: 'asistente_clinico',
      hash: HASH,
      expiresAt: new Date(Date.now() + 72 * 3600_000),
    });

    expect(tomado).toEqual({
      verdict: 'email_taken',
      accountId: null,
      practitionerId: null,
      practiceName: null,
    });
  });
});

describe('POST /v1/equipo/{miembro_id}/acceso contra la base', () => {
  // Va después del alta a propósito: el miembro que este endpoint existe para rescatar es
  // justo el que acabó de crearse, con su temporal sin entregar.
  it('la dueña lee a su miembro, y a sí misma NO: ese 404 llega antes del contador', async () => {
    const miembro = await team.forDelivery(comoDuena, miembroCreado);
    expect(miembro).toEqual({
      accountId: cuentaDelMiembro,
      firstName: 'Rosa',
      practiceName: 'Clínica Paz',
    });

    // «Eres tú»: la dueña no se reenvía el acceso a sí misma —sería acuñarse credenciales
    // sin saber su contraseña actual—, y el `select` ya la excluye para que ese 404 no gaste
    // una de las tres por hora de nadie.
    const { rows: suya } = await owner.query<{ id: string }>(
      'select id from practitioner where account_id = $1 and practice_id = $2',
      [DUENA, CONSULTA],
    );
    expect(await team.forDelivery(comoDuena, suya[0]?.id ?? '')).toBeNull();

    // Y la fila de la OTRA consulta no existe para ella: lo pone la política, no un `where`.
    const { rows: ajena } = await owner.query<{ id: string }>(
      'select id from practitioner where practice_id = $1',
      [OTRA_CONSULTA],
    );
    expect(await team.forDelivery(comoDuena, ajena[0]?.id ?? '')).toBeNull();
  });

  it('acuña la temporal nueva, devuelve el correo que este rol no puede leer y deja su línea', async () => {
    const { rows: antes } = await owner.query<{ hash: string }>(
      'select hash from credential where account_id = $1',
      [cuentaDelMiembro],
    );

    const renovado = await team.resend({
      owner: comoDuena,
      practitionerId: miembroCreado,
      accountId: cuentaDelMiembro,
      hash: NUEVO_HASH,
      expiresAt: new Date(Date.now() + 72 * 3600_000),
    });

    // El correo es el único dato que `app_practitioner` no puede leer de `account`, y por
    // eso lo devuelve la función: sin él no hay mensaje que mandar.
    expect(renovado).toEqual({ outcome: 'acceso_renovado', email: CORREO_NUEVA });

    // La anterior murió de verdad.
    const { rows: despues } = await owner.query<{ hash: string; is_temporary: boolean }>(
      'select hash, is_temporary from credential where account_id = $1',
      [cuentaDelMiembro],
    );
    expect(despues[0]?.hash).toBe(NUEVO_HASH);
    expect(despues[0]?.hash).not.toBe(antes[0]?.hash);
    expect(despues[0]?.is_temporary).toBe(true);

    // La línea del acto: `acceso_pedido` —el envío pasa después de este COMMIT—, con quién
    // lo pidió, a quién, y SIN el correo y SIN la contraseña.
    const { rows: bitacora } = await owner.query<{
      actor_account_id: string;
      subject_id: string;
      data: { via: string; miembro_id: string };
    }>(
      `select actor_account_id, subject_id, data from access_audit
        where practice_id = $1 and action = 'cuenta.acceso_pedido'`,
      [CONSULTA],
    );
    expect(bitacora).toHaveLength(1);
    expect(bitacora[0]).toMatchObject({
      actor_account_id: DUENA,
      subject_id: cuentaDelMiembro,
      data: { via: 'correo', miembro_id: miembroCreado },
    });
    expect(JSON.stringify(bitacora[0]?.data)).not.toContain('@');
  });

  it('el propio miembro no puede reenviarse nada: no es la dueña', async () => {
    const comoMiembro: AccountOwner = {
      accountId: cuentaDelMiembro,
      practiceId: CONSULTA,
      accountRole: 'practitioner',
      sessionId: SESION,
    };
    const resultado = await team.resend({
      owner: comoMiembro,
      practitionerId: miembroCreado,
      accountId: cuentaDelMiembro,
      hash: NUEVO_HASH,
      expiresAt: new Date(Date.now() + 72 * 3600_000),
    });

    // Y el veredicto llega SIN correo: no se filtra el de nadie por un 403.
    expect(resultado).toEqual({ outcome: 'not_owner', email: null });
  });

  it('a quien ya eligió su contraseña no se le reenvía, y el veredicto tampoco trae correo', async () => {
    await owner.query(
      `update credential set is_temporary = false, temp_used_at = now(), set_at = now()
        where account_id = $1`,
      [cuentaDelMiembro],
    );

    const resultado = await team.resend({
      owner: comoDuena,
      practitionerId: miembroCreado,
      accountId: cuentaDelMiembro,
      hash: HASH,
      expiresAt: new Date(Date.now() + 72 * 3600_000),
    });
    expect(resultado).toEqual({ outcome: 'ya_eligio_su_contrasena', email: null });

    // Y la contraseña que ella eligió sigue siendo la suya: no se la tocó.
    const { rows } = await owner.query<{ hash: string }>(
      'select hash from credential where account_id = $1',
      [cuentaDelMiembro],
    );
    expect(rows[0]?.hash).toBe(NUEVO_HASH);
  });
});

describe('DELETE /v1/cuentas/mia contra la base', () => {
  // Va al final: el borrado se lleva la credencial y suelta los vínculos de la semilla.
  it('borra, suelta los dos vínculos y el segundo intento dice `already_deleted`', async () => {
    const primero = await repo.deleteMine({
      owner: comoPaciente,
      retentionUntil: '2033-10-27',
      reason: 'ya_no_la_uso',
    });
    expect(primero.verdict).toBe('deleted');
    expect(primero.deletedAt).not.toBeNull();

    const segundo = await repo.deleteMine({
      owner: comoPaciente,
      retentionUntil: '2033-10-27',
      reason: null,
    });
    expect({ verdict: segundo.verdict, fecha: segundo.deletedAt?.toISOString() }).toEqual({
      verdict: 'already_deleted',
      fecha: primero.deletedAt?.toISOString(),
    });
  });
});
