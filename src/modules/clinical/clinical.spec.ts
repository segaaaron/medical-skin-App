// El tramo 5 contra la base real, en un solo archivo.
//
// Lo que se prueba: que otra consulta no ve el expediente, el camino bueno de cada escritura, y
// LAS TRES DECISIONES DEL CONTRATO — la nota firmada es inmutable (y lo garantiza la base, no el
// código), lo aplicado apunta al lote, y la respuesta correcta del consentimiento no la puede
// leer el rol de la paciente.

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Caller } from '../access/application/caller';
import { ClinicalSessions, Consents, Lots } from './application/clinical';
import { ClinicalRepository } from './infrastructure/clinical.repository';
import { ConsentsRepository } from './infrastructure/consents.repository';
import { LotsRepository } from './infrastructure/lots.repository';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 2 });
const NOW = new Date('2026-11-03T20:00:00Z');
const clock = { now: () => NOW };

const sessions = new ClinicalSessions(new ClinicalRepository(app), clock);
const lots = new Lots(new LotsRepository(app), clock);
const consents = new Consents(new ConsentsRepository(app));

const P = {
  practice: '11111111-0000-4000-8000-000000000001',
  other: '11111111-0000-4000-8000-000000000002',
  doctor: '11111111-0000-4000-8000-000000000011',
  assistant: '11111111-0000-4000-8000-000000000012',
  otherDoctor: '11111111-0000-4000-8000-000000000013',
  patient: '11111111-0000-4000-8000-000000000021',
  patientAccount: '11111111-0000-4000-8000-000000000031',
};
let treatment = '';
let product = '';
let lot = '';
let expiredLot = '';
let appointment = '';
let session = '';

function caller(account: string, role: 'doctora' | 'asistente_clinico', practice = P.practice): Caller {
  return {
    accountId: account,
    sessionId: '11111111-0000-4000-8000-0000000000ff',
    role,
    accountRole: 'practitioner',
    scope: 'completo',
    region: 'latam',
    practiceId: practice,
    permissions: ['sesiones:registrar', 'inventario:editar', 'historia:leer'],
  };
}

const ana: Caller = {
  accountId: P.patientAccount,
  sessionId: '11111111-0000-4000-8000-0000000000fe',
  role: 'paciente',
  accountRole: 'paciente',
  scope: 'completo',
  region: 'latam',
  practiceId: null,
  permissions: [],
};

const key = (k: string) => ({ key: k, bodyHash: `huella-${k}` });

beforeAll(async () => {
  await owner.query(`delete from practice where id = any($1::uuid[])`, [[P.practice, P.other]]);
  await owner.query(`delete from account where id = any($1::uuid[])`, [
    [P.doctor, P.assistant, P.otherDoctor, P.patientAccount],
  ]);
  await owner.query(`delete from idempotency_key where account_id = any($1::uuid[])`, [
    [P.doctor, P.assistant, P.patientAccount],
  ]);

  for (const [id, name] of [
    [P.practice, 'Clínica Paz'],
    [P.other, 'Clínica de al lado'],
  ]) {
    await owner.query(
      `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit)
       values ($1, $2, 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300)`,
      [id, name],
    );
  }
  const team: readonly [string, string, string][] = [
    [P.doctor, P.practice, 'doctora'],
    [P.assistant, P.practice, 'asistente_clinico'],
    [P.otherDoctor, P.other, 'doctora'],
  ];
  for (const [account, practice, role] of team) {
    await owner.query(
      `insert into account (id, email, role, region, first_name, last_name)
       values ($1, $2, 'practitioner', 'latam', 'Andrea', 'Paz')`,
      [account, `${account.slice(-3)}@tramo5.local`],
    );
    await owner.query(
      `insert into practitioner (practice_id, account_id, role, status, first_name, last_name)
       values ($1, $2, $3, 'activa', 'Andrea', 'Paz')`,
      [practice, account, role],
    );
  }

  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, 'ana@tramo5.local', 'paciente', 'latam', 'Ana', 'Antelo')`,
    [P.patientAccount],
  );
  await owner.query(
    `insert into patient (id, practice_id, first_name, last_name, birth_date, email, phone,
                          how_arrived)
     values ($1, $2, 'Ana', 'Antelo', '1992-04-18', 'ana.ficha@tramo5.local', '+59177124408',
             'instagram')`,
    [P.patient, P.practice],
  );
  await owner.query(`insert into medical_history (practice_id, patient_id) values ($1, $2)`, [
    P.practice,
    P.patient,
  ]);
  await owner.query(
    `insert into patient_link (practice_id, patient_id, account_id, status, email, practice_name,
                               practitioner_name)
     values ($1, $2, $3, 'vinculada', 'ana@tramo5.local', 'Clínica Paz', 'Dra. Andrea Paz')`,
    [P.practice, P.patient, P.patientAccount],
  );

  // Un tratamiento QUE EXIGE CONSENTIMIENTO: es lo que bloquea la firma de la nota.
  const { rows: treatments } = await owner.query<{ id: string }>(
    `insert into treatment (practice_id, name, category, duration_minutes, planned_sessions,
                            requires_consent)
     values ($1, 'Toxina', 'toxina', 40, 1, true) returning id`,
    [P.practice],
  );
  treatment = treatments[0]!.id;
  await owner.query(
    `insert into price (practice_id, treatment_id, zone, cents) values ($1, $2, null, 192000)`,
    [P.practice, treatment],
  );
  await owner.query(
    `insert into treatment_protocol_step (practice_id, treatment_id, moment, offset_hours, text)
     values ($1, $2, 'despues', 3, 'No te recuestes.'), ($1, $2, 'despues', 24, 'Agua tibia.')`,
    [P.practice, treatment],
  );
  // El texto del consentimiento, con su clave de respuestas EN SU COLUMNA.
  await owner.query(
    `insert into consent_text (practice_id, treatment_id, version, body, questions, answer_key)
     values ($1, $2, '2026-09-01', 'Texto del consentimiento.',
             '[{"id":"q1","texto":"¿Qué puede pasar?","opciones":["Moretones","Nada","Fiebre"]},
               {"id":"q2","texto":"¿Qué no hacer?","opciones":["Ejercicio","Comer","Leer"]},
               {"id":"q3","texto":"¿Qué no se garantiza?","opciones":["Simetría total","Nada","Todo"]}]'::jsonb,
             '{"q1":"0","q2":"0","q3":"0"}'::jsonb)`,
    [P.practice, treatment],
  );

  const { rows: products } = await owner.query<{ id: string }>(
    `insert into product (practice_id, name, unit) values ($1, 'Toxina 100U', 'unidad')
     returning id`,
    [P.practice],
  );
  product = products[0]!.id;
  const { rows: freshLots } = await owner.query<{ id: string }>(
    `insert into product_lot (practice_id, product_id, code, expires_on, units, units_left,
                              cost_cents)
     values ($1, $2, 'BTX-2291', '2027-03-01', 100, 100, 120000) returning id`,
    [P.practice, product],
  );
  lot = freshLots[0]!.id;
  const { rows: oldLots } = await owner.query<{ id: string }>(
    `insert into product_lot (practice_id, product_id, code, expires_on, units, units_left)
     values ($1, $2, 'BTX-VENCIDO', '2026-10-12', 50, 50) returning id`,
    [P.practice, product],
  );
  expiredLot = oldLots[0]!.id;

  // La cita, ya ATENDIDA: una sesión cuelga de una cita atendida.
  const { rows: appointments } = await owner.query<{ id: string }>(
    `insert into appointment (practice_id, patient_id, treatment_id, starts_at, ends_at, status,
                              price_cents, attended)
     values ($1, $2, $3, '2026-11-03T15:00:00Z', '2026-11-03T15:40:00Z', 'atendida', 192000, true)
     returning id`,
    [P.practice, P.patient, treatment],
  );
  appointment = appointments[0]!.id;
});

afterAll(async () => {
  await owner.query(`delete from practice where id = any($1::uuid[])`, [[P.practice, P.other]]);
  await owner.query(`delete from account where id = any($1::uuid[])`, [
    [P.doctor, P.assistant, P.otherDoctor, P.patientAccount],
  ]);
  await owner.end();
  await app.end();
});

describe('registrar lo que se hizo', () => {
  it('descuenta el stock en la misma transacción y guarda los puntos como filas', async () => {
    const created = (await sessions.create(
      {
        appointment_id: appointment,
        empezo_en: '2026-11-03T15:02:00Z',
        termino_en: '2026-11-03T15:38:00Z',
        aplicaciones: [
          {
            lot_id: lot,
            zona: 'entrecejo',
            tecnica: 'intramuscular',
            unidades_totales: 8,
            puntos: [
              { zona: 'entrecejo', x: 0.42, y: 0.31, unidades: 4 },
              { zona: 'entrecejo', x: 0.58, y: 0.31, unidades: 4 },
            ],
          },
        ],
        observaciones: 'Tolerancia buena.',
      },
      caller(P.assistant, 'asistente_clinico'),
      key('s1'),
    )) as { id: string; estado: string; stock_descontado: { quedan: number }[] };

    session = created.id;
    expect(created.estado).toBe('borrador');
    expect(created.stock_descontado[0]?.quedan).toBe(92);

    // Los puntos son FILAS, no un texto: dos puntos, dos filas, con sus unidades.
    const { rows } = await owner.query<{ n: string; total: string }>(
      `select count(*)::text as n, sum(units)::text as total from application_point
        where practice_id = $1`,
      [P.practice],
    );
    expect(rows[0]).toEqual({ n: '2', total: '8' });

    // Y el movimiento de stock quedó registrado: un inventario sin movimientos es un número
    // que nadie puede explicar.
    const { rows: movements } = await owner.query<{ reason: string; units: number }>(
      `select reason, units from stock_movement where session_id = $1`,
      [session],
    );
    expect(movements).toEqual([{ reason: 'aplicacion', units: -8 }]);
  });

  it('los puntos que no suman el total son un 400, y el servidor no los corrige', async () => {
    await expect(
      sessions.create(
        {
          appointment_id: appointment,
          aplicaciones: [
            {
              lot_id: lot,
              zona: 'frente',
              unidades_totales: 20,
              puntos: [{ zona: 'frente', x: 0.5, y: 0.2, unidades: 16 }],
            },
          ],
        },
        caller(P.doctor, 'doctora'),
        key('s-nocuadra'),
      ),
    ).rejects.toMatchObject({ code: 'unidades_no_cuadran' });
  });

  it('un lote vencido BLOQUEA, y una cita que ya tiene sesión también', async () => {
    const { rows } = await owner.query<{ id: string }>(
      `insert into appointment (practice_id, patient_id, treatment_id, starts_at, ends_at,
                                status, price_cents, attended)
       values ($1, $2, $3, '2026-11-04T15:00:00Z', '2026-11-04T15:40:00Z', 'atendida', 192000,
               true)
       returning id`,
      [P.practice, P.patient, treatment],
    );

    await expect(
      sessions.create(
        {
          appointment_id: rows[0]!.id,
          aplicaciones: [{ lot_id: expiredLot, zona: 'frente', unidades_totales: 4 }],
        },
        caller(P.doctor, 'doctora'),
        key('s-vencido'),
      ),
    ).rejects.toMatchObject({ code: 'lote_vencido' });

    // Y la cita de la primera sesión ya no admite otra.
    await expect(
      sessions.create(
        {
          appointment_id: appointment,
          aplicaciones: [{ lot_id: lot, zona: 'frente', unidades_totales: 4 }],
        },
        caller(P.doctor, 'doctora'),
        key('s-repetida'),
      ),
    ).rejects.toMatchObject({ code: 'cita_ya_tiene_sesion' });
  });
});

describe('la nota: dos personas escribiendo, y la firma', () => {
  it('conserva los dos valores cuando el mismo campo cambió por detrás', async () => {
    const first = (await sessions.saveDraft(
      session,
      { campos: { motivo: 'Líneas de expresión.', procedimiento: '20 U en 5 puntos.' } },
      caller(P.doctor, 'doctora'),
    )) as { guardado: string[]; en_conflicto: unknown[] };
    expect(first.guardado.sort()).toEqual(['motivo', 'procedimiento']);
    expect(first.en_conflicto).toEqual([]);

    // La asistente venía mirando la nota de ANTES: su `visto_en` es anterior al guardado de
    // arriba, así que su `procedimiento` no pisa el de la doctora.
    const second = (await sessions.saveDraft(
      session,
      {
        campos: { procedimiento: '20 U, cuatro por punto.' },
        visto_en: '2026-11-03T19:00:00Z',
      },
      caller(P.assistant, 'asistente_clinico'),
    )) as { guardado: string[]; en_conflicto: { campo: string; tuyo: string; del_servidor: string }[] };

    expect(second.guardado).toEqual([]);
    expect(second.en_conflicto[0]).toMatchObject({
      campo: 'procedimiento',
      tuyo: '20 U, cuatro por punto.',
      del_servidor: '20 U en 5 puntos.',
    });
  });

  it('con un conflicto abierto no se firma, y el asistente no firma nunca', async () => {
    await expect(sessions.sign(session, caller(P.assistant, 'asistente_clinico'))).rejects.toMatchObject(
      { code: 'solo_la_doctora_firma' },
    );
    await expect(sessions.sign(session, caller(P.doctor, 'doctora'))).rejects.toMatchObject({
      code: 'conflictos_sin_resolver',
    });

    // Se resuelve escribiendo el campo otra vez, ya con la nota a la vista.
    await sessions.saveDraft(
      session,
      { campos: { procedimiento: '20 U en 5 puntos, 4 por punto.' } },
      caller(P.doctor, 'doctora'),
    );
  });

  it('sin consentimiento firmado no se cierra la sesión', async () => {
    await expect(sessions.sign(session, caller(P.doctor, 'doctora'))).rejects.toMatchObject({
      code: 'consentimiento_pendiente',
    });
  });

  it('firmar programa los cuidados, y la nota firmada ya no se toca', async () => {
    // El consentimiento, firmado por ella misma y con las tres bien.
    await consents.sign(
      {
        patient_id: P.patient,
        treatment_id: treatment,
        version: '2026-09-01',
        proposito: 'clinico',
        respuestas: { q1: 0, q2: 0, q3: 0 },
        leido_en_segundos: 74,
      },
      ana,
      key('c1'),
    );

    const signed = (await sessions.sign(session, caller(P.doctor, 'doctora'))) as {
      estado: string;
      cuidados_programados: number;
      semaforo_entregado: boolean;
    };
    expect(signed).toMatchObject({ estado: 'firmada', semaforo_entregado: true });
    // Los dos pasos `despues` del protocolo, copiados al firmar.
    expect(signed.cuidados_programados).toBe(2);

    // Y ahora es INMUTABLE, y lo garantiza la base: ni con el dueño del esquema.
    await expect(
      owner.query(`update session_note set fields = '{}'::jsonb where session_id = $1`, [session]),
    ).rejects.toThrow(/una nota firmada no se modifica/);

    // Por la puerta de la app, el 409 del contrato.
    await expect(
      sessions.saveDraft(session, { campos: { motivo: 'otro' } }, caller(P.doctor, 'doctora')),
    ).rejects.toMatchObject({ code: 'nota_ya_firmada' });
  });

  it('una nota firmada se corrige, y una sesión firmada no se anula', async () => {
    const correction = (await sessions.correct(
      session,
      { texto: 'Fueron 5 puntos, no 4.', motivo: 'error_de_transcripcion' },
      caller(P.doctor, 'doctora'),
    )) as { id: string };
    expect(correction.id).toBeTruthy();

    // La segunda corrección apunta a la primera: la cadena se lee en orden.
    await sessions.correct(
      session,
      { texto: 'Aclaración sobre la zona.', motivo: 'aclaracion' },
      caller(P.doctor, 'doctora'),
    );
    const { rows } = await owner.query<{ n: string; chained: string }>(
      `select count(*)::text as n,
              count(corrects_correction_id)::text as chained
         from note_correction where practice_id = $1`,
      [P.practice],
    );
    expect(rows[0]).toEqual({ n: '2', chained: '1' });

    await expect(
      sessions.voidSession(session, { motivo: 'me equivoqué de paciente' }, caller(P.doctor, 'doctora')),
    ).rejects.toMatchObject({ code: 'nota_firmada' });
  });
});

describe('el lote, el retiro y lo que otra consulta no ve', () => {
  it('dado un lote, a qué pacientes se les aplicó', async () => {
    const found = (await lots.patients(lot, caller(P.doctor, 'doctora'))) as {
      cuantas: number;
      pacientes: { paciente_id: string; celular: string | null; unidades: number }[];
    };
    expect(found.cuantas).toBe(1);
    // Con el celular, a propósito: hay que poder llamar sin abrir catorce fichas.
    expect(found.pacientes[0]).toMatchObject({
      paciente_id: P.patient,
      celular: '+59177124408',
      unidades: 8,
    });

    // Y cada nombre servido dejó su apertura de historial.
    const { rows } = await owner.query<{ n: string }>(
      `select count(*)::text as n from access_audit
        where subject_id = $1 and data->>'motivo' = 'retiro_de_lote'`,
      [P.patient],
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });

  it('el lote de al lado no existe, y su código no se puede repetir aquí', async () => {
    await expect(lots.patients(lot, caller(P.otherDoctor, 'doctora', P.other))).rejects.toMatchObject(
      { code: 'lote_no_existe' },
    );

    await expect(
      lots.create(
        { product_id: product, codigo: 'BTX-2291', vence_en: '2027-06-01', unidades: 50 },
        caller(P.doctor, 'doctora'),
        key('l-repetido'),
      ),
    ).rejects.toMatchObject({ code: 'codigo_de_lote_repetido' });
  });

  it('un lote vencido no se carga', async () => {
    await expect(
      lots.create(
        { product_id: product, codigo: 'BTX-NUEVO', vence_en: '2026-01-01', unidades: 10 },
        caller(P.doctor, 'doctora'),
        key('l-vencido'),
      ),
    ).rejects.toMatchObject({ code: 'vencimiento_en_el_pasado' });
  });
});

describe('el consentimiento y su comprensión verificada', () => {
  it('el texto viaja sin la respuesta correcta, y el rol de la paciente no puede leerla', async () => {
    const text = (await consents.text(treatment, ana)) as {
      version: string;
      preguntas: { id: string; correcta: null }[];
    };
    expect(text.version).toBe('2026-09-01');
    expect(text.preguntas).toHaveLength(3);
    expect(text.preguntas.every((q) => q.correcta === null)).toBe(true);

    // Y no es solo que el servidor la quite: su rol NO TIENE privilegio sobre esa columna.
    const { rows } = await owner.query<{ can: boolean }>(
      `select has_column_privilege('app_patient', 'consent_text', 'answer_key', 'select') as can`,
    );
    expect(rows[0]?.can).toBe(false);
  });

  it('fallar una pregunta no es un muro: dice cuál, y no se firma', async () => {
    const { rows: patients } = await owner.query<{ id: string }>(
      `insert into patient (practice_id, first_name, last_name, birth_date, email, how_arrived)
       values ($1, 'Bea', 'Antelo', '1990-01-01', 'bea.ficha@tramo5.local', 'instagram')
       returning id`,
      [P.practice],
    );

    await expect(
      consents.sign(
        {
          patient_id: patients[0]!.id,
          treatment_id: treatment,
          version: '2026-09-01',
          proposito: 'clinico',
          respuestas: { q1: 0, q2: 2, q3: 0 },
        },
        caller(P.doctor, 'doctora'),
        key('c-mal'),
      ),
    ).rejects.toMatchObject({ code: 'respuestas_incorrectas', data: { fallidas: ['q2'] } });

    // Y una versión vieja tampoco firma: «un consentimiento que apunta a un texto que cambió
    // después no prueba nada».
    await expect(
      consents.sign(
        {
          patient_id: patients[0]!.id,
          treatment_id: treatment,
          version: '2020-01-01',
          proposito: 'clinico',
          respuestas: { q1: 0, q2: 0, q3: 0 },
        },
        caller(P.doctor, 'doctora'),
        key('c-vieja'),
      ),
    ).rejects.toMatchObject({ code: 'version_desactualizada' });
  });

  it('el clínico y el de marketing son dos filas distintas', async () => {
    await consents.sign(
      {
        patient_id: P.patient,
        version: '2026-09-01',
        proposito: 'marketing',
        respuestas: { q1: 0, q2: 0, q3: 0 },
      },
      caller(P.doctor, 'doctora'),
      key('c-marketing'),
    );

    const { rows } = await owner.query<{ purpose: string }>(
      `select purpose from consent where patient_id = $1 order by purpose`,
      [P.patient],
    );
    expect(rows.map((r) => r.purpose)).toEqual(['clinico', 'marketing']);
  });
});

describe('anular devuelve el stock', () => {
  it('una sesión en borrador se anula con su motivo y el lote recupera sus unidades', async () => {
    const { rows: appointments } = await owner.query<{ id: string }>(
      `insert into appointment (practice_id, patient_id, treatment_id, starts_at, ends_at,
                                status, price_cents, attended)
       values ($1, $2, $3, '2026-11-05T15:00:00Z', '2026-11-05T15:40:00Z', 'atendida', 192000,
               true)
       returning id`,
      [P.practice, P.patient, treatment],
    );
    const created = (await sessions.create(
      {
        appointment_id: appointments[0]!.id,
        aplicaciones: [{ lot_id: lot, zona: 'frente', unidades_totales: 10 }],
      },
      caller(P.doctor, 'doctora'),
      key('s-anular'),
    )) as { id: string; stock_descontado: { quedan: number }[] };
    expect(created.stock_descontado[0]?.quedan).toBe(82);

    await expect(
      sessions.voidSession(created.id, { motivo: 'corto' }, caller(P.doctor, 'doctora')),
    ).rejects.toMatchObject({ code: 'motivo_muy_corto' });

    const voided = await sessions.voidSession(
      created.id,
      { motivo: 'me equivoqué de paciente al registrar' },
      caller(P.doctor, 'doctora'),
    );
    expect(voided).toMatchObject({ estado: 'anulada' });

    const { rows } = await owner.query<{ units_left: number }>(
      `select units_left from product_lot where id = $1`,
      [lot],
    );
    expect(rows[0]?.units_left).toBe(92);

    // Anular NO borra: la sesión sigue, con su motivo.
    const { rows: still } = await owner.query<{ status: string; voided_reason: string }>(
      `select status, voided_reason from clinical_session where id = $1`,
      [created.id],
    );
    expect(still[0]).toMatchObject({ status: 'anulada' });
  });
});
