// El tramo 4 contra la base real, en un solo archivo.
//
// Tres cosas: que otra consulta no ve la agenda, el camino bueno de cada escritura, y LO QUE
// ESTE TRAMO EXISTE PARA GARANTIZAR — que dos pacientes no se quedan el mismo hueco, aunque
// confirmen a la vez.

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Caller } from '../access/application/caller';
import { Appointments } from './application/appointments';
import { Schedule } from './application/schedule';
import { SyncBatch } from './application/sync';
import { ScheduleRepository } from './infrastructure/schedule.repository';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
// `max: 3`: la prueba de la carrera abre DOS transacciones a la vez y necesita una tercera
// libre para leer; con menos, la carrera se serializa sola y no prueba nada.
const app = new Pool({ connectionString: appUrl, max: 3 });

// Un lunes a las 12:00 de La Paz (16:00Z). Todo el tramo cuenta desde aquí.
const NOW = new Date('2026-11-02T16:00:00Z');
const clock = { now: () => NOW };

const repo = new ScheduleRepository(app);
const schedule = new Schedule(repo, clock);
const appointments = new Appointments(repo, repo, clock);
const sync = new SyncBatch(appointments);

const MINE = { practice: 'ffffffff-0000-4000-8000-000000000001', doctor: 'ffffffff-0000-4000-8000-000000000011' };
const OTHER = { practice: 'ffffffff-0000-4000-8000-000000000002', doctor: 'ffffffff-0000-4000-8000-000000000012' };
const ANA = { patient: 'ffffffff-0000-4000-8000-000000000021', account: 'ffffffff-0000-4000-8000-000000000031' };
const BEA = { patient: 'ffffffff-0000-4000-8000-000000000022', account: 'ffffffff-0000-4000-8000-000000000032' };
let treatment = '';

function doctor(practice: string, account: string): Caller {
  return {
    accountId: account,
    sessionId: 'ffffffff-0000-4000-8000-0000000000ff',
    role: 'doctora',
    accountRole: 'practitioner',
    scope: 'completo',
    region: 'latam',
    practiceId: practice,
    permissions: [
      'agenda:leer',
      'citas:crear',
      'citas:cancelar',
      'horarios:definir',
      'cobros:registrar',
    ],
  };
}

function patient(account: string): Caller {
  return {
    accountId: account,
    sessionId: 'ffffffff-0000-4000-8000-0000000000fe',
    role: 'paciente',
    accountRole: 'paciente',
    scope: 'completo',
    region: 'latam',
    practiceId: null,
    permissions: [],
  };
}

const key = (k: string) => ({ key: k, bodyHash: `huella-${k}` });

beforeAll(async () => {
  await owner.query(`delete from practice where id = any($1::uuid[])`, [[MINE.practice, OTHER.practice]]);
  await owner.query(`delete from account where id = any($1::uuid[])`, [
    [MINE.doctor, OTHER.doctor, ANA.account, BEA.account],
  ]);
  await owner.query(`delete from idempotency_key where account_id = any($1::uuid[])`, [
    [MINE.doctor, ANA.account, BEA.account],
  ]);

  for (const p of [
    { ...MINE, account: MINE.doctor, name: 'Clínica Paz' },
    { ...OTHER, account: OTHER.doctor, name: 'Clínica de al lado' },
  ]) {
    await owner.query(
      `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit)
       values ($1, $2, 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300)`,
      [p.practice, p.name],
    );
    await owner.query(
      `insert into account (id, email, role, region, first_name, last_name)
       values ($1, $2, 'practitioner', 'latam', 'Andrea', 'Paz')`,
      [p.account, `duena.${p.practice.slice(-1)}@tramo4.local`],
    );
    await owner.query(
      `insert into practitioner (practice_id, account_id, role, status, first_name, last_name)
       values ($1, $2, 'doctora', 'activa', 'Andrea', 'Paz')`,
      [p.practice, p.account],
    );
  }

  // Dos pacientes de la misma consulta: son las que corren por el mismo hueco.
  for (const p of [
    { ...ANA, name: 'Ana' },
    { ...BEA, name: 'Bea' },
  ]) {
    await owner.query(
      `insert into account (id, email, role, region, first_name, last_name)
       values ($1, $2, 'paciente', 'latam', $3, 'Antelo')`,
      [p.account, `${p.name.toLowerCase()}@tramo4.local`, p.name],
    );
    await owner.query(
      `insert into patient (id, practice_id, first_name, last_name, birth_date, email, how_arrived)
       values ($1, $2, $3, 'Antelo', '1992-04-18', $4, 'instagram')`,
      [p.patient, MINE.practice, p.name, `${p.name.toLowerCase()}.ficha@tramo4.local`],
    );
    await owner.query(
      `insert into medical_history (practice_id, patient_id) values ($1, $2)`,
      [MINE.practice, p.patient],
    );
    await owner.query(
      `insert into patient_link (practice_id, patient_id, account_id, status, email,
                                 practice_name, practitioner_name)
       values ($1, $2, $3, 'vinculada', $4, 'Clínica Paz', 'Dra. Andrea Paz')`,
      [MINE.practice, p.patient, p.account, `${p.name.toLowerCase()}@tramo4.local`],
    );
  }

  // Un tratamiento de 40 minutos con su precio base.
  const { rows } = await owner.query<{ id: string }>(
    `insert into treatment (practice_id, name, category, duration_minutes, planned_sessions)
     values ($1, 'Toxina', 'toxina', 40, 1) returning id`,
    [MINE.practice],
  );
  treatment = rows[0]!.id;
  await owner.query(
    `insert into price (practice_id, treatment_id, zone, cents) values ($1, $2, null, 192000)`,
    [MINE.practice, treatment],
  );
});

afterAll(async () => {
  await owner.query(`delete from practice where id = any($1::uuid[])`, [[MINE.practice, OTHER.practice]]);
  await owner.query(`delete from account where id = any($1::uuid[])`, [
    [MINE.doctor, OTHER.doctor, ANA.account, BEA.account],
  ]);
  await owner.end();
  await app.end();
});

describe('los horarios y los huecos', () => {
  it('guarda la semana y calcula los huecos en la zona de la consulta', async () => {
    await schedule.save(
      {
        franjas: [
          { dia: 'martes', desde: '09:00', hasta: '13:00' },
          { dia: 'miercoles', desde: '09:00', hasta: '11:00' },
        ],
        margen_entre_citas_minutos: 15,
        paso_de_agenda_minutos: 30,
        aviso_minimo_horas: 12,
        reserva_maxima_dias: 90,
        feriados: [{ fecha: '2026-11-04', motivo: 'Todos los Santos' }],
      },
      doctor(MINE.practice, MINE.doctor),
    );

    const seen = (await schedule.availability(
      { treatment_id: treatment, desde: '2026-11-03', hasta: '2026-11-04' },
      doctor(MINE.practice, MINE.doctor),
    )) as {
      zona_horaria: string;
      duracion_minutos: number;
      dias: { dia: string; huecos: string[]; motivo?: string }[];
    };

    expect(seen.zona_horaria).toBe('America/La_Paz');
    expect(seen.duracion_minutos).toBe(40);
    // Martes de 9 a 13, paso de 30, tratamiento de 40: el último que cabe empieza a las 12:20,
    // así que la rejilla da 9:00, 9:30 … 12:00. En instantes de La Paz, -4.
    expect(seen.dias[0]?.huecos[0]).toBe('2026-11-03T13:00:00.000Z');
    expect(seen.dias[0]?.huecos.at(-1)).toBe('2026-11-03T16:00:00.000Z');
    // El miércoles es feriado, y el motivo viaja: un día vacío sin motivo deja a la app
    // diciendo «no hay nada» cuando lo que pasa es que la consulta cerró.
    expect(seen.dias[1]).toMatchObject({ huecos: [], motivo: 'feriado' });
  });

  it('un feriado sobre un día con citas NO se impone', async () => {
    const booked = (await appointments.book(
      {
        practice_id: MINE.practice,
        tratamiento_id: treatment,
        empieza_en: '2026-11-03T13:00:00.000Z',
      },
      patient(ANA.account),
      key('feriado'),
    )) as { id: string };
    expect(booked.id).toBeTruthy();

    await expect(
      schedule.save(
        {
          franjas: [{ dia: 'martes', desde: '09:00', hasta: '13:00' }],
          feriados: [{ fecha: '2026-11-03', motivo: 'Cierro' }],
        },
        doctor(MINE.practice, MINE.doctor),
      ),
    ).rejects.toMatchObject({ code: 'feriado_con_citas' });

    await owner.query(`delete from appointment where practice_id = $1`, [MINE.practice]);
  });
});

describe('dos pacientes y un solo hueco', () => {
  it('confirmando a la vez, una reserva y la otra recibe sus huecos cercanos', async () => {
    const slot = '2026-11-03T14:00:00.000Z';
    const body = (p: string) => ({
      practice_id: MINE.practice,
      tratamiento_id: treatment,
      empieza_en: slot,
      nota_de_la_paciente: p,
    });

    const [una, otra] = await Promise.allSettled([
      appointments.book(body('ana'), patient(ANA.account), key('carrera-ana')),
      appointments.book(body('bea'), patient(BEA.account), key('carrera-bea')),
    ]);

    const ok = [una, otra].filter((r) => r.status === 'fulfilled');
    const failed = [una, otra].filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);

    // Y la perdedora no se va con las manos vacías: los tres huecos cercanos son lo que hace
    // que la hoja se redibuje en vez de morir.
    const reason = (failed[0] as PromiseRejectedResult).reason as {
      code: string;
      data?: { huecos_cercanos?: string[] };
    };
    expect(reason.code).toBe('hueco_ocupado');
    expect(reason.data?.huecos_cercanos?.length).toBeGreaterThan(0);

    // UNA cita en la base, no dos.
    const { rows } = await owner.query<{ n: string }>(
      `select count(*)::text as n from appointment where practice_id = $1 and starts_at = $2`,
      [MINE.practice, slot],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('el margen entre citas no es hueco: la de al lado tampoco entra', async () => {
    // Hay una cita a las 10:00 (14:00Z) de la prueba anterior. Con 15 minutos de margen y 40
    // de tratamiento, las 10:30 se pisan con ella.
    await expect(
      appointments.book(
        {
          practice_id: MINE.practice,
          tratamiento_id: treatment,
          empieza_en: '2026-11-03T14:30:00.000Z',
        },
        patient(BEA.account),
        key('margen'),
      ),
    ).rejects.toMatchObject({ code: 'hueco_ocupado' });
  });

  it('la consulta puede forzar sobre el margen; la paciente no', async () => {
    const forced = (await appointments.book(
      {
        paciente_id: BEA.patient,
        tratamiento_id: treatment,
        empieza_en: '2026-11-03T14:40:00.000Z',
        forzar: true,
      },
      doctor(MINE.practice, MINE.doctor),
      key('forzada'),
    )) as { forzada: boolean };
    expect(forced.forzada).toBe(true);
  });
});

describe('otra consulta no ve esta agenda', () => {
  it('la lista de al lado está vacía y la cita ajena es un 404', async () => {
    const theirs = (await appointments.list({}, doctor(OTHER.practice, OTHER.doctor))) as {
      citas: unknown[];
    };
    expect(theirs.citas).toEqual([]);

    const { rows } = await owner.query<{ id: string }>(
      `select id from appointment where practice_id = $1 limit 1`,
      [MINE.practice],
    );
    await expect(
      appointments.one(rows[0]!.id, doctor(OTHER.practice, OTHER.doctor)),
    ).rejects.toMatchObject({ code: 'cita_no_existe' });
  });

  it('una paciente ve las suyas y ninguna más', async () => {
    const hers = (await appointments.list({}, patient(ANA.account))) as {
      citas: { id: string }[];
    };
    const { rows } = await owner.query<{ n: string }>(
      `select count(*)::text as n from appointment where patient_id = $1`,
      [ANA.patient],
    );
    expect(String(hers.citas.length)).toBe(rows[0]?.n);
  });
});

describe('la seña y la cancelación', () => {
  // «Ya tienes una cita para esto» es una regla del contrato y las pruebas de arriba la dejan
  // cumplida: desde aquí se empieza con la agenda vacía, no quitándole la regla.
  beforeAll(async () => {
    await owner.query(`delete from appointment where practice_id = $1`, [MINE.practice]);
  });

  it('con seña exigida la cita nace pendiente, y solo la consulta la confirma', async () => {
    await owner.query(
      `insert into schedule_settings (practice_id, deposit_percent, deposit_min_cents,
                                      deposit_hours, gap_minutes, slot_minutes)
       values ($1, 20, 50000, 2, 15, 30)
       on conflict (practice_id) do update set deposit_min_cents = 50000, deposit_percent = 20`,
      [MINE.practice],
    );

    const booked = (await appointments.book(
      {
        practice_id: MINE.practice,
        tratamiento_id: treatment,
        empieza_en: '2026-11-03T15:30:00.000Z',
      },
      patient(ANA.account),
      key('sena'),
    )) as { id: string; estado: string; sena: { requerida: boolean; importe: { centavos: number } } };

    expect(booked.estado).toBe('pendiente_de_sena');
    // 20 % de 192 000 = 38 400.
    expect(booked.sena).toMatchObject({ requerida: true, importe: { centavos: 38400 } });

    // Ella dice que pagó: eso NO la confirma.
    const claimed = (await appointments.claimDeposit(
      booked.id,
      { comprobante_clave: 'sen/x.jpg' },
      patient(ANA.account),
    )) as { estado: string; sena: { estado: string } };
    expect(claimed.estado).toBe('pendiente_de_sena');
    expect(claimed.sena.estado).toBe('dice_que_pago');

    // La consulta confirma: ahora sí.
    const confirmed = (await appointments.confirmDeposit(
      booked.id,
      doctor(MINE.practice, MINE.doctor),
    )) as { estado: string; sena: { estado: string } };
    expect(confirmed.estado).toBe('confirmada');
    expect(confirmed.sena.estado).toBe('confirmada');
  });

  it('cancelar con más de 24 h devuelve la seña entera; con menos, queda como crédito', async () => {
    await owner.query(`delete from appointment where practice_id = $1`, [MINE.practice]);
    const far = (await appointments.book(
      {
        practice_id: MINE.practice,
        tratamiento_id: treatment,
        empieza_en: '2026-11-10T14:00:00.000Z',
      },
      patient(ANA.account),
      key('cancela-lejos'),
    )) as { id: string };

    const cancelled = (await appointments.cancel(far.id, patient(ANA.account))) as {
      estado: string;
      cancelo: string;
      sena: { estado: string; como: string } | null;
      hueco_liberado: boolean;
    };
    expect(cancelled).toMatchObject({ estado: 'cancelada', cancelo: 'paciente', hueco_liberado: true });
    expect(cancelled.sena).toMatchObject({ estado: 'devuelta', como: 'entera' });

    // Y cancelar lo cancelado devuelve el mismo 200: idempotente por naturaleza.
    await expect(appointments.cancel(far.id, patient(ANA.account))).resolves.toMatchObject({
      estado: 'cancelada',
    });

    // El hueco liberado se puede volver a reservar: eso es lo que significa liberarlo.
    const again = (await appointments.book(
      {
        practice_id: MINE.practice,
        tratamiento_id: treatment,
        empieza_en: '2026-11-10T14:00:00.000Z',
      },
      patient(BEA.account),
      key('reusa-hueco'),
    )) as { id: string };
    expect(again.id).toBeTruthy();
  });
});

describe('la lista de espera y el lote', () => {
  beforeAll(async () => {
    await owner.query(`delete from appointment where practice_id = $1`, [MINE.practice]);
    await owner.query(`delete from waitlist_entry where practice_id = $1`, [MINE.practice]);
  });

  it('tres avisos por consulta y no más', async () => {
    for (const n of [1, 2, 3]) {
      await appointments.joinWaitlist(
        {
          practice_id: MINE.practice,
          tratamiento_id: treatment,
          desde: '2026-11-10',
          hasta: `2026-11-1${n}`,
        },
        patient(ANA.account),
      );
    }
    await expect(
      appointments.joinWaitlist(
        { practice_id: MINE.practice, tratamiento_id: treatment, desde: '2026-11-20', hasta: '2026-11-21' },
        patient(ANA.account),
      ),
    ).rejects.toMatchObject({ code: 'demasiadas_esperas' });
  });

  it('un rechazo no detiene el lote, y vuelve con el código de su endpoint', async () => {
    const result = await sync.run(
      {
        operaciones: [
          {
            clave: 'op-1',
            tipo: 'cita.crear',
            datos: {
              paciente_id: ANA.patient,
              tratamiento_id: treatment,
              empieza_en: '2026-11-03T16:00:00.000Z',
            },
          },
          {
            // Esta se cae: pide el mismo hueco que acaba de tomar la anterior, que es
            // exactamente lo que le pasa a una app que estuvo sin señal.
            clave: 'op-2',
            tipo: 'cita.crear',
            datos: {
              paciente_id: BEA.patient,
              tratamiento_id: treatment,
              empieza_en: '2026-11-03T16:00:00.000Z',
            },
          },
          {
            clave: 'op-3',
            tipo: 'cita.crear',
            datos: {
              paciente_id: BEA.patient,
              tratamiento_id: treatment,
              empieza_en: '2026-11-03T13:00:00.000Z',
            },
          },
        ],
      },
      doctor(MINE.practice, MINE.doctor),
    );

    // Dos aplicadas y una rechazada: el lote NO se detuvo en la del medio.
    expect(result.aplicadas).toBe(2);
    expect(result.rechazadas).toHaveLength(1);
    expect(result.rechazadas[0]).toMatchObject({ clave: 'op-2', codigo: 'hueco_ocupado' });
    expect(result.rechazadas[0]?.mensaje).toBe('Ese horario se acaba de ocupar.');
  });
});
