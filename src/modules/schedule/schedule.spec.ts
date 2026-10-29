// El tramo 4 contra la base real, en un solo archivo.
//
// Tres cosas: que otra consulta no ve la agenda, el camino bueno de cada escritura, y LO QUE
// ESTE TRAMO EXISTE PARA GARANTIZAR — que dos pacientes no se quedan el mismo hueco, aunque
// confirmen a la vez.

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Caller } from '../access/application/caller';
import { Appointments } from './application/appointments';
import { Schedule, asText } from './application/schedule';
import { SyncBatch } from './application/sync';
import { IdempotencyGuard } from '../../shared/idempotency/idempotency-guard';
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
const sync = new SyncBatch(appointments, new IdempotencyGuard(app));

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
      'horarios:leer',
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

  it('un número que no es un número es un 400, no un NaN camino de la base', async () => {
    // `Number("x")` daba `NaN`, `NaN` iba a una columna `integer` y el 500 lo escribía
    // Postgres: el error de forma de este endpoint lo decidía la base.
    await expect(
      schedule.save(
        { franjas: [], margen_entre_citas_minutos: 'x' },
        doctor(MINE.practice, MINE.doctor),
      ),
    ).rejects.toMatchObject({ code: 'numero_fuera_de_rango' });

    // Y un número fuera de rango tampoco: un margen de ocho horas no es un margen.
    await expect(
      schedule.save(
        { franjas: [], margen_entre_citas_minutos: 480 },
        doctor(MINE.practice, MINE.doctor),
      ),
    ).rejects.toMatchObject({ code: 'numero_fuera_de_rango' });
  });

  it('una nota de cita de un megabyte no entra en la base', async () => {
    // El único tope era el megabyte del cuerpo de Fastify. Cien notas así son cien megabytes
    // de disco en una VPS de dos gigas.
    await expect(
      owner.query(
        `insert into appointment (practice_id, patient_id, treatment_id, starts_at, ends_at,
                                  status, price_cents, patient_note)
         values ($1, $2, $3, now() + interval '40 days', now() + interval '40 days 30 minutes',
                 'confirmada', 0, $4)`,
        [MINE.practice, ANA.patient, treatment, 'x'.repeat(2001)],
      ),
    ).rejects.toThrow(/appointment_note_len_ck/);
  });

  it('y por el BORDE da un 400 con su frase, no el 500 del CHECK', async () => {
    // La prueba de arriba escribe con el dueño: comprueba el `CHECK` y no el camino de la app.
    // Por el camino de la app, el `CHECK` que salta es una excepción de `pg` —un 500— y lo que
    // la paciente tiene que leer es «es muy largo», que es lo que el contrato promete.
    await expect(
      appointments.book(
        {
          paciente_id: ANA.patient,
          tratamiento_id: treatment,
          empieza_en: '2026-11-05T13:00:00.000Z',
          nota_de_la_paciente: 'x'.repeat(2001),
        },
        doctor(MINE.practice, MINE.doctor),
        key('nota-larga'),
      ),
    ).rejects.toMatchObject({ code: 'texto_demasiado_largo' });

    // Y el tope es EL DE LA BASE y no uno más estricto por si acaso: 2000 justos pasan, 2001 no.
    // El límite se mide aquí y no con otra cita porque lo que se comprueba es el número.
    expect(() => asText('x'.repeat(2000), 2000)).not.toThrow();
    expect(() => asText('x'.repeat(2001), 2000)).toThrow();
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

describe('lo que el 29 de octubre de 2026 dejó de ser un 500', () => {
  beforeAll(async () => {
    await owner.query(`delete from appointment where practice_id = $1`, [MINE.practice]);
    await owner.query(`delete from waitlist_entry where practice_id = $1`, [MINE.practice]);
    await owner.query(`delete from promotion where practice_id = $1`, [MINE.practice]);
  });

  it('el último cupo de una promoción, canjeado a la vez, da promocion_no_aplica y no 500', async () => {
    // Un solo cupo y dos pacientes en huecos distintos: lo que se pelea es el cupo, no el hueco.
    const { rows } = await owner.query<{ id: string }>(
      `insert into promotion (practice_id, name, discount_type, discount_value, starts_on,
                              ends_on, quota, redeemed, segment_key, published)
       values ($1, 'Último cupo', 'porcentaje', 20, '2026-11-01', '2026-11-30', 1, 0, 'todas', true)
       returning id`,
      [MINE.practice],
    );
    const promotion = rows[0]!.id;

    const first = (await appointments.book(
      {
        practice_id: MINE.practice,
        tratamiento_id: treatment,
        empieza_en: '2026-11-03T13:00:00.000Z',
        promocion_id: promotion,
      },
      patient(ANA.account),
      key('cupo-ana'),
    )) as { precio_aplicado: { centavos: number } };
    // 20 % de 192 000.
    expect(first.precio_aplicado.centavos).toBe(153600);

    // La segunda llega con el cupo ya agotado. Antes de hoy: `CHECK` violado, transacción
    // abortada y 500 con «puede que sí haya quedado agendada». Ahora, el código del contrato
    // CON EL PRECIO DE LISTA, para ofrecerle reservar sin ella.
    const failed = await appointments
      .book(
        {
          practice_id: MINE.practice,
          tratamiento_id: treatment,
          empieza_en: '2026-11-03T15:30:00.000Z',
          promocion_id: promotion,
        },
        patient(BEA.account),
        key('cupo-bea'),
      )
      .catch((failure: unknown) => failure as { code: string; data?: { precio?: { centavos: number } } });
    expect(failed).toMatchObject({ code: 'promocion_no_aplica' });
    expect((failed as { data?: { precio?: { centavos: number } } }).data?.precio?.centavos).toBe(192000);

    // Y el cupo no se pasó: la fila sigue en uno de uno.
    const { rows: after } = await owner.query<{ redeemed: number; n: string }>(
      `select p.redeemed,
              (select count(*)::text from appointment a where a.promotion_id = p.id) as n
         from promotion p where p.id = $1`,
      [promotion],
    );
    expect(after[0]?.redeemed).toBe(1);
    expect(after[0]?.n).toBe('1');
  });

  it('reagendar vuelve a pasar la regla clínica: una contraindicación anotada después frena', async () => {
    await owner.query(`delete from appointment where practice_id = $1`, [MINE.practice]);
    const booked = (await appointments.book(
      {
        practice_id: MINE.practice,
        tratamiento_id: treatment,
        empieza_en: '2026-11-03T13:00:00.000Z',
      },
      patient(ANA.account),
      key('clinica-antes'),
    )) as { id: string };

    // La doctora anota el embarazo DESPUÉS de agendada, y el tratamiento lo contraindica.
    await owner.query(
      `insert into treatment_contraindication (practice_id, treatment_id, key, absolute)
       values ($1, $2, 'embarazo', true)`,
      [MINE.practice, treatment],
    );
    await owner.query(`delete from medical_history where patient_id = $1`, [ANA.patient]);
    await owner.query(
      `insert into medical_history (practice_id, patient_id, pregnancy_or_lactation,
                                    pregnancy_or_lactation_source, pregnancy_or_lactation_source_at)
       values ($1, $2, 'embarazo', 'doctora', now())`,
      [MINE.practice, ANA.patient],
    );

    // Ella mueve su cita desde la app: la única puerta sin el muro clínico era esta.
    await expect(
      appointments.reschedule(
        booked.id,
        { empieza_en: '2026-11-03T15:30:00.000Z' },
        patient(ANA.account),
      ),
    ).rejects.toMatchObject({ code: 'tratamiento_no_disponible' });

    await owner.query(`delete from treatment_contraindication where treatment_id = $1`, [treatment]);
    await owner.query(`delete from medical_history where patient_id = $1`, [ANA.patient]);

    // Sin la contraindicación, la misma llamada mueve la cita.
    const moved = (await appointments.reschedule(
      booked.id,
      { empieza_en: '2026-11-03T15:30:00.000Z' },
      patient(ANA.account),
    )) as { empieza_en: string };
    expect(moved.empieza_en).toBe('2026-11-03T15:30:00.000Z');
  });

  it('reagendar respeta el margen de cortesía, que antes solo se miraba al reservar', async () => {
    await owner.query(`delete from appointment where practice_id = $1`, [MINE.practice]);
    const nine = (await appointments.book(
      {
        practice_id: MINE.practice,
        tratamiento_id: treatment,
        empieza_en: '2026-11-03T13:00:00.000Z',
      },
      patient(ANA.account),
      key('margen-1'),
    )) as { id: string };
    const later = (await appointments.book(
      {
        practice_id: MINE.practice,
        tratamiento_id: treatment,
        empieza_en: '2026-11-03T16:00:00.000Z',
      },
      patient(BEA.account),
      key('margen-2'),
    )) as { id: string };

    // 13:40 termina la primera; con 15 minutos de margen, las 13:30 de la rejilla se pisan.
    await expect(
      appointments.reschedule(
        later.id,
        { empieza_en: '2026-11-03T13:30:00.000Z' },
        doctor(MINE.practice, MINE.doctor),
      ),
    ).rejects.toMatchObject({ code: 'hueco_ocupado' });

    // Y la cita no se movió.
    const still = (await appointments.one(later.id, doctor(MINE.practice, MINE.doctor))) as {
      empieza_en: string;
    };
    expect(still.empieza_en).toBe('2026-11-03T16:00:00.000Z');
    void nine;
  });

  it('cancelar con lista de espera DEJA EL AVISO, que antes se afirmaba y no existía', async () => {
    await owner.query(`delete from appointment where practice_id = $1`, [MINE.practice]);
    await owner.query(`delete from waitlist_entry where practice_id = $1`, [MINE.practice]);
    await owner.query(`delete from notification_outbox where practice_id = $1`, [MINE.practice]);

    const booked = (await appointments.book(
      {
        paciente_id: BEA.patient,
        tratamiento_id: treatment,
        empieza_en: '2026-11-03T13:00:00.000Z',
      },
      doctor(MINE.practice, MINE.doctor),
      key('aviso-hueco'),
    )) as { id: string };

    // Ana espera ese tratamiento para ese día.
    await appointments.joinWaitlist(
      {
        practice_id: MINE.practice,
        tratamiento_id: treatment,
        desde: '2026-11-01',
        hasta: '2026-12-31',
      },
      patient(ANA.account),
    );

    const cancelled = (await appointments.cancel(
      booked.id,
      doctor(MINE.practice, MINE.doctor),
    )) as { lista_de_espera_avisada: number };
    expect(cancelled.lista_de_espera_avisada).toBe(1);

    // Y AHORA LA RESPUESTA ES VERDAD: hay una fila que lo manda, a la cuenta de quien espera.
    const { rows } = await owner.query<{
      account_id: string;
      kind: string;
      data: Record<string, unknown>;
    }>(
      `select account_id, kind, data from notification_outbox
        where practice_id = $1 and kind = 'hueco_libre'`,
      [MINE.practice],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.account_id).toBe(ANA.account);
    // Lleva cuándo vence la reserva de 30 minutos, y ni el nombre de nadie.
    expect(rows[0]?.data.vence_en).toBeTruthy();
    expect(JSON.stringify(rows[0]?.data)).not.toContain('Ana');
  });

  it('una ficha SIN CUENTA en la lista de espera no se queda el hueco ni se le dice que se avisó', async () => {
    // El defecto que la bandeja de salida vino a cerrar, por la otra puerta: avisar necesita un
    // vínculo con cuenta, y «la mitad de las fichas de una consulta no tiene cuenta». Antes se
    // le reservaba el hueco 30 minutos y la respuesta decía `lista_de_espera_avisada: 1`.
    await owner.query(`delete from appointment where practice_id = $1`, [MINE.practice]);
    await owner.query(`delete from waitlist_entry where practice_id = $1`, [MINE.practice]);
    await owner.query(`delete from notification_outbox where practice_id = $1`, [MINE.practice]);

    // Una ficha de esta consulta SIN `patient_link`: nadie a quien mandarle un push.
    const { rows: sola } = await owner.query<{ id: string }>(
      `insert into patient (practice_id, first_name, last_name, birth_date, email, how_arrived)
       values ($1, 'Sin', 'Cuenta', '1990-01-01', 'sincuenta@tramo4.local', 'instagram')
       returning id`,
      [MINE.practice],
    );
    await owner.query(
      `insert into waitlist_entry (practice_id, patient_id, treatment_id, from_date, to_date)
       values ($1, $2, $3, '2026-11-01', '2026-12-31')`,
      [MINE.practice, sola[0]!.id, treatment],
    );

    const booked = (await appointments.book(
      {
        paciente_id: BEA.patient,
        tratamiento_id: treatment,
        empieza_en: '2026-11-03T13:00:00.000Z',
      },
      doctor(MINE.practice, MINE.doctor),
      key('hueco-sin-cuenta'),
    )) as { id: string };

    const cancelled = (await appointments.cancel(
      booked.id,
      doctor(MINE.practice, MINE.doctor),
    )) as { lista_de_espera_avisada: number };

    // LA RESPUESTA DICE LA VERDAD: no se avisó a nadie.
    expect(cancelled.lista_de_espera_avisada).toBe(0);

    // Y EL HUECO NO SE LE RESERVA a quien no se enteró: reservarlo es perderlo.
    const { rows: espera } = await owner.query<{ offered_until: Date | null }>(
      `select offered_until from waitlist_entry where patient_id = $1`,
      [sola[0]!.id],
    );
    expect(espera[0]?.offered_until).toBeNull();

    const { rows: avisos } = await owner.query<{ n: string }>(
      `select count(*)::text as n from notification_outbox
        where practice_id = $1 and kind = 'hueco_libre'`,
      [MINE.practice],
    );
    expect(avisos[0]?.n).toBe('0');

    await owner.query(`delete from waitlist_entry where patient_id = $1`, [sola[0]!.id]);
    await owner.query(`delete from patient where id = $1`, [sola[0]!.id]);
  });

  it('el hueco se ofrece a quien esperaba ESE DÍA, no a quien esperaba HOY', async () => {
    // Lo que se comparaba con `from_date`/`to_date` era HOY y no el día del hueco que se
    // liberó. Y ese rango es «avísame si se libera algo esos días» (`agenda.md`), así que el
    // aviso estrella del tramo 4 disparaba a la persona equivocada: quien esperaba el 15 no se
    // enteraba del hueco del 15, y quien esperaba el 1 recibía uno del 20 que no le servía.
    // Y EL HUECO ES A LAS 21:00 DE LA PAZ A PROPÓSITO: 01:00Z del día 4 es el día 3 en la zona
    // de la consulta y el día 4 en UTC. Con un hueco de media mañana las dos zonas contestan lo
    // mismo y esta prueba seguiría verde si alguien cambiara `dayOf(...)` por un `::date` sobre
    // el instante, que es la mitad del defecto. Así no.
    //
    // La cita se inserta con el rol dueño porque las nueve de la noche están fuera del horario
    // de la consulta y `book()` la rechazaría: lo que se prueba es a quién se le ofrece el hueco
    // al cancelar, no si ese hueco se podía reservar.
    const hueco = '2026-11-04T01:00:00.000Z';

    for (const [desde, hasta, avisados] of [
      // Espera el día del hueco EN UTC, que no es el día de la consulta: nada.
      ['2026-11-04', '2026-11-04', 0],
      // Espera el día del hueco en la zona de la consulta: ahí sí.
      ['2026-11-03', '2026-11-03', 1],
    ] as const) {
      await owner.query(`delete from appointment where practice_id = $1`, [MINE.practice]);
      await owner.query(`delete from waitlist_entry where practice_id = $1`, [MINE.practice]);
      await owner.query(`delete from notification_outbox where practice_id = $1`, [MINE.practice]);

      const { rows: puesta } = await owner.query<{ id: string }>(
        `insert into appointment (practice_id, patient_id, treatment_id, starts_at, ends_at,
                                  status, price_cents)
         values ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '30 minutes',
                 'confirmada', 150000)
         returning id`,
        [MINE.practice, BEA.patient, treatment, hueco],
      );
      const booked = puesta[0]!;

      await appointments.joinWaitlist(
        { practice_id: MINE.practice, tratamiento_id: treatment, desde, hasta },
        patient(ANA.account),
      );

      const cancelled = (await appointments.cancel(
        booked.id,
        doctor(MINE.practice, MINE.doctor),
      )) as { lista_de_espera_avisada: number };
      expect(cancelled.lista_de_espera_avisada).toBe(avisados);

      const { rows } = await owner.query<{ n: string }>(
        `select count(*)::text as n from notification_outbox
          where practice_id = $1 and kind = 'hueco_libre'`,
        [MINE.practice],
      );
      expect(rows[0]?.n).toBe(String(avisados));
    }
  });

  it('CUANDO CANCELA LA PACIENTE y hay alguien esperando CON cuenta, la cita se cancela', async () => {
    // El caso que mi arreglo anterior no alcanzaba: su prueba cancelaba como DOCTORA, y quien
    // más cancela es la paciente. `app_patient` no tiene `UPDATE` sobre `waitlist_entry`, así
    // que en cuanto el aviso SÍ se encolaba —justo cuando se decide reservar el hueco— el
    // `update offered_until` moría con «permission denied», abortaba la transacción, y **la
    // cita no se cancelaba**: 500 y la cita seguía confirmada, con la decisión de la seña
    // perdida. No era regresión: el UPDATE corría antes siempre que hubiera alguien esperando.
    await owner.query(`delete from appointment where practice_id = $1`, [MINE.practice]);
    await owner.query(`delete from waitlist_entry where practice_id = $1`, [MINE.practice]);
    await owner.query(`delete from notification_outbox where practice_id = $1`, [MINE.practice]);

    // Bea espera, y Bea SÍ tiene cuenta: es la condición que dispara el camino.
    await appointments.joinWaitlist(
      {
        practice_id: MINE.practice,
        tratamiento_id: treatment,
        desde: '2026-11-01',
        hasta: '2026-12-31',
      },
      patient(BEA.account),
    );

    const suya = (await appointments.book(
      {
        practice_id: MINE.practice,
        tratamiento_id: treatment,
        empieza_en: '2026-11-03T13:00:00.000Z',
      },
      patient(ANA.account),
      key('cancela-paciente'),
    )) as { id: string };

    // ELLA cancela, no la consulta.
    const cancelled = (await appointments.cancel(suya.id, patient(ANA.account))) as {
      estado: string;
      lista_de_espera_avisada: number;
    };
    expect(cancelled.estado).toBe('cancelada');
    expect(cancelled.lista_de_espera_avisada).toBe(1);

    // Y las dos escrituras ocurrieron: el aviso y la reserva de treinta minutos.
    const { rows: avisos } = await owner.query<{ account_id: string }>(
      `select account_id from notification_outbox
        where practice_id = $1 and kind = 'hueco_libre'`,
      [MINE.practice],
    );
    expect(avisos).toHaveLength(1);
    expect(avisos[0]?.account_id).toBe(BEA.account);

    const { rows: espera } = await owner.query<{ offered_until: Date | null }>(
      `select offered_until from waitlist_entry where patient_id = $1`,
      [BEA.patient],
    );
    expect(espera[0]?.offered_until).not.toBeNull();
  });

  it('cancelar exige citas:cancelar, y reagendar citas:crear', async () => {
    await owner.query(`delete from appointment where practice_id = $1`, [MINE.practice]);
    const booked = (await appointments.book(
      {
        practice_id: MINE.practice,
        tratamiento_id: treatment,
        empieza_en: '2026-11-03T13:00:00.000Z',
      },
      patient(ANA.account),
      key('permisos'),
    )) as { id: string };

    const sinCancelar = {
      ...doctor(MINE.practice, MINE.doctor),
      permissions: ['agenda:leer', 'citas:crear', 'horarios:leer'],
    };
    await expect(appointments.cancel(booked.id, sinCancelar)).rejects.toMatchObject({
      code: 'sin_permiso',
    });

    const sinCrear = {
      ...doctor(MINE.practice, MINE.doctor),
      permissions: ['agenda:leer', 'citas:cancelar'],
    };
    await expect(
      appointments.reschedule(booked.id, { empieza_en: '2026-11-03T15:30:00.000Z' }, sinCrear),
    ).rejects.toMatchObject({ code: 'sin_permiso' });

    // Con el permiso que nombra la operación, sí.
    await expect(
      appointments.cancel(booked.id, doctor(MINE.practice, MINE.doctor)),
    ).resolves.toMatchObject({ estado: 'cancelada' });
  });
});

describe('el lote de sincronización, con tope y con clave', () => {
  beforeAll(async () => {
    await owner.query(`delete from appointment where practice_id = $1`, [MINE.practice]);
    await owner.query(`delete from idempotency_key where account_id = any($1::uuid[])`, [
      [MINE.doctor, ANA.account, BEA.account],
    ]);
  });

  it('un lote de 201 operaciones no entra, y dice el máximo', async () => {
    const operations = Array.from({ length: 201 }, (_, i) => ({
      clave: `op-grande-${i}`,
      tipo: 'cita.cancelar',
      datos: { cita_id: '00000000-0000-4000-8000-000000000000' },
    }));
    await expect(
      sync.run({ operaciones: operations }, doctor(MINE.practice, MINE.doctor)),
    ).rejects.toMatchObject({ code: 'lote_demasiado_grande', data: { maximo: 200 } });
  });

  it('reenviar el lote NO vuelve a mover una cita que ya se movió después', async () => {
    const booked = (await appointments.book(
      {
        paciente_id: ANA.patient,
        tratamiento_id: treatment,
        empieza_en: '2026-11-03T13:00:00.000Z',
      },
      doctor(MINE.practice, MINE.doctor),
      key('lote-base'),
    )) as { id: string };

    const batch = {
      operaciones: [
        {
          clave: 'op-mover-1',
          tipo: 'cita.mover',
          datos: { cita_id: booked.id, empieza_en: '2026-11-03T15:30:00.000Z' },
        },
      ],
    };
    const first = await sync.run(batch, doctor(MINE.practice, MINE.doctor));
    expect(first.aplicadas).toBe(1);

    // La doctora la mueve otra vez, ya con señal.
    await appointments.reschedule(
      booked.id,
      { empieza_en: '2026-11-03T16:00:00.000Z' },
      doctor(MINE.practice, MINE.doctor),
    );

    // Y la app reenvía su bandeja de salida. SIN la clave de cada operación, esto devolvía la
    // cita a las 15:30 y deshacía el cambio posterior.
    const again = await sync.run(batch, doctor(MINE.practice, MINE.doctor));
    expect(again.aplicadas).toBe(1);

    const still = (await appointments.one(booked.id, doctor(MINE.practice, MINE.doctor))) as {
      empieza_en: string;
    };
    expect(still.empieza_en).toBe('2026-11-03T16:00:00.000Z');
  });
});
