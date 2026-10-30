// `POST /v1/patients` CONTRA LA BASE REAL, porque hay cuatro cosas que un doble no puede
// sostener:
//
//   1. **El alta de la consulta A no existe para la consulta B.** Es el único endpoint del
//      tramo que escribe en tres tablas de consulta a la vez (`patient`, `patient_link`,
//      `medical_history`), y lo que las acota son sus políticas, no un `where` del código.
//   2. **La función del alta no recibe `account_id`**: si el correo ya tiene cuenta la REUSA
//      y no acuña nada, así que `credential` se queda intacta —incluido
//      `temp_first_used_at`, que es un hecho del pasado y no se des-ocurre (0017)—.
//   3. **Cada campo de los antecedentes guarda quién lo escribió**, y lo que nadie contestó
//      se queda en nulo y sin fuente: `null` no es `false`.
//   4. **`access_sent_at` solo afirma un envío que ocurrió**: nace puesto cuando la vía es
//      el correo y vuelve a nulo si el relé falla.
//
// Siembra el dueño del esquema, que es quien migra; todo lo que se comprueba del endpoint
// pasa por `withTenantContext()` con el rol y la consulta de verdad. En ningún momento se
// desactiva RLS.

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import {
  fingerprintOf,
  type IdempotencyRecord,
} from '../../../shared/idempotency/idempotency-key';
import { withTenantContext } from '../../../shared/db/tenant-context';
import { Argon2Passwords } from '../../../shared/security/passwords';
import type { Caller } from '../../access/application/caller';
import { RegisterPatient, type RegistrationClock } from '../application/register-patient';
import { PATIENT_CREATE_PERMISSION } from '../domain/patient-registration';
import type {
  PatientAccessMailPort,
  PatientCreationLimitPort,
  PatientLinkNoticeMailPort,
} from '../domain/ports';
import { PatientsRepository } from './patients.repository';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl =
  process.env.DATABASE_URL_POOLER ??
  process.env.DATABASE_URL ??
  'postgresql://medskin:dev_local_only@localhost:5433/medskin';

// Espacio de identificadores propio: esta prueba no comparte semilla con ninguna otra.
const CONSULTA = '7a1a7a1a-0000-4000-8000-000000000001';
const OTRA_CONSULTA = '7a1a7a1a-0000-4000-8000-000000000002';
const DOCTORA_CUENTA = '7a1a7a1a-0000-4000-8000-000000000003';
const OTRA_DOCTORA_CUENTA = '7a1a7a1a-0000-4000-8000-000000000004';
const LICENCIA = '7a1a7a1a-0000-4000-8000-000000000005';
const OTRA_LICENCIA = '7a1a7a1a-0000-4000-8000-000000000006';
const SESION = '7a1a7a1a-0000-4000-8000-000000000007';
const YA_TIENE_CUENTA = '7a1a7a1a-0000-4000-8000-000000000008';

const CORREO_DOCTORA = 'andrea.alta@altas.local';
const CORREO_OTRA_DOCTORA = 'carla.alta@altas.local';
const CORREO_PACIENTE = 'Valeria.Antelo@altas.local';
const CORREO_YA_TIENE = 'rocio.yatiene@altas.local';

const HASH =
  '$argon2id$v=19$m=19456,p=1,t=2$c2VtaWxsYWRlcHJ1ZWJh$BcVqHhiTZ4RrQZ4kYgVvxCuUAneDdfTxZ6qz6hUwcLY';

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
  permissions: [PATIENT_CREATE_PERMISSION],
};

/** La doctora de la OTRA consulta, con su propio consulta en el token. */
const OTRA_DOCTORA: Caller = {
  ...DOCTORA,
  accountId: OTRA_DOCTORA_CUENTA,
  practiceId: OTRA_CONSULTA,
};

const RELOJ: RegistrationClock = {
  now: () => new Date(),
  localTime: () => '18:24',
  localLongWhen: () => 'sábado 31 a las 18:24',
  localDay: () => '3 de agosto',
};

const SIN_LIMITE: PatientCreationLimitPort = { count: () => Promise.resolve({ tooMany: false }) };
type Correo = PatientAccessMailPort & PatientLinkNoticeMailPort;

const CORREO_QUE_SALE: Correo = {
  sendAccess: () => Promise.resolve(),
  sendLinkNotice: () => Promise.resolve(),
};
const CORREO_CAIDO: Correo = {
  sendAccess: () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:1025')),
  sendLinkNotice: () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:1025')),
};

/**
 * El caso de uso con el repositorio de verdad. El MISMO repositorio cierra la clave de
 * idempotencia: es quien tiene el contexto de consulta, y el puerto es aparte porque cerrar
 * una clave no es parte del alta.
 */
function caso(mail: Correo = CORREO_QUE_SALE): RegisterPatient {
  const repo = new PatientsRepository(app);
  return new RegisterPatient(repo, new Argon2Passwords(), SIN_LIMITE, repo, RELOJ, mail);
}

/**
 * Una clave por llamada, distinta: la misma dos veces es una repetición a propósito, y eso
 * tiene su propio caso al final. `fingerprintOf` es la huella de verdad del cuerpo, para que
 * la misma clave con otro cuerpo dé el `409` que el contrato promete.
 */
let clavesDadas = 0;
function clave(body: unknown): IdempotencyRecord {
  clavesDadas += 1;
  return { key: `alta-${clavesDadas}`, bodyHash: fingerprintOf(body) };
}

const CUERPO = {
  nombre: 'Valeria',
  apellido: 'Antelo',
  nacimiento: '1992-04-18',
  correo: CORREO_PACIENTE,
  celular: '+59177124408',
  tiene_whatsapp: true,
  recordatorios_por: 'ambas',
  como_llego: 'instagram',
  enviar_acceso_por: 'whatsapp',
  antes_de_atenderla: {
    alergias: { tiene: true, cuales: ['lidocaína'] },
    medicacion: { toma: false },
    fototipo: 3,
    notas: 'Pide empezar por la zona periocular.',
  },
};

async function licencia(status: string): Promise<void> {
  await owner.query('update license set status = $2 where id = $1', [LICENCIA, status]);
}

async function limpiarFichas(): Promise<void> {
  await owner.query('delete from idempotency_key where key like $1', ['alta-%']);
  await owner.query('delete from patient where practice_id = any($1::uuid[])', [
    [CONSULTA, OTRA_CONSULTA],
  ]);
  await owner.query('delete from access_audit where practice_id = any($1::uuid[])', [
    [CONSULTA, OTRA_CONSULTA],
  ]);
  await owner.query('delete from account where email = $1::citext', [CORREO_PACIENTE]);
}

async function limpiar(): Promise<void> {
  await limpiarFichas();
  await owner.query('delete from practice where id = any($1::uuid[])', [
    [CONSULTA, OTRA_CONSULTA],
  ]);
  await owner.query('delete from account where email = any($1::citext[])', [
    [CORREO_DOCTORA, CORREO_OTRA_DOCTORA, CORREO_PACIENTE, CORREO_YA_TIENE],
  ]);
}

async function sembrarConsulta(
  practice: string,
  license: string,
  account: string,
  email: string,
  nombre: string,
): Promise<void> {
  await owner.query(
    `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit,
                           city)
     values ($1, $2, 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300, 'Santa Cruz')`,
    [practice, `Clínica ${nombre}`],
  );
  await owner.query(
    `insert into license (id, practice_id, status) values ($1, $2, 'verificada')`,
    [license, practice],
  );
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'practitioner', 'latam', $3, 'Paz')`,
    [account, email, nombre],
  );
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, set_at)
     values ($1, $2, false, now())`,
    [account, HASH],
  );
  await owner.query(
    `insert into practitioner (practice_id, account_id, first_name, last_name, role)
     values ($1, $2, $3, 'Paz', 'doctora')`,
    [practice, account, `Dra. ${nombre}`],
  );
  await owner.query('update practice set owner_account_id = $1 where id = $2', [
    account,
    practice,
  ]);
}

beforeAll(async () => {
  await limpiar();
  await sembrarConsulta(CONSULTA, LICENCIA, DOCTORA_CUENTA, CORREO_DOCTORA, 'Andrea');
  await sembrarConsulta(OTRA_CONSULTA, OTRA_LICENCIA, OTRA_DOCTORA_CUENTA, CORREO_OTRA_DOCTORA, 'Carla');
  // Una cuenta que YA EXISTE en la región, de otra consulta: es el caso `ya_tiene_cuenta`.
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'paciente', 'latam', 'Rocio', 'Vargas')`,
    [YA_TIENE_CUENTA, CORREO_YA_TIENE],
  );
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, temp_expires_at, temp_first_used_at)
     values ($1, $2, true, now() + interval '72 hours', now() - interval '1 day')`,
    [YA_TIENE_CUENTA, HASH],
  );
});

afterAll(async () => {
  await limpiar();
  await app.end();
  await owner.end();
});

beforeEach(async () => {
  await limpiarFichas();
  await licencia('verificada');
});

type Ficha = {
  id: string;
  practice_id: string;
  email: string;
  phone: string | null;
  has_whatsapp: boolean;
  reminders_via: string;
  how_arrived: string;
  status: string;
};

async function fichaDe(email: string): Promise<Ficha | undefined> {
  const { rows } = await owner.query<Ficha>(
    `select id, practice_id, email::text as email, phone, has_whatsapp, reminders_via,
            how_arrived, status
       from patient where email = $1::citext`,
    [email],
  );
  return rows[0];
}

describe('el alta escribe las tres filas de la consulta, y nada más', () => {
  it('la ficha, el vínculo y los antecedentes, con la cuenta nueva y su temporal', async () => {
    const respuesta = await caso().run(CUERPO, DOCTORA, clave(CUERPO));

    const ficha = await fichaDe(CORREO_PACIENTE);
    expect(ficha?.id).toBe(respuesta.paciente_id);
    expect(ficha?.practice_id).toBe(CONSULTA);
    // La columna es `citext` y el correo entra normalizado en minúsculas.
    expect(ficha?.email).toBe('valeria.antelo@altas.local');
    expect(ficha?.phone).toBe('+59177124408');
    expect(ficha?.status).toBe('activa');

    const { rows: vinculos } = await owner.query<{
      status: string;
      email: string;
      account_id: string;
      practice_name: string;
      practitioner_name: string;
      city: string | null;
      access_sent_at: Date | null;
    }>(
      `select status, email::text as email, account_id, practice_name, practitioner_name, city,
              access_sent_at
         from patient_link where patient_id = $1`,
      [respuesta.paciente_id],
    );
    expect(vinculos[0]).toMatchObject({
      status: 'invitada',
      email: 'valeria.antelo@altas.local',
      account_id: respuesta.cuenta_id,
      // Las tres copias que la app de la paciente lee: no tiene política en `practice` ni
      // en `practitioner`.
      practice_name: 'Clínica Andrea',
      practitioner_name: 'Dra. Andrea Paz',
      city: 'Santa Cruz',
    });
    // Por WhatsApp manda la doctora con el dedo: MedSkin no afirma ningún envío.
    expect(vinculos[0]?.access_sent_at).toBeNull();

    // La cuenta nació con su temporal, hasheada con Argon2id y sin estrenar.
    const { rows: credenciales } = await owner.query<{
      hash: string;
      is_temporary: boolean;
      temp_expires_at: Date | null;
      temp_first_used_at: Date | null;
    }>(
      `select c.hash, c.is_temporary, c.temp_expires_at, c.temp_first_used_at
         from credential c where c.account_id = $1`,
      [respuesta.cuenta_id],
    );
    expect(credenciales[0]?.is_temporary).toBe(true);
    expect(credenciales[0]?.hash.startsWith('$argon2id$')).toBe(true);
    expect(credenciales[0]?.temp_first_used_at).toBeNull();
    // 72 h, y la base lo comprueba además en la función.
    const vida = (credenciales[0]?.temp_expires_at?.getTime() ?? 0) - Date.now();
    expect(vida).toBeGreaterThan(71 * 3600_000);
    expect(vida).toBeLessThanOrEqual(72 * 3600_000);

    // Y la temporal que viaja en la respuesta es la que abre esa credencial: lo que la
    // doctora dicta por WhatsApp tiene que funcionar.
    expect(
      await new Argon2Passwords().verify(
        credenciales[0]?.hash ?? '',
        respuesta.acceso.contrasena_temporal ?? '',
      ),
    ).toBe(true);
  });

  it('cada campo de los antecedentes guarda quién lo escribió, y el vacío se queda sin autor', async () => {
    const respuesta = await caso().run(CUERPO, DOCTORA, clave(CUERPO));

    const { rows } = await owner.query<Record<string, unknown>>(
      `select has_allergies, allergies, allergies_source, allergies_source_at,
              takes_medication, medication, medication_source,
              pregnancy_or_lactation, pregnancy_or_lactation_source,
              phototype, phototype_source,
              past_conditions, past_conditions_source,
              previous_treatments, previous_treatments_source,
              notes, notes_source
         from medical_history where patient_id = $1`,
      [respuesta.paciente_id],
    );

    expect(rows[0]).toMatchObject({
      has_allergies: true,
      allergies: ['lidocaína'],
      allergies_source: 'doctora',
      // `false` es «se le preguntó y no toma»: ES una respuesta, así que lleva autor.
      takes_medication: false,
      medication: [],
      medication_source: 'doctora',
      phototype: 3,
      phototype_source: 'doctora',
      notes: 'Pide empezar por la zona periocular.',
      notes_source: 'doctora',
      // Lo que nadie contestó: nulo y SIN autor, que es «nadie preguntó todavía» y no «no
      // tiene». Es lo que deja a la paciente escribirlo desde su app sin pisar nada.
      pregnancy_or_lactation: null,
      pregnancy_or_lactation_source: null,
      past_conditions: [],
      past_conditions_source: null,
      previous_treatments: [],
      previous_treatments_source: null,
    });
    expect(rows[0]?.allergies_source_at).toBeInstanceOf(Date);
  });

  it('la entrega queda en `access_audit` con quién la pidió, y sin la contraseña', async () => {
    const respuesta = await caso().run(CUERPO, DOCTORA, clave(CUERPO));

    const { rows } = await owner.query<{
      actor_account_id: string;
      action: string;
      subject_id: string;
      data: Record<string, unknown>;
    }>(
      `select actor_account_id, action, subject_id, data from access_audit
        where practice_id = $1 order by id`,
      [CONSULTA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_account_id: DOCTORA_CUENTA,
      action: 'cuenta.acceso_pedido',
      subject_id: respuesta.cuenta_id,
      data: { via: 'whatsapp', alta: true, ya_tenia_cuenta: false },
    });
    // Ni la contraseña ni un dato clínico en la fila: identificadores y etiquetas cerradas.
    const fila = JSON.stringify(rows[0]?.data);
    expect(fila).not.toContain(respuesta.acceso.contrasena_temporal);
    expect(fila).not.toContain('lidocaína');
  });

  it('por correo nace la marca de envío puesta, y el relé caído la deja en nulo otra vez', async () => {
    const salio = await caso().run({ ...CUERPO, enviar_acceso_por: 'correo' }, DOCTORA, clave({ ...CUERPO, enviar_acceso_por: 'correo' }));
    const { rows: conEnvio } = await owner.query<{ access_sent_at: Date | null }>(
      'select access_sent_at from patient_link where patient_id = $1',
      [salio.paciente_id],
    );
    expect(conEnvio[0]?.access_sent_at).toBeInstanceOf(Date);

    await limpiarFichas();
    const fallo = await caso(CORREO_CAIDO)
      .run({ ...CUERPO, enviar_acceso_por: 'correo' }, DOCTORA, clave({ ...CUERPO, enviar_acceso_por: 'correo' }))
      .catch((e: unknown) => e);
    expect(fallo).toBeInstanceOf(ContractError);
    expect((fallo as ContractError).code).toBe('fallo_de_servicio');

    // La ficha queda —eso es lo que la frase del 500 admite— y la marca vuelve a nulo: si
    // no, la consola leería «ya se le mandó» de una paciente que no recibió nada.
    const ficha = await fichaDe(CORREO_PACIENTE);
    const { rows: sinEnvio } = await owner.query<{ access_sent_at: Date | null }>(
      'select access_sent_at from patient_link where patient_id = $1',
      [ficha?.id],
    );
    expect(sinEnvio[0]?.access_sent_at).toBeNull();
  });
});

describe('lo que la base decide, y el otra consulta', () => {
  it('con la licencia sin verificar no se crea ni la ficha ni la cuenta', async () => {
    await licencia('en_revision');
    const fallo = await caso().run(CUERPO, DOCTORA, clave(CUERPO)).catch((e: unknown) => e);

    expect((fallo as ContractError).code).toBe('licencia_sin_verificar');
    expect(await fichaDe(CORREO_PACIENTE)).toBeUndefined();
    // Y la cuenta tampoco: el 409 se decide ANTES de llamar a la función del alta.
    const { rows } = await owner.query('select 1 from account where email = $1::citext', [
      CORREO_PACIENTE,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('el límite del plan cuenta las fichas de ESTA consulta y nada más', async () => {
    await owner.query('update practice set patient_limit = 1 where id = $1', [CONSULTA]);
    // Una ficha en la OTRA consulta no gasta el plan de esta.
    await owner.query(
      `insert into patient (practice_id, first_name, last_name, birth_date, email, how_arrived)
       values ($1, 'Ajena', 'Ajena', '1990-01-01', 'ajena@altas.local', 'instagram')`,
      [OTRA_CONSULTA],
    );
    const creada = await caso().run(CUERPO, DOCTORA, clave(CUERPO));
    expect(creada.paciente_id).toBeTruthy();

    // La segunda ya pasa del plan de 1.
    const fallo = await caso()
      .run({ ...CUERPO, correo: 'otra.paciente@altas.local' }, DOCTORA, clave({ ...CUERPO, correo: 'otra.paciente@altas.local' }))
      .catch((e: unknown) => e);
    expect((fallo as ContractError).code).toBe('limite_del_plan');
    expect((fallo as ContractError).userMessage).toContain('1 pacientes de tu plan');

    await owner.query('update practice set patient_limit = 300 where id = $1', [CONSULTA]);
    await owner.query('delete from account where email = $1::citext', [
      'otra.paciente@altas.local',
    ]);
  });

  it('EL OTRO INQUILINO NO VE NADA: ni la ficha, ni el vínculo, ni los antecedentes', async () => {
    const creada = await caso().run(CUERPO, DOCTORA, clave(CUERPO));

    const visto = await withTenantContext(
      app,
      {
        role: 'app_practitioner',
        accountId: OTRA_DOCTORA_CUENTA,
        practiceId: OTRA_CONSULTA,
      },
      async (c) => {
        // Sin un solo `where practice_id`: lo que acota son las políticas, y es justo lo
        // que se quiere comprobar. Una búsqueda por el correo exacto devuelve CERO filas.
        const ficha = await c.query('select id from patient where email = $1::citext', [
          CORREO_PACIENTE,
        ]);
        const vinculo = await c.query('select id from patient_link where patient_id = $1', [
          creada.paciente_id,
        ]);
        const historia = await c.query(
          'select id from medical_history where patient_id = $1',
          [creada.paciente_id],
        );
        const bitacora = await c.query('select id from access_audit where subject_id = $1', [
          creada.cuenta_id,
        ]);
        return {
          fichas: ficha.rowCount,
          vinculos: vinculo.rowCount,
          historias: historia.rowCount,
          bitacora: bitacora.rowCount,
        };
      },
    );

    expect(visto).toEqual({ fichas: 0, vinculos: 0, historias: 0, bitacora: 0 });
  });

  it('la cuenta de una practicante no se reusa, y el 409 no dice por qué (0021)', async () => {
    // El correo de la doctora de la OTRA consulta, y el de la que llama: los dos son cuentas
    // de practicante, y ninguna se puede convertir en la paciente de nadie.
    for (const correo of [CORREO_OTRA_DOCTORA, CORREO_DOCTORA]) {
      const fallo = await caso().run({ ...CUERPO, correo }, DOCTORA, clave({ ...CUERPO, correo })).catch((e: unknown) => e);

      expect((fallo as ContractError).code).toBe('correo_no_disponible');
      expect((fallo as ContractError).status).toBe(409);
      expect((fallo as ContractError).userMessage.toLowerCase()).not.toContain('practicante');
      // Y no se creó ni la ficha ni el vínculo: la ficha va después de la cuenta.
      expect(await fichaDe(correo)).toBeUndefined();
    }

    // La cuenta de la doctora sigue siendo la de una practicante, con su credencial intacta.
    const { rows } = await owner.query<{ role: string; hash: string }>(
      `select a.role, c.hash from account a join credential c on c.account_id = a.id
        where a.email = $1::citext`,
      [CORREO_DOCTORA],
    );
    expect(rows[0]).toMatchObject({ role: 'practitioner', hash: HASH });
  });

  it('una referida de OTRA consulta no existe para esta, y el 404 es el mismo que el de una inventada', async () => {
    // La ficha ajena se crea con el dueño del esquema en la otra consulta.
    const { rows } = await owner.query<{ id: string }>(
      `insert into patient (practice_id, first_name, last_name, birth_date, email, how_arrived)
       values ($1, 'Carla', 'Rojas', '1990-01-01', 'carla.rojas@altas.local', 'instagram')
       returning id`,
      [OTRA_CONSULTA],
    );
    const ajena = rows[0]?.id;

    const fallo = await caso()
      .run({ ...CUERPO, como_llego: 'referida', referida_por: ajena }, DOCTORA, clave({ ...CUERPO, como_llego: 'referida', referida_por: ajena }))
      .catch((e: unknown) => e);
    expect((fallo as ContractError).code).toBe('referida_no_existe');

    const aInventada = {
      ...CUERPO,
      como_llego: 'referida',
      referida_por: '7a1a7a1a-9999-4999-8999-999999999999',
    };
    const inventada = await caso()
      .run(aInventada, DOCTORA, clave(aInventada))
      .catch((e: unknown) => e);
    expect((inventada as ContractError).code).toBe('referida_no_existe');
    expect((inventada as ContractError).userMessage).toBe(
      (fallo as ContractError).userMessage,
    );
    // Ninguna de las dos creó nada.
    expect(await fichaDe(CORREO_PACIENTE)).toBeUndefined();
    await owner.query('delete from account where email = $1::citext', ['carla.rojas@altas.local']);
  });

  it('el duplicado es por consulta: lo avisa en la suya y no en la ajena', async () => {
    await caso().run(CUERPO, DOCTORA, clave(CUERPO));

    const fallo = await caso().run(CUERPO, DOCTORA, clave(CUERPO)).catch((e: unknown) => e);
    expect((fallo as ContractError).code).toBe('correo_duplicado_en_la_consulta');
    expect((fallo as ContractError).userMessage).toContain('Ya tienes a Valeria Antelo');

    // Y con `confirmar_duplicado` la segunda ficha se crea a propósito: «Es otra persona».
    const segunda = await caso().run({ ...CUERPO, confirmar_duplicado: true }, DOCTORA, clave({ ...CUERPO, confirmar_duplicado: true }));
    expect(segunda.paciente_id).toBeTruthy();
    // La MISMA cuenta para las dos fichas: la cuenta es de la persona, la ficha es de la
    // consulta, y `patient_link` las une.
    const { rows } = await owner.query<{ total: string }>(
      `select count(*)::text as total from patient_link where account_id = $1`,
      [segunda.cuenta_id],
    );
    expect(rows[0]?.total).toBe('2');
  });

  it('la doctora de la otra consulta da de alta el mismo correo sin saber nada de la ficha de aquí', async () => {
    await caso().run(CUERPO, DOCTORA, clave(CUERPO));
    const ajena = await caso().run(CUERPO, OTRA_DOCTORA, clave(CUERPO));

    // Dos fichas que no comparten nada y UNA sola cuenta (§12.2.1).
    expect(ajena.cuenta_id).toBeTruthy();
    expect(ajena.acceso.via).toBe('ya_tiene_cuenta');
    const { rows } = await owner.query<{ practice_id: string }>(
      'select practice_id from patient where email = $1::citext order by created_at',
      [CORREO_PACIENTE],
    );
    expect(rows.map((r) => r.practice_id)).toEqual([CONSULTA, OTRA_CONSULTA]);
  });
});

// -------------------------------------------------------------------------------------
// LA IDEMPOTENCIA, CONTRA LA BASE. Es el defecto que el revisor bloqueó el 28 de octubre: la
// respuesta de este endpoint lleva la contraseña temporal EN CLARO, y vivía 24 h en Redis.
// Ahora vive en `idempotency_key`, dentro de la transacción que crea la ficha.
// -------------------------------------------------------------------------------------
describe('la repetición sale de la base, y de ningún otro sitio', () => {
  it('la misma clave y el mismo cuerpo devuelven la respuesta original, con UNA sola ficha', async () => {
    const misma = clave(CUERPO);
    const primera = await caso().run(CUERPO, DOCTORA, misma);
    const segunda = await caso().run(CUERPO, DOCTORA, misma);

    // Byte a byte, contraseña temporal incluida: es la decisión escrita del 27 de octubre
    // —«una sola vez» significa que ninguna LECTURA posterior la trae, no que el reintento
    // de la misma petición se quede sin ella—.
    expect(segunda).toEqual(primera);
    expect(segunda.acceso.contrasena_temporal).toBe(primera.acceso.contrasena_temporal);

    // Y una sola ficha: es el defecto que esto cierra. Con la fila fuera de la transacción,
    // el reintento creaba la segunda por la salida del duplicado («Es otra persona»).
    const { rows } = await owner.query<{ total: string }>(
      `select count(*)::text as total from patient where practice_id = $1`,
      [CONSULTA],
    );
    expect(rows[0]?.total).toBe('1');

    // La respuesta repetida ESTÁ EN LA BASE y es la que se devolvió.
    const { rows: fila } = await owner.query<{
      http_status: number | null;
      response: { acceso: { contrasena_temporal: string | null } };
      practice_id: string | null;
    }>('select http_status, response, practice_id from idempotency_key where key = $1', [
      misma.key,
    ]);
    expect(fila[0]?.http_status).toBe(201);
    expect(fila[0]?.practice_id).toBe(CONSULTA);
    expect(fila[0]?.response.acceso.contrasena_temporal).toBe(primera.acceso.contrasena_temporal);
  });

  it('DOS PETICIONES IDÉNTICAS A LA VEZ dejan UNA ficha: lo serializa la clave primaria', async () => {
    // La carrera que el revisor midió el 28 de octubre, y es el motivo de que `claim()` vaya
    // ANTES de escribir nada: con la reserva al final, las dos pasaban el `SELECT` vacío y
    // creaban las dos —`ON CONFLICT DO NOTHING` espera a la que va ganando y devuelve 0
    // filas sin fallar—. Y aquí el correo YA TIENE CUENTA, que es el caso sin red natural:
    // la función reusa la cuenta en vez de insertarla, `patient_practice_email_idx` no es
    // único y cada ficha trae un `patient_id` nuevo.
    const cuerpo = { ...CUERPO, correo: CORREO_YA_TIENE, enviar_acceso_por: 'ninguna' };
    const misma = clave(cuerpo);

    const [una, otra] = await Promise.allSettled([
      caso().run(cuerpo, DOCTORA, misma),
      caso().run(cuerpo, DOCTORA, misma),
    ]);

    // Una gana y la otra se entera ANTES de crear: su 500 no promete un alta nueva.
    const cumplidas = [una, otra].filter((r) => r.status === 'fulfilled');
    const rechazadas = [una, otra].filter((r) => r.status === 'rejected');
    expect(cumplidas).toHaveLength(1);
    expect(rechazadas).toHaveLength(1);
    const fallo = (rechazadas[0] as PromiseRejectedResult).reason as ContractError;
    expect(fallo.code).toBe('fallo_de_servicio');
    expect(fallo.userMessage).toBe(
      'No pudimos mandarle el acceso. Su ficha ya está creada, así que no la vuelvas a dar de alta: vuelve a mandárselo desde su ficha.',
    );

    // Y LO QUE IMPORTA: una ficha, un vínculo, una historia y una clave. No dos.
    const { rows: cuantas } = await owner.query<{
      fichas: string;
      vinculos: string;
      historias: string;
      claves: string;
    }>(
      `select (select count(*) from patient where practice_id = $1)::text as fichas,
              (select count(*) from patient_link where practice_id = $1)::text as vinculos,
              (select count(*) from medical_history where practice_id = $1)::text as historias,
              (select count(*) from idempotency_key where key = $2)::text as claves`,
      [CONSULTA, misma.key],
    );
    expect(cuantas[0]).toEqual({ fichas: '1', vinculos: '1', historias: '1', claves: '1' });

    // Y la ganadora cerró su clave, así que un tercer intento con la misma clave ya repite
    // su respuesta en vez de dar el 500 de la reserva sin cerrar.
    const tercera = await caso().run(cuerpo, DOCTORA, misma);
    expect(tercera).toEqual((cumplidas[0] as PromiseFulfilledResult<unknown>).value);

    await owner.query('delete from patient where practice_id = $1', [CONSULTA]);
  });

  it('una clave caducada NO se repite: la ventana es la del contrato, no la del barrendero', async () => {
    // `expires_at > now()` está en la lectura a propósito: si la repetición dependiera de que
    // la fila siga existiendo, lo que pasa en el minuto 1441 dependería de cuándo pasó el
    // barrendero. Con el filtro, la ventana es siempre 24 h.
    const misma = clave(CUERPO);
    const primera = await caso().run(CUERPO, DOCTORA, misma);

    await owner.query(
      `update idempotency_key set expires_at = now() - interval '1 minute' where key = $1`,
      [misma.key],
    );

    // Con la fila caducada el alta se vuelve a atender: lo que la para es el duplicado de la
    // ficha, que es el error del contrato para esto, y no un 500.
    const fallo = await caso().run(CUERPO, DOCTORA, misma).catch((e: unknown) => e);
    expect((fallo as ContractError).code).toBe('correo_duplicado_en_la_consulta');
    expect(primera.paciente_id).toBeTruthy();
  });

  it('un veredicto que no crea SUELTA la clave, y el reintento vuelve a intentarlo', async () => {
    await licencia('en_revision');
    const misma = clave(CUERPO);

    const primero = await caso().run(CUERPO, DOCTORA, misma).catch((e: unknown) => e);
    expect((primero as ContractError).code).toBe('licencia_sin_verificar');

    // Sin soltar la reserva, la doctora no podría reintentar con la misma clave cuando le
    // aprueben la licencia: recibiría el 500 de la reserva sin cerrar para siempre.
    const { rows } = await owner.query('select 1 from idempotency_key where key = $1', [
      misma.key,
    ]);
    expect(rows).toHaveLength(0);

    await licencia('verificada');
    const creada = await caso().run(CUERPO, DOCTORA, misma);
    expect(creada.paciente_id).toBeTruthy();
  });

  it('la misma clave con OTRO cuerpo es 409, y no crea nada', async () => {
    const misma = clave(CUERPO);
    await caso().run(CUERPO, DOCTORA, misma);

    const otro = { ...CUERPO, nombre: 'Valentina' };
    const fallo = await caso()
      .run(otro, DOCTORA, { key: misma.key, bodyHash: fingerprintOf(otro) })
      .catch((e: unknown) => e);

    expect((fallo as ContractError).code).toBe('clave_idempotencia_reutilizada');
    expect((fallo as ContractError).status).toBe(409);
    const { rows } = await owner.query<{ total: string }>(
      `select count(*)::text as total from patient where practice_id = $1`,
      [CONSULTA],
    );
    expect(rows[0]?.total).toBe('1');
  });

  it('una RESERVA sin cerrar no se vuelve a ejecutar: 500 con la frase que no miente', async () => {
    // Es lo que queda cuando el relé se cae: la ficha está creada y la respuesta no se
    // escribió. Volver a ejecutar en silencio es exactamente el defecto que esto cierra.
    const misma = clave(CUERPO);
    const caido = await caso(CORREO_CAIDO)
      .run({ ...CUERPO, enviar_acceso_por: 'correo' }, DOCTORA, misma)
      .catch((e: unknown) => e);
    expect((caido as ContractError).code).toBe('fallo_de_servicio');

    const { rows: reservada } = await owner.query<{ http_status: number | null }>(
      'select http_status from idempotency_key where key = $1',
      [misma.key],
    );
    expect(reservada[0]?.http_status).toBeNull();

    const reintento = await caso()
      .run({ ...CUERPO, enviar_acceso_por: 'correo' }, DOCTORA, misma)
      .catch((e: unknown) => e);
    expect((reintento as ContractError).code).toBe('fallo_de_servicio');
    expect((reintento as ContractError).userMessage).toBe(
      'No pudimos mandarle el acceso. Su ficha ya está creada, así que no la vuelvas a dar de alta: vuelve a mandárselo desde su ficha.',
    );
    // Y sigue habiendo UNA sola ficha.
    const { rows } = await owner.query<{ total: string }>(
      `select count(*)::text as total from patient where practice_id = $1`,
      [CONSULTA],
    );
    expect(rows[0]?.total).toBe('1');
  });

  it('la repetición deja su propia línea en la bitácora, y la primera también', async () => {
    const misma = clave(CUERPO);
    await caso().run(CUERPO, DOCTORA, misma);
    await caso().run(CUERPO, DOCTORA, misma);

    const { rows } = await owner.query<{ data: Record<string, unknown> }>(
      `select data from access_audit where practice_id = $1 and action = 'cuenta.acceso_pedido'
        order by id`,
      [CONSULTA],
    );
    // «Una contraseña entregada dos veces es un hecho que alguien puede querer reconstruir.»
    expect(rows).toHaveLength(2);
    expect(rows[0]?.data).toMatchObject({ alta: true, ya_tenia_cuenta: false });
    expect(rows[1]?.data).toMatchObject({ alta: true, repetida: true });
  });

  it('la clave de una consulta no repite nada de otra', async () => {
    const misma = clave(CUERPO);
    await caso().run(CUERPO, DOCTORA, misma);

    // La MISMA clave, la misma huella, otra consulta: la política de `idempotency_key` es por
    // consulta y la fila se busca además por la cuenta que llama, así que esto es un alta
    // nueva y no una repetición.
    const ajena = await caso().run(CUERPO, OTRA_DOCTORA, misma);
    expect(ajena.paciente_id).not.toBe('');
    const { rows } = await owner.query<{ practice_id: string }>(
      'select practice_id from patient where email = $1::citext order by created_at',
      [CORREO_PACIENTE],
    );
    expect(rows.map((r) => r.practice_id)).toEqual([CONSULTA, OTRA_CONSULTA]);
  });
});

describe('la cuenta que ya existe no se toca', () => {
  it('se reusa, no se acuña ninguna temporal y `temp_first_used_at` sigue donde estaba', async () => {
    const { rows: antes } = await owner.query<{ hash: string; temp_first_used_at: Date | null }>(
      'select hash, temp_first_used_at from credential where account_id = $1',
      [YA_TIENE_CUENTA],
    );

    const respuesta = await caso().run({ ...CUERPO, correo: CORREO_YA_TIENE }, DOCTORA, clave({ ...CUERPO, correo: CORREO_YA_TIENE }));

    expect(respuesta.cuenta_id).toBe(YA_TIENE_CUENTA);
    expect(respuesta.acceso.via).toBe('ya_tiene_cuenta');
    expect(respuesta.acceso.contrasena_temporal).toBeNull();
    expect(respuesta.acceso.caduca_en).toBeNull();

    const { rows: despues } = await owner.query<{ hash: string; temp_first_used_at: Date | null }>(
      'select hash, temp_first_used_at from credential where account_id = $1',
      [YA_TIENE_CUENTA],
    );
    // Ni el hash ni la marca de primera entrada: acuñarle credenciales no deshace que ya
    // probó su correo, y aquí no se le acuña ninguna (napkin §1.10).
    expect(despues[0]?.hash).toBe(antes[0]?.hash);
    expect(despues[0]?.temp_first_used_at?.toISOString()).toBe(
      antes[0]?.temp_first_used_at?.toISOString(),
    );

    // Pero su ficha y su vínculo en ESTA consulta sí se crearon: lo que verá es la pantalla
    // «¿Es esta tu doctora?».
    const { rows: vinculo } = await owner.query<{ status: string; practice_id: string }>(
      'select status, practice_id from patient_link where account_id = $1',
      [YA_TIENE_CUENTA],
    );
    expect(vinculo[0]).toMatchObject({ status: 'invitada', practice_id: CONSULTA });

    await owner.query('delete from patient where practice_id = $1', [CONSULTA]);
  });

  it('por correo se le avisa, y la marca de envío lo afirma porque ocurrió', async () => {
    const cuerpo = { ...CUERPO, correo: CORREO_YA_TIENE, enviar_acceso_por: 'correo' };
    const respuesta = await caso().run(cuerpo, DOCTORA, clave(cuerpo));
    expect(respuesta.acceso.via).toBe('ya_tiene_cuenta');
    expect(respuesta.acceso.enviado).toBe(true);

    const { rows } = await owner.query<{ access_sent_at: Date | null }>(
      'select access_sent_at from patient_link where patient_id = $1',
      [respuesta.paciente_id],
    );
    expect(rows[0]?.access_sent_at).toBeInstanceOf(Date);

    // Y su credencial sigue intacta: no se acuñó nada que mandar.
    const { rows: cred } = await owner.query<{ hash: string }>(
      'select hash from credential where account_id = $1',
      [YA_TIENE_CUENTA],
    );
    expect(cred[0]?.hash).toBe(HASH);

    await owner.query('delete from patient where practice_id = $1', [CONSULTA]);
  });
});

describe('el «vuelve_si» del borrado de cuenta, que ahora tiene quien lo lea', () => {
  it('darla de alta otra vez con ese correo REENGANCHA su ficha, no crea una segunda', async () => {
    // Primer alta: ficha, vínculo y expediente.
    const primera = await caso().run(CUERPO, DOCTORA, clave(CUERPO));
    const ficha = primera.paciente_id;
    const { rows: cuenta } = await owner.query<{ id: string }>(
      'select id from account where email = $1::citext',
      [CORREO_PACIENTE],
    );

    // Ella borra su cuenta. El borrado SUELTA el vínculo y conserva el correo: «es la llave
    // del vuelve_si». Y su expediente se queda en la consulta.
    await owner.query(
      `update patient_link set account_id = null, status = 'invitada' where patient_id = $1`,
      [ficha],
    );
    await owner.query(
      `update account set email = ('borrada+' || id::text || '@medskin.invalid')::citext,
                          status = 'borrada', deleted_at = now()
        where id = $1`,
      [cuenta[0]!.id],
    );

    // Meses después, la misma doctora la da de alta con el mismo correo y añade un dato.
    const vuelta = {
      ...CUERPO,
      celular: '+59170000001',
      confirmar_duplicado: true,
      antes_de_atenderla: { medicacion: { toma: true, cuales: ['warfarina'] } },
    };
    const segunda = await caso().run(vuelta, DOCTORA, clave(vuelta));

    // LA MISMA FICHA. Esto es lo que el 200 del borrado le prometió por escrito.
    expect(segunda.paciente_id).toBe(ficha);
    const { rows: fichas } = await owner.query<{ n: string }>(
      'select count(*)::text as n from patient where practice_id = $1',
      [CONSULTA],
    );
    expect(fichas[0]?.n).toBe('1');

    // Un solo vínculo, y reenganchado a su cuenta nueva.
    const { rows: vinculos } = await owner.query<{ n: string; account_id: string | null }>(
      `select count(*)::text as n, min(account_id::text) as account_id
         from patient_link where patient_id = $1`,
      [ficha],
    );
    expect(vinculos[0]?.n).toBe('1');
    expect(vinculos[0]?.account_id).not.toBeNull();

    // SU EXPEDIENTE SIGUE AHÍ: la alergia del primer alta no se pisó, y la medicación nueva
    // entró. Un alta que borrara lo de antes sería peor que no reengancharla.
    const { rows: historia } = await owner.query<{
      allergies: string[];
      medication: string[];
      takes_medication: boolean | null;
    }>(
      'select allergies, medication, takes_medication from medical_history where patient_id = $1',
      [ficha],
    );
    expect(historia).toHaveLength(1);
    expect(historia[0]?.allergies).toEqual(['lidocaína']);
    expect(historia[0]?.takes_medication).toBe(true);
    expect(historia[0]?.medication).toEqual(['warfarina']);

    // Y su celular es el de hoy: los datos de contacto son los que la doctora acaba de escribir.
    const { rows: contacto } = await owner.query<{ phone: string; status: string }>(
      'select phone, status from patient where id = $1',
      [ficha],
    );
    expect(contacto[0]).toMatchObject({ phone: '+59170000001', status: 'activa' });

    await limpiarFichas();
  });
});
