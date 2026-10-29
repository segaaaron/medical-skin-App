// El tramo 7 contra la base real, en un solo archivo.
//
// Lo que se prueba: que el plan se CREA AL FIRMAR con el protocolo copiado, que un cuidado
// cumplido no se desmarca, que dos doctoras tienen dos hilos que no se ven entre sí, y que la
// respuesta de una incidencia lleva SIEMPRE el teléfono de la consulta.

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Caller } from '../access/application/caller';
import { ClinicalSessions } from '../clinical/application/clinical';
import { ClinicalRepository } from '../clinical/infrastructure/clinical.repository';
import { Aftercare } from './application/aftercare';
import { AftercareRepository } from './infrastructure/aftercare.repository';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 2 });
let NOW = new Date('2026-11-03T20:00:00Z');
const clock = { now: () => NOW };

const aftercare = new Aftercare(new AftercareRepository(app), clock);
const sessions = new ClinicalSessions(new ClinicalRepository(app), clock);

const A = {
  practice: '33333333-0000-4000-8000-000000000001',
  other: '33333333-0000-4000-8000-000000000002',
  doctor: '33333333-0000-4000-8000-000000000011',
  otherDoctor: '33333333-0000-4000-8000-000000000012',
  patient: '33333333-0000-4000-8000-000000000021',
  otherPatient: '33333333-0000-4000-8000-000000000022',
  account: '33333333-0000-4000-8000-000000000031',
};
let session = '';

function doctor(practice: string, account: string): Caller {
  return {
    accountId: account,
    sessionId: '33333333-0000-4000-8000-0000000000ff',
    role: 'doctora',
    accountRole: 'practitioner',
    scope: 'completo',
    region: 'latam',
    practiceId: practice,
    permissions: ['sesiones:registrar', 'historia:leer', 'pacientes:leer'],
  };
}

const ana: Caller = {
  accountId: A.account,
  sessionId: '33333333-0000-4000-8000-0000000000fe',
  role: 'paciente',
  accountRole: 'paciente',
  scope: 'completo',
  region: 'latam',
  practiceId: null,
  permissions: [],
};

const key = (k: string) => ({ key: k, bodyHash: `huella-${k}` });

beforeAll(async () => {
  NOW = new Date('2026-11-03T20:00:00Z');
  await owner.query(`delete from practice where id = any($1::uuid[])`, [[A.practice, A.other]]);
  await owner.query(`delete from account where id = any($1::uuid[])`, [
    [A.doctor, A.otherDoctor, A.account],
  ]);
  // La cuenta de la PACIENTE también: desde el 29 de octubre de 2026 la incidencia y el
  // mensaje llevan clave, y sin este borrado la segunda corrida replicaría la primera.
  await owner.query(`delete from idempotency_key where account_id = any($1::uuid[])`, [
    [A.doctor, A.otherDoctor, A.account],
  ]);

  for (const [id, name, account] of [
    [A.practice, 'Clínica Paz', A.doctor],
    [A.other, 'Clínica Sur', A.otherDoctor],
  ] as const) {
    await owner.query(
      `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit,
                             phone)
       values ($1, $2, 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300, '+591 3 342 1180')`,
      [id, name],
    );
    await owner.query(
      `insert into account (id, email, role, region, first_name, last_name)
       values ($1, $2, 'practitioner', 'latam', 'Andrea', 'Paz')`,
      [account, `${account.slice(-3)}@tramo7.local`],
    );
    await owner.query(
      `insert into practitioner (practice_id, account_id, role, status, first_name, last_name)
       values ($1, $2, 'doctora', 'activa', 'Andrea', 'Paz')`,
      [id, account],
    );
    // LA DUEÑA REGISTRADA. `practice.owner_account_id` es nullable desde el tramo 1, y sin ella
    // el aviso de una incidencia no tiene a quién ir: ese caso tiene su propia prueba abajo.
    await owner.query(`update practice set owner_account_id = $2 where id = $1`, [id, account]);
  }

  // Ana, paciente de LAS DOS consultas: es lo que prueba que los hilos no se cruzan.
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, 'ana@tramo7.local', 'paciente', 'latam', 'Ana', 'Antelo')`,
    [A.account],
  );
  for (const [patient, practice, name] of [
    [A.patient, A.practice, 'Clínica Paz'],
    [A.otherPatient, A.other, 'Clínica Sur'],
  ] as const) {
    await owner.query(
      `insert into patient (id, practice_id, first_name, last_name, birth_date, email,
                            how_arrived)
       values ($1, $2, 'Ana', 'Antelo', '1992-04-18', $3, 'instagram')`,
      [patient, practice, `ana.${patient.slice(-2)}@tramo7.local`],
    );
    await owner.query(`insert into medical_history (practice_id, patient_id) values ($1, $2)`, [
      practice,
      patient,
    ]);
    await owner.query(
      `insert into patient_link (practice_id, patient_id, account_id, status, email,
                                 practice_name, practitioner_name)
       values ($1, $2, $3, 'vinculada', 'ana@tramo7.local', $4, 'Dra. Andrea Paz')`,
      [practice, patient, A.account, name],
    );
  }

  // Un tratamiento con DOS pasos de después y un semáforo: es lo que se copia al firmar.
  const { rows: treatments } = await owner.query<{ id: string }>(
    `insert into treatment (practice_id, name, category, duration_minutes, planned_sessions)
     values ($1, 'Toxina', 'toxina', 40, 1) returning id`,
    [A.practice],
  );
  const treatment = treatments[0]!.id;
  await owner.query(
    `insert into treatment_protocol_step (practice_id, treatment_id, moment, offset_hours, text)
     values ($1, $2, 'despues', 3, 'No te recuestes ni hagas ejercicio.'),
            ($1, $2, 'despues', 24, 'Puedes lavarte la cara con agua tibia.')`,
    [A.practice, treatment],
  );
  await owner.query(
    `insert into treatment_traffic_light (practice_id, treatment_id, day, normal, call_if)
     values ($1, $2, 1, 'Puntos rojos y leve hinchazón.', 'Fiebre, o dolor que aumenta.'),
            ($1, $2, 7, 'Efecto visible y parejo.', 'Asimetría marcada.')`,
    [A.practice, treatment],
  );

  const { rows: appointments } = await owner.query<{ id: string }>(
    `insert into appointment (practice_id, patient_id, treatment_id, starts_at, ends_at, status,
                              price_cents, attended)
     values ($1, $2, $3, '2026-11-03T15:00:00Z', '2026-11-03T15:40:00Z', 'atendida', 192000, true)
     returning id`,
    [A.practice, A.patient, treatment],
  );

  const created = (await sessions.create(
    {
      appointment_id: appointments[0]!.id,
      empezo_en: '2026-11-03T15:02:00Z',
      termino_en: '2026-11-03T15:38:00Z',
      aplicaciones: [
        {
          lot_id: (
            await owner.query<{ id: string }>(
              `insert into product (practice_id, name) values ($1, 'Toxina 100U')
               returning (select id from product where practice_id = $1 limit 1) as id`,
              [A.practice],
            )
          ).rows[0]!.id,
          zona: 'entrecejo',
          unidades_totales: 8,
        },
      ],
    },
    doctor(A.practice, A.doctor),
    key('s1'),
  ).catch(async () => {
    // El lote de verdad: el `insert` de arriba crea el producto; este crea su lote.
    const { rows: products } = await owner.query<{ id: string }>(
      `select id from product where practice_id = $1 limit 1`,
      [A.practice],
    );
    const { rows: lots } = await owner.query<{ id: string }>(
      `insert into product_lot (practice_id, product_id, code, expires_on, units, units_left)
       values ($1, $2, 'BTX-7', '2027-03-01', 100, 100) returning id`,
      [A.practice, products[0]!.id],
    );
    return sessions.create(
      {
        appointment_id: appointments[0]!.id,
        empezo_en: '2026-11-03T15:02:00Z',
        termino_en: '2026-11-03T15:38:00Z',
        aplicaciones: [{ lot_id: lots[0]!.id, zona: 'entrecejo', unidades_totales: 8 }],
      },
      doctor(A.practice, A.doctor),
      key('s2'),
    );
  })) as { id: string };
  session = created.id;

  await sessions.saveDraft(
    session,
    { campos: { motivo: 'Líneas de expresión.' } },
    doctor(A.practice, A.doctor),
  );
});

afterAll(async () => {
  await owner.query(`delete from practice where id = any($1::uuid[])`, [[A.practice, A.other]]);
  await owner.query(`delete from account where id = any($1::uuid[])`, [
    [A.doctor, A.otherDoctor, A.account],
  ]);
  await owner.end();
  await app.end();
});

describe('firmar programa el plan, con el protocolo copiado', () => {
  it('los pasos salen con su reloj y el futuro viaja igual que los demás', async () => {
    const signed = (await sessions.sign(session, doctor(A.practice, A.doctor))) as {
      cuidados_programados: number;
    };
    expect(signed.cuidados_programados).toBe(2);

    const seen = (await aftercare.plans({}, ana)) as {
      planes: {
        consulta: string;
        tratamiento: string;
        pasos: { aparece_en: string; texto: string; estado: string }[];
        adherencia: { hechos: number; de: number };
      }[];
    };
    const plan = seen.planes[0]!;
    expect(plan).toMatchObject({ consulta: 'Clínica Paz', tratamiento: 'Toxina' });
    expect(plan.adherencia).toEqual({ hechos: 0, de: 2 });

    // Calculado desde el fin de la sesión (15:38Z): +3 h y +24 h.
    expect(plan.pasos[0]?.aparece_en).toBe('2026-11-03T18:38:00.000Z');
    expect(plan.pasos[1]?.aparece_en).toBe('2026-11-04T15:38:00.000Z');
    // A las 20:00Z el primero ya apareció y el segundo todavía no: el `futuro` VIAJA IGUAL,
    // porque la app lo necesita para agendar su aviso local y que funcione sin conexión.
    expect(plan.pasos.map((step) => step.estado)).toEqual(['pendiente', 'futuro']);
  });

  it('un paso futuro no se marca, y uno cumplido no se desmarca', async () => {
    const plans = (await aftercare.plans({}, ana)) as {
      planes: { pasos: { id: string; estado: string }[] }[];
    };
    const [pending, future] = plans.planes[0]!.pasos;

    await expect(aftercare.markStep(future!.id, {}, ana)).rejects.toMatchObject({
      code: 'paso_futuro',
    });

    await expect(
      aftercare.markStep(pending!.id, { hecho_en: '2026-11-03T19:10:00Z' }, ana),
    ).resolves.toMatchObject({ estado: 'hecho' });

    // Idempotente: marcarlo otra vez deja lo mismo, y no hay forma de desmarcarlo.
    await expect(aftercare.markStep(pending!.id, {}, ana)).resolves.toMatchObject({
      estado: 'hecho',
    });

    const after = (await aftercare.plans({}, ana)) as {
      planes: { adherencia: { hechos: number; de: number }; pasos: { hecho_en: string | null }[] }[];
    };
    expect(after.planes[0]?.adherencia).toEqual({ hechos: 1, de: 2 });
    // El instante que vale es el que la app registró, no el de la llegada al servidor.
    expect(after.planes[0]?.pasos[0]?.hecho_en).toBe('2026-11-03T19:10:00.000Z');
  });

  it('la doctora ve la adherencia de su paciente, y no la de otra consulta', async () => {
    const hers = (await aftercare.plans(
      { patient_id: A.patient },
      doctor(A.practice, A.doctor),
    )) as { planes: { adherencia: { hechos: number } }[] };
    expect(hers.planes[0]?.adherencia.hechos).toBe(1);

    const theirs = (await aftercare.plans(
      { patient_id: A.patient },
      doctor(A.other, A.otherDoctor),
    )) as { planes: unknown[] };
    expect(theirs.planes).toEqual([]);
  });
});

describe('el semáforo y «algo no va bien»', () => {
  it('el semáforo trae los días con su normal y su llamar_si', async () => {
    const light = (await aftercare.trafficLight(session, ana)) as {
      dias: { dia: number; normal: string; llamar_si: string }[];
    };
    expect(light.dias.map((day) => day.dia)).toEqual([1, 7]);
    expect(light.dias[0]?.llamar_si).toBe('Fiebre, o dolor que aumenta.');
  });

  it('sin dueña registrada, la respuesta NO dice que la doctora lo recibió', async () => {
    // `practice.owner_account_id` es nullable desde el tramo 1. Sin ella, el aviso no tiene a
    // quién ir — y la respuesta decía «Tu doctora lo recibió y te va a responder por el chat»
    // igual, porque nadie miraba lo que devolvía la función de encolar. Es el mismo defecto que
    // la bandeja de salida vino a cerrar, por otra puerta.
    await owner.query(`update practice set owner_account_id = null where id = $1`, [A.practice]);
    try {
      const reported = (await aftercare.reportIncident(
        { session_id: session, que_pasa: 'Me arde al tocarlo.' },
        ana,
        key('inc-sin-duena'),
      )) as { avisamos_a: string | null; que_sigue: string };

      expect(reported.avisamos_a).toBeNull();
      expect(reported.que_sigue).not.toContain('Tu doctora lo recibió');
      expect(reported.que_sigue).toContain('Lo verán al abrir MedSkin');

      const { rows } = await owner.query<{ n: string }>(
        `select count(*)::text as n from notification_outbox
          where practice_id = $1 and (data->>'incidencia_id') is not null`,
        [A.practice],
      );
      expect(rows[0]?.n).toBe('0');
    } finally {
      await owner.query(`update practice set owner_account_id = $2 where id = $1`, [
        A.practice,
        A.doctor,
      ]);
    }
  });

  it('la incidencia responde SIEMPRE con el teléfono, incluso marcada leve', async () => {
    const reported = (await aftercare.reportIncident(
      {
        session_id: session,
        que_pasa: 'Tengo el párpado derecho más bajo desde ayer.',
        desde: '2026-11-05',
        gravedad_percibida: 'leve',
      },
      ana,
      key('incidencia-1'),
    )) as { estado: string; avisamos_a: string; si_es_urgente: string };

    expect(reported.estado).toBe('recibida');
    expect(reported.avisamos_a).toBe('Dra. Andrea Paz');
    // Una app no es un servicio de urgencias: la salida al teléfono es obligatoria.
    expect(reported.si_es_urgente).toContain('+591 3 342 1180');

    // Y nace con el `practice_id` de la SESIÓN, no del cuerpo.
    const { rows } = await owner.query<{ practice_id: string; adverse_event_id: string | null }>(
      `select practice_id, adverse_event_id from incident where session_id = $1`,
      [session],
    );
    expect(rows[0]?.practice_id).toBe(A.practice);
    // No es un evento adverso hasta que la doctora lo decida.
    expect(rows[0]?.adverse_event_id).toBeNull();
  });
});

describe('el hilo, los dispositivos y los avisos', () => {
  it('dos doctoras, dos hilos que no se ven entre sí', async () => {
    await aftercare.send(
      { practice_id: A.practice, texto: 'Hola doctora Paz.' },
      ana,
      key('msg-paz'),
    );
    await aftercare.send(
      { practice_id: A.other, texto: 'Hola doctora Sur.' },
      ana,
      key('msg-sur'),
    );

    const paz = (await aftercare.messages(
      { patient_id: A.patient },
      doctor(A.practice, A.doctor),
    )) as { mensajes: { texto: string }[] };
    expect(paz.mensajes.map((m) => m.texto)).toEqual(['Hola doctora Paz.']);

    const sur = (await aftercare.messages(
      { patient_id: A.otherPatient },
      doctor(A.other, A.otherDoctor),
    )) as { mensajes: { texto: string }[] };
    expect(sur.mensajes.map((m) => m.texto)).toEqual(['Hola doctora Sur.']);
  });

  it('un mensaje vacío y uno de 2001 caracteres no entran', async () => {
    await expect(
      aftercare.send({ practice_id: A.practice, texto: '   ' }, ana, key('msg-vacio')),
    ).rejects.toMatchObject({ code: 'mensaje_vacio' });
    await expect(
      aftercare.send({ practice_id: A.practice, texto: 'x'.repeat(2001) }, ana, key('msg-largo')),
    ).rejects.toMatchObject({ code: 'mensaje_demasiado_largo' });
  });

  it('un vínculo revocado cierra el chat', async () => {
    await owner.query(`update patient_link set status = 'revocada' where patient_id = $1`, [
      A.otherPatient,
    ]);
    // «Ese chat está cerrado»: un vínculo revocado tiene su propio código, distinto de
    // «todavía no aceptaste», que manda a otra pantalla.
    await expect(
      aftercare.send({ practice_id: A.other, texto: 'hola' }, ana, key('msg-revocado')),
    ).rejects.toMatchObject({ code: 'vinculo_revocado' });
    await owner.query(`update patient_link set status = 'vinculada' where patient_id = $1`, [
      A.otherPatient,
    ]);
  });

  it('el token es por dispositivo: registrar dos veces refresca, no duplica', async () => {
    await aftercare.registerDevice(
      { token: 'tok-1', plataforma: 'ios', device_id: 'telefono', version_app: '2.4.1' },
      ana,
    );
    await aftercare.registerDevice(
      { token: 'tok-2', plataforma: 'ios', device_id: 'telefono', version_app: '2.4.2' },
      ana,
    );
    await aftercare.registerDevice(
      { token: 'tok-3', plataforma: 'ios', device_id: 'tableta', version_app: '2.4.2' },
      ana,
    );

    const { rows } = await owner.query<{ device_id: string; token: string }>(
      `select device_id, token from device where account_id = $1 order by device_id`,
      [A.account],
    );
    // Dos dispositivos, no tres filas: una doctora con teléfono y tableta recibe en los dos.
    expect(rows).toEqual([
      { device_id: 'tableta', token: 'tok-3' },
      { device_id: 'telefono', token: 'tok-2' },
    ]);

    await expect(aftercare.forgetDevice('telefono', ana)).resolves.toMatchObject({
      olvidado: true,
    });
  });

  it('las preferencias nacen encendidas y se guardan campo por campo', async () => {
    const first = (await aftercare.preferences(ana)) as Record<string, unknown>;
    expect(first).toMatchObject({
      recordatorios_de_cita: true,
      recordatorios_de_cuidados: true,
      promociones: true,
    });

    const saved = (await aftercare.savePreferences(
      { promociones: false, silencio_desde: '22:00', silencio_hasta: '07:00' },
      ana,
    )) as Record<string, unknown>;
    expect(saved).toMatchObject({
      promociones: false,
      // Lo que no se nombró no se tocó: un recordatorio de cita no es marketing.
      recordatorios_de_cita: true,
      silencio_desde: '22:00',
      silencio_hasta: '07:00',
    });
  });
});

describe('lo que el 29 de octubre de 2026 dejó de perderse', () => {
  it('reintentar una incidencia con la misma clave no la duplica', async () => {
    const body = {
      session_id: session,
      que_pasa: 'Me salió una roncha donde el pinchazo.',
      gravedad_percibida: 'me_preocupa',
    };
    const first = (await aftercare.reportIncident(body, ana, key('inc-retry'))) as { id: string };
    // La app reintenta porque la respuesta se perdió, que es lo que el diseño le pide hacer.
    const again = (await aftercare.reportIncident(body, ana, key('inc-retry'))) as { id: string };

    // El MISMO cuerpo, no un segundo reporte en la pantalla de la urgencia.
    expect(again).toEqual(first);
    const { rows } = await owner.query<{ n: string }>(
      `select count(*)::text as n from incident where what = $1`,
      [body.que_pasa],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('reintentar un mensaje con la misma clave no lo duplica', async () => {
    const body = { practice_id: A.practice, texto: '¿Puedo mojarme la cara hoy?' };
    const first = (await aftercare.send(body, ana, key('msg-retry'))) as { id: string };
    const again = (await aftercare.send(body, ana, key('msg-retry'))) as { id: string };
    expect(again).toEqual(first);

    const { rows } = await owner.query<{ n: string }>(
      `select count(*)::text as n from message where body = $1`,
      [body.texto],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('una gravedad o un permiso que el servidor no reconoce es un 400, no un valor por omisión', async () => {
    // Una versión de la app que manda `grave` —que no está en la lista— guardaba `leve` y no
    // lo mencionaba. Es el dato que ordena la pantalla de urgencias.
    await expect(
      aftercare.reportIncident(
        { session_id: session, que_pasa: 'Duele mucho.', gravedad_percibida: 'grave' },
        ana,
        key('inc-grave'),
      ),
    ).rejects.toMatchObject({ code: 'gravedad_desconocida' });

    await expect(
      aftercare.registerDevice(
        { device_id: 'dev-x', token: 'tok-x', plataforma: 'ios', permiso: 'quizas' },
        ana,
      ),
    ).rejects.toMatchObject({ code: 'permiso_desconocido' });
  });

  it('leer el hilo no lo crea: un GET no escribe', async () => {
    // Una ficha sin hilo todavía: leerlo devuelve el hilo vacío y NO inserta la fila.
    const { rows: made } = await owner.query<{ id: string }>(
      `insert into patient (practice_id, first_name, last_name, birth_date, email, how_arrived)
       values ($1, 'Sin', 'Hilo', '1995-05-05', 'sinhilo@tramo7.local', 'instagram')
       returning id`,
      [A.practice],
    );
    const patient = made[0]!.id;

    const empty = (await aftercare.messages(
      { patient_id: patient },
      doctor(A.practice, A.doctor),
    )) as { hilo: { id: string | null }; mensajes: unknown[] };
    expect(empty.hilo.id).toBeNull();
    expect(empty.mensajes).toEqual([]);

    const { rows } = await owner.query<{ n: string }>(
      `select count(*)::text as n from message_thread where patient_id = $1`,
      [patient],
    );
    expect(rows[0]?.n).toBe('0');

    // Y escribir sí lo crea: el hilo nace cuando alguna de las dos tiene algo que decir.
    await aftercare.send(
      { patient_id: patient, texto: 'Te escribo por tu control.' },
      doctor(A.practice, A.doctor),
      key('msg-nace'),
    );
    const { rows: after } = await owner.query<{ n: string }>(
      `select count(*)::text as n from message_thread where patient_id = $1`,
      [patient],
    );
    expect(after[0]?.n).toBe('1');
  });
});
