// El tramo 8 contra la base real, en un solo archivo.
//
// Lo que se prueba: que el margen usa el COSTO DEL LOTE APLICADO y no miente cuando no lo sabe,
// que un cobro se anula con otra fila en vez de borrarse, que el inventario no queda negativo,
// que un informe de menos de cinco pacientes no se devuelve, y que la paciente ve el importe de
// sus cobros pero no el medio ni la referencia de la consulta.

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Caller } from '../access/application/caller';
import { Business } from './application/business';
import { BusinessRepository } from './infrastructure/business.repository';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 2 });
const business = new Business(new BusinessRepository(app));

const B = {
  practice: '44444444-0000-4000-8000-000000000001',
  doctor: '44444444-0000-4000-8000-000000000011',
  assistant: '44444444-0000-4000-8000-000000000012',
  patient: '44444444-0000-4000-8000-000000000021',
  account: '44444444-0000-4000-8000-000000000031',
};
let session = '';
let lotWithCost = '';
let lotWithoutCost = '';
let payment = '';

function staff(account: string, role: 'doctora' | 'asistente_clinico'): Caller {
  return {
    accountId: account,
    sessionId: '44444444-0000-4000-8000-0000000000ff',
    role,
    accountRole: 'practitioner',
    scope: 'completo',
    region: 'latam',
    practiceId: B.practice,
    permissions:
      role === 'doctora'
        ? ['cobros:registrar', 'margenes:leer', 'informes:leer', 'inventario:editar', 'equipo:crear']
        : ['inventario:editar'],
  };
}

const ana: Caller = {
  accountId: B.account,
  sessionId: '44444444-0000-4000-8000-0000000000fe',
  role: 'paciente',
  accountRole: 'paciente',
  scope: 'completo',
  region: 'latam',
  practiceId: null,
  permissions: [],
};

const key = (k: string) => ({ key: k, bodyHash: `huella-${k}` });

beforeAll(async () => {
  await owner.query(`delete from practice where id = $1`, [B.practice]);
  await owner.query(`delete from account where id = any($1::uuid[])`, [
    [B.doctor, B.assistant, B.account],
  ]);
  await owner.query(`delete from idempotency_key where account_id = any($1::uuid[])`, [
    [B.doctor, B.assistant],
  ]);
  await owner.query(`delete from data_export where account_id = any($1::uuid[])`, [
    [B.doctor, B.account],
  ]);

  await owner.query(
    `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit,
                           plan_renews_on)
     values ($1, 'Clínica Paz', 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 5,
             '2026-12-14')`,
    [B.practice],
  );
  for (const [account, role] of [
    [B.doctor, 'doctora'],
    [B.assistant, 'asistente_clinico'],
  ] as const) {
    await owner.query(
      `insert into account (id, email, role, region, first_name, last_name)
       values ($1, $2, 'practitioner', 'latam', 'Andrea', 'Paz')`,
      [account, `${account.slice(-3)}@tramo8.local`],
    );
    await owner.query(
      `insert into practitioner (practice_id, account_id, role, status, first_name, last_name)
       values ($1, $2, $3, 'activa', 'Andrea', 'Paz')`,
      [B.practice, account, role],
    );
  }
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, 'ana@tramo8.local', 'paciente', 'latam', 'Ana', 'Antelo')`,
    [B.account],
  );
  await owner.query(
    `insert into patient (id, practice_id, first_name, last_name, birth_date, email, how_arrived)
     values ($1, $2, 'Ana', 'Antelo', '1992-04-18', 'ana.ficha@tramo8.local', 'instagram')`,
    [B.patient, B.practice],
  );
  await owner.query(`insert into medical_history (practice_id, patient_id) values ($1, $2)`, [
    B.practice,
    B.patient,
  ]);
  await owner.query(
    `insert into patient_link (practice_id, patient_id, account_id, status, email, practice_name,
                               practitioner_name)
     values ($1, $2, $3, 'vinculada', 'ana@tramo8.local', 'Clínica Paz', 'Dra. Andrea Paz')`,
    [B.practice, B.patient, B.account],
  );

  const { rows: treatments } = await owner.query<{ id: string }>(
    `insert into treatment (practice_id, name, category, duration_minutes, planned_sessions)
     values ($1, 'Toxina', 'toxina', 40, 1) returning id`,
    [B.practice],
  );
  const treatment = treatments[0]!.id;
  const { rows: products } = await owner.query<{ id: string }>(
    `insert into product (practice_id, name) values ($1, 'Toxina 100U') returning id`,
    [B.practice],
  );
  // Un lote CON costo y otro SIN: el segundo es el que no puede entrar en el margen.
  const { rows: lots } = await owner.query<{ id: string }>(
    `insert into product_lot (practice_id, product_id, code, expires_on, units, units_left,
                              cost_cents)
     values ($1, $2, 'CON-COSTO', '2027-03-01', 100, 100, 120000),
            ($1, $2, 'SIN-COSTO', '2027-03-01', 100, 100, null)
     returning id`,
    [B.practice, products[0]!.id],
  );
  lotWithCost = lots[0]!.id;
  lotWithoutCost = lots[1]!.id;

  const { rows: appointments } = await owner.query<{ id: string }>(
    `insert into appointment (practice_id, patient_id, treatment_id, starts_at, ends_at, status,
                              price_cents, attended)
     values ($1, $2, $3, '2026-10-20T15:00:00Z', '2026-10-20T15:40:00Z', 'atendida', 192000, true)
     returning id`,
    [B.practice, B.patient, treatment],
  );
  const { rows: sessions } = await owner.query<{ id: string }>(
    `insert into clinical_session (practice_id, patient_id, appointment_id,
                                   practitioner_account_id, started_at, ended_at, status)
     values ($1, $2, $3, $4, '2026-10-20T15:02:00Z', '2026-10-20T15:38:00Z', 'firmada')
     returning id`,
    [B.practice, B.patient, appointments[0]!.id, B.doctor],
  );
  session = sessions[0]!.id;
  // 20 unidades del lote con costo: 120 000 / 100 × 20 = 24 000 de costo.
  await owner.query(
    `insert into session_application (practice_id, session_id, lot_id, zone, total_units)
     values ($1, $2, $3, 'entrecejo', 20)`,
    [B.practice, session, lotWithCost],
  );
});

afterAll(async () => {
  await owner.query(`delete from practice where id = $1`, [B.practice]);
  await owner.query(`delete from account where id = any($1::uuid[])`, [
    [B.doctor, B.assistant, B.account],
  ]);
  await owner.end();
  await app.end();
});

describe('cobrar, y no cobrar dos veces', () => {
  it('registra el cobro y el reintento con la misma clave no cobra de nuevo', async () => {
    const charged = (await business.charge(
      {
        patient_id: B.patient,
        session_id: session,
        concepto: 'sesion',
        importe: { centavos: 192000 },
        medio: 'transferencia',
        referencia: 'BNB-884211',
      },
      staff(B.doctor, 'doctora'),
      key('c1'),
    )) as { id: string; importe: { centavos: number }; medio: string };
    payment = charged.id;
    expect(charged).toMatchObject({ importe: { centavos: 192000 }, medio: 'transferencia' });

    const again = (await business.charge(
      {
        patient_id: B.patient,
        session_id: session,
        concepto: 'sesion',
        importe: { centavos: 192000 },
        medio: 'transferencia',
        referencia: 'BNB-884211',
      },
      staff(B.doctor, 'doctora'),
      key('c1'),
    )) as { id: string };
    expect(again.id).toBe(payment);

    // Con OTRA clave, la base lo para: «esa sesión ya está cobrada».
    await expect(
      business.charge(
        {
          patient_id: B.patient,
          session_id: session,
          concepto: 'sesion',
          importe: { centavos: 1000 },
          medio: 'efectivo',
        },
        staff(B.doctor, 'doctora'),
        key('c2'),
      ),
    ).rejects.toMatchObject({ code: 'ya_cobrado' });
  });

  it('el asistente clínico no registra cobros, y un importe con decimales tampoco entra', async () => {
    await expect(
      business.charge(
        { patient_id: B.patient, concepto: 'otro', importe: { centavos: 100 }, medio: 'efectivo' },
        staff(B.assistant, 'asistente_clinico'),
        key('c3'),
      ),
    ).rejects.toMatchObject({ code: 'sin_permiso' });

    await expect(
      business.charge(
        {
          patient_id: B.patient,
          concepto: 'otro',
          importe: { centavos: 1920.5 },
          medio: 'efectivo',
        },
        staff(B.doctor, 'doctora'),
        key('c4'),
      ),
    ).rejects.toMatchObject({ code: 'importe_no_valido' });
  });

  it('anular no borra: deja las dos filas', async () => {
    const voided = (await business.voidPayment(
      payment,
      { motivo: 'se cobró por duplicado' },
      staff(B.doctor, 'doctora'),
    )) as { anulacion_id: string };
    expect(voided.anulacion_id).toBeTruthy();

    const { rows } = await owner.query<{ n: string }>(
      `select count(*)::text as n from payment where practice_id = $1`,
      [B.practice],
    );
    // El original anulado y la anulación: dos filas, no cero.
    expect(rows[0]?.n).toBe('2');
  });

  it('la paciente ve el importe de sus cobros, no el medio ni la referencia', async () => {
    const hers = (await business.payments({}, ana)) as {
      cobros: Record<string, unknown>[];
    };
    expect(hers.cobros.length).toBeGreaterThan(0);
    for (const row of hers.cobros) {
      expect(row).toHaveProperty('importe');
      expect(row).not.toHaveProperty('medio');
      expect(row).not.toHaveProperty('referencia');
    }
  });
});

describe('el margen, con el costo del lote', () => {
  it('usa el costo del lote aplicado y cuenta aparte lo que no lo sabe', async () => {
    // Un cobro vivo para esta sesión: el anterior quedó anulado.
    await business.charge(
      {
        patient_id: B.patient,
        session_id: session,
        concepto: 'sesion',
        importe: { centavos: 192000 },
        medio: 'efectivo',
      },
      staff(B.doctor, 'doctora'),
      key('c5'),
    );

    const margins = (await business.margins({}, staff(B.doctor, 'doctora'))) as {
      moneda: string;
      filas: {
        tratamiento: string;
        cobrado: { centavos: number };
        costo_producto: { centavos: number };
        margen: { centavos: number };
        margen_porcentaje: number | null;
        unidades_consumidas: number;
      }[];
      sin_costo_conocido: { sesiones: number } | null;
    };

    expect(margins.moneda).toBe('BOB');
    const row = margins.filas[0]!;
    // 120 000 / 100 × 20 = 24 000 de costo; 192 000 cobrado; margen 168 000 = 87,5 %.
    expect(row).toMatchObject({
      tratamiento: 'Toxina',
      cobrado: { centavos: 192000 },
      costo_producto: { centavos: 24000 },
      margen: { centavos: 168000 },
      margen_porcentaje: 87.5,
      unidades_consumidas: 20,
    });
    expect(margins.sin_costo_conocido).toBeNull();
  });

  it('una sesión de un lote sin costo NO entra en el margen y se cuenta aparte', async () => {
    const { rows: appointments } = await owner.query<{ id: string }>(
      `insert into appointment (practice_id, patient_id, treatment_id, starts_at, ends_at,
                                status, price_cents, attended)
       select $1, $2, treatment_id, '2026-10-21T15:00:00Z', '2026-10-21T15:40:00Z', 'atendida',
              192000, true
         from appointment where practice_id = $1 limit 1
       returning id`,
      [B.practice, B.patient],
    );
    const { rows: sessions } = await owner.query<{ id: string }>(
      `insert into clinical_session (practice_id, patient_id, appointment_id,
                                     practitioner_account_id, started_at, ended_at, status)
       values ($1, $2, $3, $4, '2026-10-21T15:02:00Z', '2026-10-21T15:38:00Z', 'firmada')
       returning id`,
      [B.practice, B.patient, appointments[0]!.id, B.doctor],
    );
    await owner.query(
      `insert into session_application (practice_id, session_id, lot_id, zone, total_units)
       values ($1, $2, $3, 'frente', 10)`,
      [B.practice, sessions[0]!.id, lotWithoutCost],
    );

    const margins = (await business.margins({}, staff(B.doctor, 'doctora'))) as {
      sin_costo_conocido: { sesiones: number; por_que: string } | null;
    };
    // EXISTE PARA NO MENTIR: asumir costo cero daría un margen del 100 %.
    expect(margins.sin_costo_conocido).toMatchObject({
      sesiones: 1,
      por_que: 'lotes sin costo registrado',
    });
  });

  it('solo la dueña ve los márgenes', async () => {
    await expect(
      business.margins({}, staff(B.assistant, 'asistente_clinico')),
    ).rejects.toMatchObject({ code: 'sin_permiso' });
    await expect(business.margins({}, ana)).rejects.toMatchObject({ code: 'sin_permiso' });
  });
});

describe('el inventario', () => {
  it('una salida de sesión no se registra a mano, y el stock no queda negativo', async () => {
    await expect(
      business.move(
        { lot_id: lotWithCost, tipo: 'salida', unidades: 5 },
        staff(B.doctor, 'doctora'),
        key('m1'),
      ),
    ).rejects.toMatchObject({ code: 'movimiento_de_sesion' });

    await expect(
      business.move(
        { lot_id: lotWithCost, tipo: 'ajuste', unidades: 500 },
        staff(B.doctor, 'doctora'),
        key('m2'),
      ),
    ).rejects.toMatchObject({ code: 'stock_negativo' });

    // Una merma SIN motivo tampoco: es producto tirado y es dinero.
    await expect(
      business.move(
        { lot_id: lotWithCost, tipo: 'merma', unidades: 2 },
        staff(B.doctor, 'doctora'),
        key('m3'),
      ),
    ).rejects.toMatchObject({ code: 'merma_sin_motivo' });

    const moved = (await business.move(
      { lot_id: lotWithCost, tipo: 'merma', unidades: 2, motivo: 'vial roto al abrir' },
      staff(B.doctor, 'doctora'),
      key('m4'),
    )) as { quedan: number };
    expect(moved.quedan).toBe(98);

    // Y el movimiento queda, con su motivo.
    const { rows } = await owner.query<{ kind: string; units: number; reason: string }>(
      `select kind, units, reason from inventory_movement where practice_id = $1`,
      [B.practice],
    );
    expect(rows).toEqual([{ kind: 'merma', units: -2, reason: 'vial roto al abrir' }]);
  });

  it('el inventario lista productos con sus lotes y lo que queda', async () => {
    const seen = (await business.inventory(staff(B.doctor, 'doctora'))) as {
      productos: { nombre: string; unidades: number; lotes: { codigo: string }[] }[];
    };
    expect(seen.productos[0]?.nombre).toBe('Toxina 100U');
    expect(seen.productos[0]?.lotes.map((lot) => lot.codigo).sort()).toEqual([
      'CON-COSTO',
      'SIN-COSTO',
    ]);
  });
});

describe('informes, plan y exportación', () => {
  it('un agregado de menos de cinco pacientes no se devuelve', async () => {
    const report = (await business.report({ informe: 'ingresos' }, staff(B.doctor, 'doctora'))) as {
      suprimido?: boolean;
      por_que?: string;
    };
    // Una sola paciente en esta consulta: con dos filas, un «promedio» la identifica.
    expect(report).toMatchObject({ suprimido: true, por_que: 'menos_de_cinco' });
  });

  it('ausencias SÍ nombra, y deja su línea en la auditoría', async () => {
    await owner.query(
      `insert into appointment (practice_id, patient_id, treatment_id, starts_at, ends_at,
                                status, price_cents, cancelled_at, cancelled_by)
       select $1, $2, treatment_id, '2026-10-25T15:00:00Z', '2026-10-25T15:40:00Z', 'cancelada',
              192000, '2026-10-24T15:00:00Z', 'paciente'
         from appointment where practice_id = $1 limit 1`,
      [B.practice, B.patient],
    );

    const report = (await business.report({ informe: 'ausencias' }, staff(B.doctor, 'doctora'))) as {
      filas: { paciente: string }[];
    };
    expect(report.filas[0]?.paciente).toBe('Ana Antelo');

    const { rows } = await owner.query<{ n: string }>(
      `select count(*)::text as n from access_audit
        where data->>'motivo' = 'informe_ausencias'`,
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });

  it('el plan avisa al 80 %, y ampliarlo no cobra', async () => {
    const plan = (await business.plan(staff(B.doctor, 'doctora'))) as {
      limite_pacientes: number;
      pacientes: number;
      aviso: string | null;
      almacenamiento_limite: number;
    };
    expect(plan.limite_pacientes).toBe(5);
    expect(plan.almacenamiento_limite).toBeGreaterThan(0);
    // Una paciente de un límite de 5 todavía no llega al 80 %.
    expect(plan.aviso).toBeNull();

    const asked = (await business.requestPlan(
      { plan: 'clinica', nota: 'Vamos a abrir otro consultorio.' },
      staff(B.doctor, 'doctora'),
    )) as { estado: string; que_sigue: string };
    expect(asked.estado).toBe('pedida');
    expect(asked.que_sigue).toContain('No se te cobró nada');
  });

  it('la exportación es una por día y dice lo que NO lleva', async () => {
    const asked = (await business.requestExport(ana)) as { id: string; no_incluye: string };
    expect(asked.id).toBeTruthy();
    // La decisión incómoda, dicha sin esconderla.
    expect(asked.no_incluye).toContain('notas de tu doctora');

    await expect(business.requestExport(ana)).rejects.toMatchObject({
      code: 'exportacion_reciente',
    });

    const status = (await business.exportStatus(asked.id, ana)) as { estado: string };
    expect(status.estado).toBe('pedida');
  });
});
