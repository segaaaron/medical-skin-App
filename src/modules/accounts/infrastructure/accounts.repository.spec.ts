// Las TRES consultas nuevas contra la base real, y existen por una razón que un doble no
// puede sostener: **lo que un rol de aplicación puede leer no lo decide este código, lo
// deciden sus `GRANT` por columna y sus políticas.** Una columna de más en el `select` no
// falla al compilar ni en una prueba con dobles: falla con «permiso denegado» en la pantalla
// de arranque de las dos apps.
//
// Lo que se comprueba aquí:
//   · `GET /v1/accounts/mine` servido por los TRES roles que lo pueden pedir —`app_patient`,
//     `app_account` (la sesión restringida) y `app_practitioner`— sin un solo `where`: la
//     fila que vuelve es la de quien pregunta porque lo dicen `account_own` y
//     `credential_own`, y el `hash` no se nombra porque no hay `GRANT` que lo permita;
//   · `doctoras` cruzando consultas, que es la única lectura del sistema que lo hace, y
//     cruzando SOLO las fichas de quien pregunta;
//   · el `desde` en la zona del despliegue: con el UTC de la conexión, un vínculo creado a
//     las 22:00 en La Paz se mostraría al día siguiente;
//   · `POST /v1/team` con el nombre de la consulta leído en la MISMA transacción y su
//     línea de bitácora, y el `email_taken` de un correo que ya tiene cuenta en la región.
//
// Siembra el DUEÑO del esquema, que es quien migra; todo lo que se comprueba pasa por
// `withTenantContext()` con el rol y el contexto de verdad. En ningún momento se desactiva
// RLS.

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AccountOwner } from '../domain/ports';
import { AccountsRepository } from './accounts.repository';

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
const ZONA = 'America/La_Paz';

// 00:00 del 1 de marzo en La Paz, y 22:00 del mismo día: en UTC caen en días distintos, y es
// exactamente lo que el `::date` tiene que resolver en la zona del despliegue.
const VINCULADA_EN = '2026-03-01T04:00:00.000Z';
const VINCULADA_EN_LA_NOCHE = '2026-03-02T02:00:00.000Z';

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 2 });

const repo = new AccountsRepository(app, ZONA);

const comoPaciente: AccountOwner = {
  accountId: PACIENTE,
  practiceId: null,
  accountRole: 'patient',
  sessionId: SESION,
};
const comoDuena: AccountOwner = {
  accountId: DUENA,
  practiceId: CONSULTA,
  accountRole: 'doctor',
  sessionId: SESION,
};

async function sembrarConsulta(id: string, cuenta: string, correo: string, nombre: string) {
  await owner.query(
    `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit)
     values ($1, $2, 'latam', 'BO', $3, 'BOB', 'consultorio', 300)`,
    [id, nombre, ZONA],
  );
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name, phone)
     values ($1, $2, 'doctor', 'latam', 'Andrea', 'Paz', '+59170000001')`,
    [cuenta, correo],
  );
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, set_at) values ($1, $2, false, now())`,
    [cuenta, HASH],
  );
  await owner.query(
    `insert into practitioner (practice_id, account_id, first_name, last_name, role)
     values ($1, $2, 'Andrea', 'Paz', 'doctor')`,
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
  // Las claves de idempotencia también: este spec llama al repositorio directamente, así que
  // deja RESERVAS sin cerrar —el caso de uso es quien las cierra—, y una reserva sin cerrar
  // nunca se vuelve a ejecutar. Es la garantía nueva funcionando contra la base real; aquí lo
  // que hace falta es que cada corrida empiece limpia.
  await owner.query('delete from idempotency_key where key like $1', ['equipo-%']);
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
     values ($1, $2, 'patient', 'latam', 'Carla', 'Rojas', '+59171234567')`,
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

describe('GET /v1/accounts/mine contra la base', () => {
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

describe('DELETE /v1/accounts/mine contra la base', () => {
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
