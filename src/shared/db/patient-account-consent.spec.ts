// La prueba de la 0021: el alta de pacientes no convierte la cuenta de una practicante en
// la paciente de nadie, y sigue reusando la de una paciente, que es la decisión escrita del
// contrato (§12.2.1).
//
// Mismas reglas que sus hermanas: contra la base real en Docker, sin un solo doble, RLS
// nunca se desactiva, siembra el DUEÑO del esquema y todo lo que se COMPRUEBA pasa por los
// roles de aplicación y por `withTenantContext()`.

import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantContext, type TenantContext } from './tenant-context';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ?? 'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

const HASH = '$argon2id$v=19$m=65536,p=4,t=3$c2VtaWxsYWRlcHJ1ZWJh$BcVqHhiTZ4RrQZ4kYgVvxCuUAneDdfTxZ6qz6hUwcLY';

const A = {
  practice: '2c2c2c2c-0000-4000-8000-00000000000a',
  doctor: '2c2c2c2c-0000-4000-8000-00000000001a',
  practitioner: '2c2c2c2c-0000-4000-8000-00000000002a',
  email: 'duena.a@consentimiento.local',
};
const B = {
  practice: '2c2c2c2c-0000-4000-8000-00000000000b',
  doctor: '2c2c2c2c-0000-4000-8000-00000000001b',
  practitioner: '2c2c2c2c-0000-4000-8000-00000000002b',
  email: 'duena.b@consentimiento.local',
  // La paciente de la consulta B: su cuenta SÍ se reusa cuando la doctora de A la da de
  // alta, y eso es lo que no se puede romper.
  patientAccount: '2c2c2c2c-0000-4000-8000-00000000003b',
  patientEmail: 'paciente.b@consentimiento.local',
};
const NEW_EMAIL = 'nueva@consentimiento.local';

const ctxDoctorA: TenantContext = { role: 'app_practitioner', practiceId: A.practice, accountId: A.doctor };

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 1 });

async function read<T extends QueryResultRow>(ctx: TenantContext, sql: string, params: unknown[] = []): Promise<T[]> {
  return withTenantContext(app, ctx, async (client: PoolClient) => (await client.query<T>(sql, params)).rows);
}

type Verdict = { verdict: string; account_id: string | null; already_existed: boolean | null; status: string | null };

/** El alta tal como la llama el endpoint: los seis argumentos, en su orden. */
const createFor = (email: string) =>
  read<Verdict>(
    ctxDoctorA,
    `select verdict, account_id, already_existed, status
       from medskin_create_patient_account($1::citext, 'Rocio', 'Vargas', null, $2,
                                           now() + interval '72 hours')`,
    [email, HASH],
  );

/** Lo que el dueño del esquema mira para comprobar que NO se escribió nada. */
async function countsOf(email: string) {
  const { rows } = await owner.query<{ accounts: string; credentials: string }>(
    `select (select count(*) from account a where a.email = $1::citext) as accounts,
            (select count(*) from credential c join account a on a.id = c.account_id
              where a.email = $1::citext) as credentials`,
    [email],
  );
  return { accounts: Number(rows[0]?.accounts), credentials: Number(rows[0]?.credentials) };
}

async function fichasOf(practice: string) {
  const { rows } = await owner.query<{ patients: string; links: string; histories: string }>(
    `select (select count(*) from patient where practice_id = $1) as patients,
            (select count(*) from patient_link where practice_id = $1) as links,
            (select count(*) from medical_history where practice_id = $1) as histories`,
    [practice],
  );
  return {
    patients: Number(rows[0]?.patients),
    links: Number(rows[0]?.links),
    histories: Number(rows[0]?.histories),
  };
}

async function clean() {
  await owner.query('delete from practice where id = any($1::uuid[])', [[A.practice, B.practice]]);
  await owner.query(`delete from account where email like '%@consentimiento.local'`);
}

beforeAll(async () => {
  await clean();
  const practiceWithOwner = async (t: { practice: string; doctor: string; practitioner: string; email: string }) => {
    await owner.query(
      `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit)
       values ($1, 'Clínica Consentimiento', 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300)`,
      [t.practice],
    );
    await owner.query(
      `insert into account (id, email, role, region, first_name, last_name)
       values ($1, $2, 'doctor', 'latam', 'Andrea', 'Paz')`,
      [t.doctor, t.email],
    );
    await owner.query(
      `insert into credential (account_id, hash, is_temporary, set_at) values ($1, $2, false, now())`,
      [t.doctor, HASH],
    );
    await owner.query(
      `insert into practitioner (id, practice_id, account_id, first_name, last_name, role)
       values ($1, $2, $3, 'Andrea', 'Paz', 'doctor')`,
      [t.practitioner, t.practice, t.doctor],
    );
    await owner.query('update practice set owner_account_id = $1 where id = $2', [t.doctor, t.practice]);
  };
  await practiceWithOwner(A);
  await practiceWithOwner(B);

  // La paciente de B, con su cuenta y su credencial ya elegida.
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'patient', 'latam', 'Carla', 'Rojas')`,
    [B.patientAccount, B.patientEmail],
  );
  await owner.query(`insert into credential (account_id, hash, is_temporary, set_at) values ($1, $2, false, now())`, [
    B.patientAccount,
    HASH,
  ]);
});

afterAll(async () => {
  await clean();
  await owner.end();
  await app.end();
});

describe('el alta de pacientes · ninguna cuenta de practicante se convierte en paciente (0021)', () => {
  it('el correo de una doctora de otra consulta da `email_unavailable` y no escribe nada', async () => {
    const before = await countsOf(B.email);
    const fichasBefore = await fichasOf(A.practice);

    expect(await createFor(B.email)).toEqual([
      // Y no dice por qué: si dijera «es de una practicante», el alta sería una sonda para
      // averiguar qué correos son de personal, de uno en uno.
      { verdict: 'email_unavailable', account_id: null, already_existed: null, status: null },
    ]);

    // Ni cuenta nueva, ni credencial nueva sobre la suya: su cuenta de trabajo queda como
    // estaba.
    expect(await countsOf(B.email)).toEqual(before);
    // Y ni ficha, ni vínculo, ni antecedentes: la función no devuelve `account_id`, así que
    // el endpoint no tiene a qué colgarlos.
    expect(await fichasOf(A.practice)).toEqual(fichasBefore);
    expect(fichasBefore).toEqual({ patients: 0, links: 0, histories: 0 });
  });

  it('tampoco con el correo de la propia doctora que escribe el alta', async () => {
    // El caso más fácil de escribir por error: darse de alta a sí misma como paciente.
    expect((await createFor(A.email))[0]?.verdict).toBe('email_unavailable');
    expect(await fichasOf(A.practice)).toEqual({ patients: 0, links: 0, histories: 0 });
  });

  it('la cuenta de una paciente de otra consulta SÍ se reusa, que es lo que no se puede romper', async () => {
    // §12.2.1: una paciente de dos doctoras tiene UNA cuenta y DOS fichas que no comparten
    // nada. Si esto se rompiera, el modelo entero se cae.
    expect(await createFor(B.patientEmail)).toEqual([
      { verdict: 'ya_tiene_cuenta', account_id: B.patientAccount, already_existed: true, status: 'activa' },
    ]);
    // Y no se le acuñó una segunda credencial ni una segunda cuenta.
    expect(await countsOf(B.patientEmail)).toEqual({ accounts: 1, credentials: 1 });
  });

  it('un correo que no existe crea su cuenta con la temporal, como siempre', async () => {
    const [created] = await createFor(NEW_EMAIL);
    expect({ verdict: created?.verdict, existed: created?.already_existed, status: created?.status }).toEqual({
      verdict: 'created',
      existed: false,
      status: 'activa',
    });
    expect(created?.account_id).not.toBeNull();

    const { rows } = await owner.query<{ role: string; is_temporary: boolean }>(
      `select a.role, c.is_temporary from account a join credential c on c.account_id = a.id
        where a.email = $1::citext`,
      [NEW_EMAIL],
    );
    expect(rows[0]).toEqual({ role: 'patient', is_temporary: true });
  });
});
