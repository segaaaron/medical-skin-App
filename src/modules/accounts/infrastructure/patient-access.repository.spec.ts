// `POST /v1/cuentas/{cuenta_id}/acceso` CONTRA LA BASE REAL, y existe por un invariante que
// un doble no puede sostener:
//
//   **`patient_link.access_sent_at` solo puede afirmar un envío que ocurrió.**
//
// `medskin_resend_patient_access()` escribe la marca AL ACUÑAR (`0006`) y el envío pasa
// después, así que con el relé caído la base decía «ya se le mandó» siendo falso, y es la
// columna que la consola lee para decidir si hay que reenviar. El endpoint la deja en nulo
// otra vez en la misma llamada, y lo que se comprueba aquí es la FILA, no un doble.
//
// Siembra el dueño del esquema, que es quien migra; todo lo que se comprueba del endpoint
// pasa por `withTenantContext()` con el rol y el inquilino de verdad. En ningún momento se
// desactiva RLS.

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import { Argon2Passwords } from '../../../shared/security/passwords';
import type { Caller } from '../../access/application/caller';
import {
  PERMISSION,
  SendPatientAccess,
  type DeliveryClock,
} from '../application/send-patient-access';
import type { PatientAccessMailPort, ResendLimitPort } from '../domain/ports';
import { PatientAccessRepository } from './patient-access.repository';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl =
  process.env.DATABASE_URL_POOLER ??
  process.env.DATABASE_URL ??
  'postgresql://medskin:dev_local_only@localhost:5433/medskin';

// Espacio de identificadores propio: esta prueba no comparte semilla con ninguna otra.
// `aaaaaaaa`, `bbbbbbbb`, `cccccccc`, `dddddddd`, `eeeeeeee` y `ffffffff` ya están tomados
// por la semilla y por las otras tres pruebas de base; dos semillas con el mismo uuid se
// pisan y el fallo sale en el `beforeAll` de quien llegue segundo.
const CONSULTA = '9cc09cc0-0000-4000-8000-000000000001';
// Una consulta que no existe, para el caso del otro inquilino.
const OTRA_CONSULTA = '9cc09cc0-0000-4000-8000-000000000002';
const DOCTORA_CUENTA = '9cc09cc0-0000-4000-8000-000000000003';
const PACIENTE_CUENTA = '9cc09cc0-0000-4000-8000-000000000004';
const FICHA = '9cc09cc0-0000-4000-8000-000000000005';
const VINCULO = '9cc09cc0-0000-4000-8000-000000000006';
const SESION = '9cc09cc0-0000-4000-8000-000000000007';
const CORREO_DOCTORA = 'andrea.marca@reenvio.local';
const CORREO_PACIENTE = 'rocio.marca@reenvio.local';

const HASH = '$argon2id$v=19$m=19456,p=1,t=2$c2VtaWxsYWRlcHJ1ZWJh$BcVqHhiTZ4RrQZ4kYgVvxCuUAneDdfTxZ6qz6hUwcLY';

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 2 });

const DOCTORA: Caller = {
  accountId: DOCTORA_CUENTA,
  sessionId: SESION,
  role: 'doctora',
  accountRole: 'practitioner',
  scope: 'completo',
  region: 'latam',
  practiceId: CONSULTA,
  permissions: [PERMISSION],
};

const RELOJ: DeliveryClock = {
  now: () => new Date(),
  localTime: () => '18:24',
  localLongWhen: () => 'jueves 30 a las 18:24',
};

const SIN_LIMITE: ResendLimitPort = { count: () => Promise.resolve({ tooMany: false }) };

function caso(mail: PatientAccessMailPort): SendPatientAccess {
  return new SendPatientAccess(
    new PatientAccessRepository(app),
    new Argon2Passwords(),
    SIN_LIMITE,
    RELOJ,
    mail,
  );
}

const CORREO_QUE_SALE: PatientAccessMailPort = { sendAccess: () => Promise.resolve() };
const CORREO_CAIDO: PatientAccessMailPort = {
  sendAccess: () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:1025')),
};

/** La fecha de un envío que ocurrió de verdad hace meses. */
const DIA_1 = new Date('2026-08-03T22:24:00.000Z');

async function ponerMarca(valor: Date | null): Promise<void> {
  await owner.query('update patient_link set access_sent_at = $2 where id = $1', [VINCULO, valor]);
}

async function marcaDeEnvio(): Promise<Date | null> {
  const { rows } = await owner.query<{ access_sent_at: Date | null }>(
    'select access_sent_at from patient_link where id = $1',
    [VINCULO],
  );
  return rows[0]?.access_sent_at ?? null;
}

async function limpiar(): Promise<void> {
  await owner.query('delete from practice where id = $1', [CONSULTA]);
  await owner.query('delete from account where email = any($1::citext[])', [
    [CORREO_DOCTORA, CORREO_PACIENTE],
  ]);
  await owner.query('delete from access_audit where practice_id = $1', [CONSULTA]);
}

beforeAll(async () => {
  await limpiar();
  await owner.query(
    `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit)
     values ($1, 'Consulta de la marca de envío', 'latam', 'BO', 'America/La_Paz', 'BOB',
             'consultorio', 300)`,
    [CONSULTA],
  );
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'practitioner', 'latam', 'Andrea', 'Paz')`,
    [DOCTORA_CUENTA, CORREO_DOCTORA],
  );
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, set_at)
     values ($1, $2, false, now())`,
    [DOCTORA_CUENTA, HASH],
  );
  await owner.query(
    `insert into practitioner (practice_id, account_id, first_name, last_name, role)
     values ($1, $2, 'Andrea', 'Paz', 'doctora')`,
    [CONSULTA, DOCTORA_CUENTA],
  );
  await owner.query('update practice set owner_account_id = $1 where id = $2', [
    DOCTORA_CUENTA,
    CONSULTA,
  ]);
  // La paciente: su temporal SIN estrenar, que es el caso que el reenvío atiende.
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'paciente', 'latam', 'Rocio', 'Vargas')`,
    [PACIENTE_CUENTA, CORREO_PACIENTE],
  );
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, temp_expires_at)
     values ($1, $2, true, now() + interval '72 hours')`,
    [PACIENTE_CUENTA, HASH],
  );
  await owner.query(
    `insert into patient (id, practice_id, first_name, last_name, birth_date, email, phone,
                          how_arrived)
     values ($1, $2, 'Rocio', 'Vargas', '1990-02-02', $3, '+59177124409', 'instagram')`,
    [FICHA, CONSULTA, CORREO_PACIENTE],
  );
  await owner.query(
    `insert into patient_link (id, practice_id, patient_id, account_id, email, practice_name,
                               practitioner_name, city)
     values ($1, $2, $3, $4, $5, 'Consulta de la marca', 'Dra. Andrea Paz', 'Santa Cruz')`,
    [VINCULO, CONSULTA, FICHA, PACIENTE_CUENTA, CORREO_PACIENTE],
  );
});

afterAll(async () => {
  await limpiar();
  await app.end();
  await owner.end();
});

describe('`access_sent_at` solo afirma un envío que ocurrió', () => {
  it('el envío que SÍ sale deja la marca puesta', async () => {
    await ponerMarca(null);
    const bloque = await caso(CORREO_QUE_SALE).run({ via: 'correo' }, PACIENTE_CUENTA, DOCTORA);

    expect(bloque.enviado).toBe(true);
    expect(bloque.contrasena_temporal).toBeNull();
    expect(await marcaDeEnvio()).toBeInstanceOf(Date);
  });

  it('la PRIMERA VEZ que falla, la marca vuelve a nulo: nulo es lo que había', async () => {
    await ponerMarca(null);

    const fallo = await caso(CORREO_CAIDO)
      .run({ via: 'correo' }, PACIENTE_CUENTA, DOCTORA)
      .catch((e: unknown) => e);

    expect(fallo).toBeInstanceOf(ContractError);
    expect((fallo as ContractError).code).toBe('fallo_de_servicio');
    // Si la compensación no corriera, la base diría «ya se le mandó» siendo falso y la
    // consola no ofrecería reenviar.
    expect(await marcaDeEnvio()).toBeNull();
  });

  it('con un envío del día 1, el reenvío que falla devuelve ESA fecha y no nulo', async () => {
    // El caso que poner nulo rompía: el correo salió el día 1 y el reenvío del día 5 falla.
    // Borrar la fecha haría que la consola leyera «nunca se le mandó» de una paciente que
    // sí lo recibió, que es el mismo defecto de B1 en la otra dirección. Compensar es
    // deshacer lo que esta llamada escribió, no borrar la historia.
    await ponerMarca(DIA_1);

    const fallo = await caso(CORREO_CAIDO)
      .run({ via: 'correo' }, PACIENTE_CUENTA, DOCTORA)
      .catch((e: unknown) => e);

    expect((fallo as ContractError).code).toBe('fallo_de_servicio');
    expect((await marcaDeEnvio())?.toISOString()).toBe(DIA_1.toISOString());
  });

  it('el intento no se pierde: queda en `access_audit`, que es donde va un intento', async () => {
    const { rows } = await owner.query<{ total: string }>(
      `select count(*)::text as total from access_audit
        where practice_id = $1 and action = 'cuenta.acceso_pedido' and subject_id = $2`,
      [CONSULTA, PACIENTE_CUENTA],
    );

    // Tres: el que salió y los dos que no. La bitácora guarda el acto de la doctora; la
    // columna guarda el hecho del envío, y son dos cosas distintas. De ahí el nombre:
    // `acceso_pedido` es verdad en los tres casos y `acceso_enviado` lo era en uno, y esta
    // tabla no se puede corregir después —nadie tiene `UPDATE` ni `DELETE` sobre ella—.
    expect(rows[0]?.total).toBe('3');

    // Y no queda ni una con el nombre viejo, que afirmaba un envío que no ocurrió.
    const { rows: viejas } = await owner.query<{ total: string }>(
      `select count(*)::text as total from access_audit
        where practice_id = $1 and action = 'cuenta.acceso_enviado'`,
      [CONSULTA],
    );
    expect(viejas[0]?.total).toBe('0');
  });

  it('y la temporal se renovó de verdad: el hash de la base ya no es el sembrado', async () => {
    const { rows } = await owner.query<{ hash: string; temp_first_used_at: Date | null }>(
      'select hash, temp_first_used_at from credential where account_id = $1',
      [PACIENTE_CUENTA],
    );

    expect(rows[0]?.hash).not.toBe(HASH);
    expect(rows[0]?.hash.startsWith('$argon2id$')).toBe(true);
    expect(rows[0]?.temp_first_used_at).toBeNull();
  });

  it('una cuenta de OTRA consulta no tiene vínculo aquí: 404 y no se acuña nada', async () => {
    // Se parte de la marca en nulo a propósito, para que este caso no dependa del
    // anterior: lo que prueba es que un 404 no escribe nada.
    await ponerMarca(null);
    const otroInquilino: Caller = { ...DOCTORA, practiceId: OTRA_CONSULTA };
    const fallo = await caso(CORREO_QUE_SALE)
      .run({ via: 'correo' }, PACIENTE_CUENTA, otroInquilino)
      .catch((e: unknown) => e);

    expect((fallo as ContractError).code).toBe('paciente_no_existe');
    // Y la marca de la paciente de verdad sigue sin tocarse.
    expect(await marcaDeEnvio()).toBeNull();
  });
});
