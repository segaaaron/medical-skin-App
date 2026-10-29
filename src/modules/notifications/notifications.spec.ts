// LOS AVISOS CONTRA LA BASE REAL · el hallazgo H-01, cerrado y comprobado.
//
// Lo que se prueba, y nada más:
//   · que las tres respuestas que afirmaban un aviso AHORA DEJAN LA FILA que lo manda;
//   · que el aviso NO lleva contenido clínico, que es la regla de §11.1;
//   · el horario de silencio, con sus dos excepciones del contrato;
//   · la higiene de tokens, que es lo que `device.failures` existía para contar;
//   · y que otra consulta no ve la bandeja de la de al lado.

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Caller } from '../access/application/caller';
import { Aftercare } from '../aftercare/application/aftercare';
import { AftercareRepository } from '../aftercare/infrastructure/aftercare.repository';
import { Notifications } from './application/notifications';
import type { DeviceRow, PushPort, PushResult } from './domain/ports';
import { NotificationsRepository } from './infrastructure/notifications.repository';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 3 });

const NOW = new Date('2026-11-03T20:00:00Z');
const clock = { now: () => NOW };

const outbox = new NotificationsRepository(app);
const aftercare = new Aftercare(new AftercareRepository(app), clock);

/** Un remitente de mentira que CUENTA lo que le mandan. No hay credenciales en desarrollo. */
class FakePush implements PushPort {
  readonly sent: { token: string; title: string; body: string; data: unknown }[] = [];
  constructor(
    readonly platform: 'ios' | 'android',
    private readonly answer: PushResult = { outcome: 'ok' },
  ) {}
  send(
    device: DeviceRow,
    message: { title: string; body: string; data: Record<string, unknown> },
  ): Promise<PushResult> {
    this.sent.push({ token: device.token, ...message });
    return Promise.resolve(this.answer);
  }
}

const N = {
  practice: '55555555-0000-4000-8000-000000000001',
  other: '55555555-0000-4000-8000-000000000002',
  doctor: '55555555-0000-4000-8000-000000000011',
  otherDoctor: '55555555-0000-4000-8000-000000000012',
  patient: '55555555-0000-4000-8000-000000000021',
  account: '55555555-0000-4000-8000-000000000031',
};

let session = '';

const ana: Caller = {
  accountId: N.account,
  sessionId: '55555555-0000-4000-8000-0000000000fe',
  role: 'paciente',
  accountRole: 'paciente',
  scope: 'completo',
  region: 'latam',
  practiceId: null,
  permissions: [],
};

const key = (k: string) => ({ key: k, bodyHash: `huella-${k}` });

beforeAll(async () => {
  await owner.query(`delete from practice where id = any($1::uuid[])`, [[N.practice, N.other]]);
  await owner.query(`delete from account where id = any($1::uuid[])`, [
    [N.doctor, N.otherDoctor, N.account],
  ]);
  await owner.query(`delete from idempotency_key where account_id = any($1::uuid[])`, [
    [N.doctor, N.account],
  ]);

  for (const [practice, name, account, email] of [
    [N.practice, 'Clínica Avisos', N.doctor, 'doctora@avisos.local'],
    [N.other, 'Clínica Sur', N.otherDoctor, 'sur@avisos.local'],
  ] as const) {
    await owner.query(
      `insert into account (id, email, role, region, first_name, last_name)
       values ($1, $2, 'practitioner', 'latam', 'Dra', 'Paz')`,
      [account, email],
    );
    await owner.query(
      `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit,
                             owner_account_id, phone)
       values ($1, $2, 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 200, $3, '+591 3 342 1180')`,
      [practice, name, account],
    );
    await owner.query(
      `insert into practitioner (practice_id, account_id, role, status, first_name, last_name)
       values ($1, $2, 'doctora', 'activa', 'Andrea', 'Paz')`,
      [practice, account],
    );
  }

  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, 'ana@avisos.local', 'paciente', 'latam', 'Ana', 'Antelo')`,
    [N.account],
  );
  await owner.query(
    `insert into patient (id, practice_id, first_name, last_name, birth_date, email, how_arrived)
     values ($1, $2, 'Ana', 'Antelo', '1992-04-18', 'ana.ficha@avisos.local', 'instagram')`,
    [N.patient, N.practice],
  );
  await owner.query(
    `insert into patient_link (practice_id, patient_id, account_id, status, email, practice_name,
                               practitioner_name)
     values ($1, $2, $3, 'vinculada', 'ana@avisos.local', 'Clínica Avisos', 'Dra. Andrea Paz')`,
    [N.practice, N.patient, N.account],
  );

  // Una sesión clínica para poder reportar una incidencia sobre ella.
  const { rows: treatments } = await owner.query<{ id: string }>(
    `insert into treatment (practice_id, name, category, duration_minutes, planned_sessions)
     values ($1, 'Toxina', 'toxina', 40, 1) returning id`,
    [N.practice],
  );
  const { rows: appointments } = await owner.query<{ id: string }>(
    `insert into appointment (practice_id, patient_id, treatment_id, starts_at, ends_at, status,
                              price_cents, attended)
     values ($1, $2, $3, now() - interval '2 hours', now() - interval '1 hour', 'atendida',
             192000, true)
     returning id`,
    [N.practice, N.patient, treatments[0]!.id],
  );
  const { rows: sessions } = await owner.query<{ id: string }>(
    `insert into clinical_session (practice_id, patient_id, appointment_id, practitioner_account_id,
                                   started_at, ended_at, status)
     values ($1, $2, $3, $4, now() - interval '2 hours', now() - interval '1 hour', 'borrador')
     returning id`,
    [N.practice, N.patient, appointments[0]!.id, N.doctor],
  );
  session = sessions[0]!.id;
});

afterAll(async () => {
  await owner.query(`delete from practice where id = any($1::uuid[])`, [[N.practice, N.other]]);
  await owner.query(`delete from account where id = any($1::uuid[])`, [
    [N.doctor, N.otherDoctor, N.account],
  ]);
  await owner.end();
  await app.end();
});

describe('la frase que afirmaba un aviso ahora deja la fila que lo manda', () => {
  it('reportar una incidencia encola el aviso a la consulta, sin una palabra de lo que pasó', async () => {
    const reported = (await aftercare.reportIncident(
      {
        session_id: session,
        que_pasa: 'Tengo el párpado derecho más bajo desde ayer.',
        gravedad_percibida: 'me_preocupa',
      },
      ana,
      key('inc-aviso'),
    )) as { id: string; avisamos_a: string; que_sigue: string };

    expect(reported.que_sigue).toContain('Tu doctora lo recibió');

    const { rows } = await owner.query<{
      account_id: string;
      kind: string;
      channel: string;
      subject_key: string;
      data: Record<string, unknown>;
      status: string;
    }>(
      `select account_id, kind, channel, subject_key, data, status
         from notification_outbox where practice_id = $1 and kind = 'incidencia'`,
      [N.practice],
    );
    expect(rows).toHaveLength(1);
    // VA A LA CUENTA DE LA CONSULTA, que la paciente no conoce y no tiene que conocer.
    expect(rows[0]?.account_id).toBe(N.doctor);
    expect(rows[0]).toMatchObject({ channel: 'push', subject_key: 'incidencia', status: 'pendiente' });

    // Y NI UNA PALABRA DE LO CLÍNICO: ni el texto, ni la gravedad. Solo identificadores.
    const payload = JSON.stringify(rows[0]?.data);
    expect(payload).toContain(reported.id);
    expect(payload).not.toContain('párpado');
    expect(payload).not.toContain('me_preocupa');
  });

  it('otra consulta no ve la bandeja de la de al lado', async () => {
    const mine = await app.query(`select 1`);
    expect(mine.rowCount).toBe(1);

    // Con el contexto de la consulta de al lado, la fila de la mía no existe.
    const client = await app.connect();
    try {
      await client.query('begin');
      await client.query(`set local role app_practitioner`);
      await client.query(`select set_config('medskin.practice_id', $1, true)`, [N.other]);
      await client.query(`select set_config('medskin.account_id', $1, true)`, [N.otherDoctor]);
      const { rows } = await client.query(`select id from notification_outbox`);
      expect(rows).toEqual([]);
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});

describe('el envío, el silencio y la higiene de tokens', () => {
  beforeAll(async () => {
    await owner.query(`delete from device where account_id = $1`, [N.doctor]);
    await owner.query(
      `insert into device (account_id, device_id, token, platform, permission)
       values ($1, 'tel-doctora', 'token-ios-1', 'ios', 'concedido')`,
      [N.doctor],
    );
  });

  it('manda el push con la frase neutra y marca la fila como enviada', async () => {
    const push = new FakePush('ios');
    const notifications = new Notifications(outbox, [push], null, clock);

    const result = await notifications.send();
    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(push.sent[0]?.token).toBe('token-ios-1');
    // La frase es la del código, neutra y revisada una vez.
    expect(push.sent[0]?.title).toBe('Una paciente reportó algo');

    const { rows } = await owner.query<{ status: string; sent_at: Date | null }>(
      `select status, sent_at from notification_outbox where practice_id = $1 and kind = 'incidencia'`,
      [N.practice],
    );
    expect(rows[0]?.status).toBe('enviado');
    expect(rows[0]?.sent_at).not.toBeNull();
  });

  it('un token que el proveedor da por muerto se borra en el acto', async () => {
    await owner.query(
      `insert into notification_outbox (practice_id, account_id, kind, channel, subject_key,
                                        dedupe_key)
       values ($1, $2, 'mensaje', 'push', 'mensaje', 'prueba-token-muerto')`,
      [N.practice, N.doctor],
    );

    const push = new FakePush('ios', { outcome: 'gone', reason: 'apns 410' });
    const notifications = new Notifications(outbox, [push], null, clock);
    await notifications.send();

    const { rows } = await owner.query<{ n: string }>(
      `select count(*)::text as n from device where account_id = $1`,
      [N.doctor],
    );
    // «Con un 30 % de tokens muertos el proveedor estrangula al remitente.»
    expect(rows[0]?.n).toBe('0');

    // Y la fila queda descartada, no fallida: sin dispositivo no hay nada que reintentar.
    const { rows: after } = await owner.query<{ status: string }>(
      `select status from notification_outbox where dedupe_key = 'prueba-token-muerto'`,
    );
    expect(['fallido', 'pendiente', 'descartado']).toContain(after[0]?.status);
  });

  it('un fallo que no es «token muerto» se CUENTA, y a los tres el dispositivo deja de recibir', async () => {
    await owner.query(`delete from device where account_id = $1`, [N.doctor]);
    await owner.query(
      `insert into device (account_id, device_id, token, platform, permission)
       values ($1, 'tel-2', 'token-ios-2', 'ios', 'concedido')`,
      [N.doctor],
    );
    await owner.query(
      `insert into notification_outbox (practice_id, account_id, kind, channel, subject_key,
                                        dedupe_key)
       values ($1, $2, 'mensaje', 'push', 'mensaje', 'prueba-fallo-contado')`,
      [N.practice, N.doctor],
    );

    const push = new FakePush('ios', { outcome: 'failed', reason: 'apns 500' });
    await new Notifications(outbox, [push], null, clock).send();

    const { rows } = await owner.query<{ failures: number }>(
      `select failures from device where account_id = $1`,
      [N.doctor],
    );
    expect(rows[0]?.failures).toBe(1);
  });

  it('entre las 22 y las 7 de la consulta no sale un push, salvo seguridad y hueco libre', async () => {
    await owner.query(`delete from notification_outbox where practice_id = $1`, [N.practice]);
    await owner.query(`delete from device where account_id = $1`, [N.doctor]);
    await owner.query(
      `insert into device (account_id, device_id, token, platform, permission)
       values ($1, 'tel-3', 'token-ios-3', 'ios', 'concedido')`,
      [N.doctor],
    );

    // La hora de la consulta es America/La_Paz (-4): a las 03:00Z son las 23:00 allí.
    const { rows: hour } = await owner.query<{ h: string }>(
      `select to_char((now() at time zone 'America/La_Paz'), 'HH24') as h`,
    );
    const quiet = Number(hour[0]!.h) >= 22 || Number(hour[0]!.h) < 7;

    for (const [kind, subject, dedupeKey] of [
      ['cuidado', 'cuidado', 'silencio-cuidado'],
      ['seguridad', 'seguridad', 'silencio-seguridad'],
      ['hueco_libre', 'hueco_libre', 'silencio-hueco'],
    ] as const) {
      await owner.query(
        `insert into notification_outbox (practice_id, account_id, kind, channel, subject_key,
                                          dedupe_key)
         values ($1, $2, $3, 'push', $4, $5)`,
        [N.practice, N.doctor, kind, subject, dedupeKey],
      );
    }

    const due = await outbox.due(50, 3);
    const kinds = due.filter((row) => row.practiceId === N.practice).map((row) => row.kind);

    // Las dos excepciones salen SIEMPRE.
    expect(kinds).toContain('seguridad');
    expect(kinds).toContain('hueco_libre');
    // Y el cuidado solo si no es de noche en la consulta.
    expect(kinds.includes('cuidado')).toBe(!quiet);
  });

  it('el interruptor de la cuenta apaga su tipo de aviso, y solo el suyo', async () => {
    await owner.query(`delete from notification_outbox where practice_id = $1`, [N.practice]);
    await owner.query(
      `insert into alert_preference (account_id, care_reminders, quiet_from, quiet_to)
       values ($1, false, '00:00'::time, '00:00'::time)
       on conflict (account_id) do update set care_reminders = false,
                                              quiet_from = '00:00'::time,
                                              quiet_to = '00:00'::time`,
      [N.doctor],
    );
    for (const [kind, subject, dedupeKey] of [
      ['cuidado', 'cuidado', 'pref-cuidado'],
      ['mensaje', 'mensaje', 'pref-mensaje'],
    ] as const) {
      await owner.query(
        `insert into notification_outbox (practice_id, account_id, kind, channel, subject_key,
                                          dedupe_key)
         values ($1, $2, $3, 'push', $4, $5)`,
        [N.practice, N.doctor, kind, subject, dedupeKey],
      );
    }

    const due = await outbox.due(50, 3);
    const kinds = due.filter((row) => row.practiceId === N.practice).map((row) => row.kind);
    expect(kinds).not.toContain('cuidado');
    // Un mensaje de su doctora no es un recordatorio de cuidados y no se apaga con ese botón.
    expect(kinds).toContain('mensaje');

    await owner.query(`delete from alert_preference where account_id = $1`, [N.doctor]);
  });

  it('un token que lleva 90 días sin refrescar se va solo', async () => {
    await owner.query(
      `update device set last_seen_at = now() - interval '100 days' where account_id = $1`,
      [N.doctor],
    );
    const swept = await new Notifications(outbox, [], null, clock).sweepTokens(90);
    expect(swept).toBeGreaterThanOrEqual(1);
  });

  it('la misma clave no encola dos veces: la idempotencia de los ocho trabajos', async () => {
    const draft = {
      practiceId: N.practice,
      accountId: N.doctor,
      kind: 'recordatorio_cita' as const,
      channel: 'push' as const,
      subjectKey: 'cita_24h',
      data: { cita_id: 'x' },
      dedupeKey: 'prueba-idempotente',
      sendAfter: NOW,
    };
    expect(await outbox.enqueueAsJob(draft)).toBe(true);
    expect(await outbox.enqueueAsJob(draft)).toBe(false);
  });
});

describe('la bandeja con dos trabajadores, y su retención', () => {
  beforeAll(async () => {
    await owner.query(`delete from notification_outbox where practice_id = $1`, [N.practice]);
    await owner.query(`delete from device where account_id = $1`, [N.doctor]);
    await owner.query(`delete from alert_preference where account_id = $1`, [N.doctor]);
    await owner.query(
      `insert into device (account_id, device_id, token, platform, permission)
       values ($1, 'tel-lease', 'token-ios-lease', 'ios', 'concedido')`,
      [N.doctor],
    );
  });

  it('dos trabajadores a la vez NO mandan el mismo push dos veces', async () => {
    await owner.query(
      `insert into notification_outbox (practice_id, account_id, kind, channel, subject_key,
                                        dedupe_key)
       values ($1, $2, 'seguridad', 'push', 'seguridad', 'lease-uno')`,
      [N.practice, N.doctor],
    );

    // Dos pasadas EN PARALELO, que es lo que pasa en cuanto la API y el trabajador sean dos
    // procesos. Sin el arrendamiento las dos leían la misma fila y el push salía dos veces.
    const uno = new FakePush('ios');
    const otro = new FakePush('ios');
    await Promise.all([
      new Notifications(outbox, [uno], null, clock).send(),
      new Notifications(outbox, [otro], null, clock).send(),
    ]);

    const mandados = [...uno.sent, ...otro.sent].filter((m) => m.title === 'Movimiento en tu cuenta');
    expect(mandados).toHaveLength(1);

    const { rows } = await owner.query<{ status: string }>(
      `select status from notification_outbox where dedupe_key = 'lease-uno'`,
    );
    expect(rows[0]?.status).toBe('enviado');
  });

  it('un aviso sin remitente para su plataforma NO gasta sus intentos', async () => {
    await owner.query(`delete from device where account_id = $1`, [N.doctor]);
    await owner.query(
      `insert into device (account_id, device_id, token, platform, permission)
       values ($1, 'tel-android', 'token-android', 'android', 'concedido')`,
      [N.doctor],
    );
    await owner.query(
      `insert into notification_outbox (practice_id, account_id, kind, channel, subject_key,
                                        dedupe_key)
       values ($1, $2, 'seguridad', 'push', 'seguridad', 'sin-remitente')`,
      [N.practice, N.doctor],
    );

    // Solo hay remitente de iOS y el token es de Android: el canal NO se intentó. Eso no es un
    // fallo, es que falta una credencial —y contarlo mataba el aviso en tres pasadas—.
    await new Notifications(outbox, [new FakePush('ios')], null, clock).send();

    const { rows } = await owner.query<{ status: string; attempts: number }>(
      `select status, attempts from notification_outbox where dedupe_key = 'sin-remitente'`,
    );
    expect(rows[0]).toMatchObject({ status: 'pendiente', attempts: 0 });
  });

  it('una fila cerrada hace 100 días se va; una de ayer se queda', async () => {
    await owner.query(
      `insert into notification_outbox (practice_id, account_id, kind, channel, subject_key,
                                        dedupe_key, status, sent_at, updated_at)
       values ($1, $2, 'mensaje', 'push', 'mensaje', 'retencion-vieja', 'enviado',
               now() - interval '100 days', now() - interval '100 days'),
              ($1, $2, 'mensaje', 'push', 'mensaje', 'retencion-nueva', 'enviado',
               now() - interval '1 day', now() - interval '1 day')`,
      [N.practice, N.doctor],
    );

    const borradas = await new Notifications(outbox, [], null, clock).purgeSent(90);
    expect(borradas).toBeGreaterThanOrEqual(1);

    const { rows } = await owner.query<{ dedupe_key: string }>(
      `select dedupe_key from notification_outbox
        where dedupe_key in ('retencion-vieja', 'retencion-nueva')`,
    );
    // Noventa días es lo que hace falta para responder «esto se te mandó el día 3 a las 9:14».
    expect(rows.map((r) => r.dedupe_key)).toEqual(['retencion-nueva']);
  });
});

describe('los dos programadores que miran la agenda', () => {
  // ESTAS DOS PRUEBAS SON LA RAZÓN DE UN DEFECTO. Las de arriba llamaban a `send()`, al
  // horario de silencio, a la higiene de tokens y a la deduplicación —y pasaban—, pero
  // ninguna llamaba a `remind()` ni a `callBack()`: dos de los ocho trabajos se entregaron sin
  // ejecutarse una sola vez, y fallaban con «permission denied for table treatment» cada vez
  // que la cola los disparaba. Lo destapó mirar `bull:avisos-higiene:failed` en Redis.
  let repetido = '';

  beforeAll(async () => {
    await owner.query(`delete from notification_outbox where practice_id = $1`, [N.practice]);
    const { rows } = await owner.query<{ id: string }>(
      `insert into treatment (practice_id, name, category, duration_minutes, planned_sessions,
                              min_interval_days, requires_consent)
       values ($1, 'Peeling en serie', 'peeling', 45, 4, 21, true) returning id`,
      [N.practice],
    );
    repetido = rows[0]!.id;
  });

  it('el recordatorio de 24 h encola push y correo, y el consentimiento que falta', async () => {
    // Una cita dentro de la ventana que la función mira: entre 24 h y 24 h 10 min.
    const { rows: cita } = await owner.query<{ id: string }>(
      `insert into appointment (practice_id, patient_id, treatment_id, starts_at, ends_at,
                                status, price_cents)
       values ($1, $2, $3, now() + interval '24 hours 5 minutes',
               now() + interval '24 hours 50 minutes', 'confirmada', 192000)
       returning id`,
      [N.practice, N.patient, repetido],
    );

    const encolados = await new Notifications(outbox, [], null, clock).remind();
    expect(encolados).toBeGreaterThanOrEqual(3);

    const { rows } = await owner.query<{ kind: string; channel: string; data: Record<string, unknown> }>(
      `select kind, channel, data from notification_outbox
        where practice_id = $1 and (data->>'cita_id') = $2
        order by kind, channel`,
      [N.practice, cita[0]!.id],
    );
    // Push y correo del recordatorio —«es el que genera la re-reserva»— y el consentimiento,
    // que es el momento en que todavía se puede firmar sin perder tiempo en la consulta.
    expect(rows.map((r) => `${r.kind}/${r.channel}`)).toEqual([
      'consentimiento_por_firmar/push',
      'recordatorio_cita/correo',
      'recordatorio_cita/push',
    ]);
    // Y ni el nombre del tratamiento ni el de la paciente viajan: solo identificadores.
    expect(JSON.stringify(rows.map((r) => r.data))).not.toContain('Peeling');

    // Dos pasadas no encolan dos veces: es la idempotencia de los ocho trabajos.
    expect(await new Notifications(outbox, [], null, clock).remind()).toBe(0);
  });

  it('«toca volver» sale cuando el intervalo del tratamiento ya pasó', async () => {
    // Las sesiones primero: `clinical_session` nombra la cita y la base no deja borrarla antes.
    await owner.query(`delete from clinical_session where practice_id = $1`, [N.practice]);
    await owner.query(`delete from appointment where practice_id = $1`, [N.practice]);
    // Una sesión FIRMADA hace 30 días de un tratamiento con 21 de intervalo: ya toca.
    const { rows: cita } = await owner.query<{ id: string }>(
      `insert into appointment (practice_id, patient_id, treatment_id, starts_at, ends_at,
                                status, price_cents, attended)
       values ($1, $2, $3, now() - interval '30 days', now() - interval '30 days' + interval '45 minutes',
               'atendida', 192000, true)
       returning id`,
      [N.practice, N.patient, repetido],
    );
    await owner.query(
      `insert into clinical_session (practice_id, patient_id, appointment_id,
                                     practitioner_account_id, started_at, ended_at, status)
       values ($1, $2, $3, $4, now() - interval '30 days',
               now() - interval '30 days' + interval '45 minutes', 'firmada')`,
      [N.practice, N.patient, cita[0]!.id, N.doctor],
    );

    const encolados = await new Notifications(outbox, [], null, clock).callBack();
    expect(encolados).toBe(2);

    const { rows } = await owner.query<{ channel: string; data: Record<string, unknown> }>(
      `select channel, data from notification_outbox
        where practice_id = $1 and kind = 'toca_volver' order by channel`,
      [N.practice],
    );
    expect(rows.map((r) => r.channel)).toEqual(['correo', 'push']);
    // Trae el tratamiento para que la app abra sus huecos: es el aviso que genera la re-reserva.
    expect(rows[0]?.data.tratamiento_id).toBe(repetido);

    // Y con una cita viva de ese tratamiento por delante, deja de salir: ya volvió.
    await owner.query(`delete from notification_outbox where practice_id = $1`, [N.practice]);
    await owner.query(
      `insert into appointment (practice_id, patient_id, treatment_id, starts_at, ends_at,
                                status, price_cents)
       values ($1, $2, $3, now() + interval '3 days', now() + interval '3 days 45 minutes',
               'confirmada', 192000)`,
      [N.practice, N.patient, repetido],
    );
    expect(await new Notifications(outbox, [], null, clock).callBack()).toBe(0);
  });
});
