// Sembrador de DESARROLLO. No es código de producción y se niega a correr fuera de
// `development`: siembra contraseñas temporales conocidas y las imprime.
//
// Existe porque el acceso no se puede probar sin una consulta, una doctora y una paciente,
// y los endpoints que crean consultas (`POST /v1/platform/tenants`,
// `POST /v1/patients`) no son de este encargo. Así que llama a las funciones que ya
// existen —las mismas que llamarán esos endpoints— y no inventa filas a mano donde hay
// función.
//
// Lo único que escribe el DUEÑO del esquema es lo que ningún rol de aplicación puede
// escribir: el señuelo del acceso (que no tiene un solo grant, a propósito), la fila de
// `practice` con su licencia y la cuenta de plataforma que hace de operador.

import { randomBytes } from 'node:crypto';

import { Pool } from 'pg';

import { config } from '../config/config';
import { Argon2Passwords } from '../security/passwords';
import { withTenantContext } from './tenant-context';

const PRACTICE = 'dddddddd-0000-4000-8000-000000000001';
const LICENSE = 'dddddddd-0000-4000-8000-000000000002';
const OPERATOR = 'dddddddd-0000-4000-8000-000000000003';

const PRACTITIONER = { email: 'andrea.paz@medskin.local', firstName: 'Andrea', lastName: 'Paz' };
const PATIENT = {
  email: 'carla.rojas@medskin.local',
  firstName: 'Carla',
  lastName: 'Rojas',
  phone: '+59170000000',
};

/** Contraseñas de desarrollo. Pasan las reglas: 8 o más y no están en la lista de usadas. */
const TEMP_PRACTITIONER = 'tejado-lila-07';
const TEMP_PATIENT = 'ventana-turquesa-42';

async function seed(): Promise<void> {
  const cfg = config();
  if (cfg.NODE_ENV !== 'development') {
    throw new Error(
      `db:seed solo corre en development y NODE_ENV es «${cfg.NODE_ENV}»: siembra contraseñas conocidas y las imprime.`,
    );
  }

  const ownerUrl = process.env.DATABASE_URL_OWNER;
  if (!ownerUrl) {
    throw new Error('Falta DATABASE_URL_OWNER: la siembra la hace el dueño del esquema.');
  }

  const owner = new Pool({ connectionString: ownerUrl, max: 1 });
  const app = new Pool({ connectionString: cfg.DATABASE_URL, max: 2 });
  const passwords = new Argon2Passwords();

  try {
    // 0 · Borra lo suyo y solo lo suyo, para que `db:seed` se pueda volver a correr y las
    // contraseñas que imprime sigan siendo las que valen. `practice` arrastra su licencia
    // y su `practitioner`; `account` arrastra credencial y sesiones.
    await owner.query('delete from account where email = any($1::citext[])', [
      [PRACTITIONER.email, PATIENT.email, 'operador@medskin.local'],
    ]);
    await owner.query('delete from practice where id = $1', [PRACTICE]);

    // 1 · El señuelo. Un hash de Argon2id de una contraseña aleatoria que NO se guarda:
    // sin él `medskin_access_credential()` falla a propósito, porque sin «mismo tiempo» el
    // `401 acceso_no_coincide` miente. Se siembra con el MISMO coste que usa el proceso.
    const decoy = await passwords.hash(randomBytes(32).toString('base64url'));
    await owner.query(
      `insert into access_decoy (only_row, hash) values (true, $1)
       on conflict (only_row) do update set hash = excluded.hash, updated_at = now()`,
      [decoy],
    );

    // 2 · La consulta, su licencia sin enviar y el operador de plataforma que hace de
    // contexto para la función del alta. Esto lo escribe la consola en producción.
    await owner.query(
      `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit)
       values ($1, 'Clínica Paz', $2, 'BO', $3, 'BOB', 'consultorio', 300)
       on conflict (id) do nothing`,
      [PRACTICE, cfg.REGION, cfg.ZONA_HORARIA],
    );
    await owner.query(
      `insert into license (id, practice_id, status) values ($1, $2, 'sin_enviar')
       on conflict (id) do nothing`,
      [LICENSE, PRACTICE],
    );
    await owner.query(
      `insert into account (id, email, role, region, first_name, last_name)
       values ($1, 'operador@medskin.local', 'doctor', $2, 'Operador', 'Plataforma')
       on conflict (id) do nothing`,
      [OPERATOR, cfg.REGION],
    );

    const in72h = new Date(Date.now() + 71 * 60 * 60 * 1000);

    // 3 · La dueña, por la función de la consola.
    const ownerRow = await withTenantContext(
      app,
      { role: 'app_platform', accountId: OPERATOR },
      async (c) => {
        const { rows } = await c.query<{ verdict: string; account_id: string | null }>(
          'select * from medskin_create_practice_owner($1, $2, $3, $4, $5, $6)',
          [
            PRACTICE,
            PRACTITIONER.email,
            PRACTITIONER.firstName,
            PRACTITIONER.lastName,
            await passwords.hash(TEMP_PRACTITIONER),
            in72h,
          ],
        );
        return rows[0];
      },
    );
    if (ownerRow === undefined) {
      throw new Error('medskin_create_practice_owner no devolvió veredicto');
    }

    const practitionerAccount = ownerRow.account_id;
    if (practitionerAccount === null) throw new Error(`la dueña no se creó: ${ownerRow.verdict}`);

    // 4 · La paciente, por la función del alta de la doctora. No recibe `account_id`: solo
    // puede crear una cuenta nueva con el correo que la doctora escribió.
    const patientRow = await withTenantContext(
      app,
      { role: 'app_practitioner', accountId: practitionerAccount, practiceId: PRACTICE },
      async (c) => {
        const { rows } = await c.query<{ account_id: string; already_existed: boolean }>(
          'select * from medskin_create_patient_account($1, $2, $3, $4, $5, $6)',
          [
            PATIENT.email,
            PATIENT.firstName,
            PATIENT.lastName,
            PATIENT.phone,
            await passwords.hash(TEMP_PATIENT),
            in72h,
          ],
        );
        return rows[0];
      },
    );

    const patientAccount = patientRow?.account_id;
    if (patientAccount === undefined) throw new Error('medskin_create_patient_account no devolvió cuenta');

    // 5 · Su FICHA y su VÍNCULO, con el rol de la doctora y bajo sus políticas, que es
    // exactamente lo que hace `POST /v1/patients`: la cuenta la crea la función, la ficha
    // y el vínculo los escribe ella. Sin el vínculo no se puede ejercitar
    // `POST /v1/accounts/{account_id}/access`, cuya autorización ES esa fila.
    //
    // `patient_link` copia el nombre de la consulta, el de la doctora y la ciudad (la
    // pregunta 7): la paciente no tiene política en `practice` ni en `practitioner`.
    // `medical_history` nace con todo en nulo —«puedes atenderla hoy y llenar esto
    // después»—, y nulo no es `false`: es «nadie preguntó todavía».
    const ficha = await withTenantContext(
      app,
      { role: 'app_practitioner', accountId: practitionerAccount, practiceId: PRACTICE },
      async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `insert into patient (practice_id, first_name, last_name, birth_date, email, phone,
                                has_whatsapp, reminders_via, how_arrived)
           values ($1, $2, $3, '1992-04-18', $4, $5, true, 'ambas', 'instagram')
           returning id`,
          [PRACTICE, PATIENT.firstName, PATIENT.lastName, PATIENT.email, PATIENT.phone],
        );
        const patient = rows[0]?.id;
        if (patient === undefined) throw new Error('la ficha de la paciente no se creó');

        await c.query(
          `insert into patient_link (practice_id, patient_id, account_id, status, email,
                                     access_sent_at, practice_name, practitioner_name, city)
           select $1, $2, $3, 'invitada', $4, now(), p.name,
                  $5 || ' ' || $6, p.city
             from practice p where p.id = $1`,
          [
            PRACTICE,
            patient,
            patientAccount,
            PATIENT.email,
            PRACTITIONER.firstName,
            PRACTITIONER.lastName,
          ],
        );
        await c.query('insert into medical_history (practice_id, patient_id) values ($1, $2)', [
          PRACTICE,
          patient,
        ]);
        return patient;
      },
    );

    process.stdout.write(
      [
        'sembrado para desarrollo:',
        `  consulta   ${PRACTICE} · Clínica Paz · licencia sin_enviar`,
        `  doctora    ${PRACTITIONER.email} / ${TEMP_PRACTITIONER}  (temporal, 72 h) · ${ownerRow.verdict}`,
        `  paciente   ${PATIENT.email} / ${TEMP_PATIENT}  (temporal, 72 h) · ${
          patientRow?.already_existed ? 'ya existía' : 'creada'
        }`,
        `  ficha      ${ficha} · vínculo invitada, antecedentes en blanco (nulo, que no es «no»)`,
        '  las dos entran con siguiente_paso = contrasena_nueva y alcance restringido.',
        `  reenvío    POST /v1/accounts/${patientAccount}/acceso ya se puede ejercitar.`,
        '',
      ].join('\n'),
    );
  } finally {
    await Promise.allSettled([owner.end(), app.end()]);
  }
}

void seed().catch((failure: unknown) => {
  process.stderr.write(`${failure instanceof Error ? failure.message : String(failure)}\n`);
  process.exitCode = 1;
});
