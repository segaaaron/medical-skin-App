// El tramo 3 contra la base real, en un solo archivo.
//
// Lo que se prueba, y nada más: que otra consulta no ve el catálogo, el camino bueno de cada
// escritura, y LA REGLA QUE ES LA RAZÓN DE SER DEL TRAMO — que una paciente con una
// contraindicación en su ficha no ve ese tratamiento ni su promoción, y que el motivo no viaja.

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Caller } from '../access/application/caller';
import { Catalog } from './application/catalog';
import { ReadCatalog } from './application/read-catalog';
import { CatalogRepository } from './infrastructure/catalog.repository';
import { PatientCatalogRepository } from './infrastructure/patient-catalog.repository';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 2 });
const clock = { now: () => new Date('2026-10-28T12:00:00Z') };

const catalog = new Catalog(new CatalogRepository(app), clock);
const patientCatalog = new ReadCatalog(new PatientCatalogRepository(app), clock);

const MINE = { practice: 'eeeeeeee-0000-4000-8000-000000000001', doctor: 'eeeeeeee-0000-4000-8000-000000000011' };
const OTHER = { practice: 'eeeeeeee-0000-4000-8000-000000000002', doctor: 'eeeeeeee-0000-4000-8000-000000000012' };
const ANA = { patient: 'eeeeeeee-0000-4000-8000-000000000021', account: 'eeeeeeee-0000-4000-8000-000000000031', link: 'eeeeeeee-0000-4000-8000-000000000041' };

let toxin = '';
let peeling = '';

function doctor(practice: string, account: string): Caller {
  return {
    accountId: account,
    sessionId: 'eeeeeeee-0000-4000-8000-0000000000ff',
    role: 'doctora',
    accountRole: 'practitioner',
    scope: 'completo',
    region: 'latam',
    practiceId: practice,
    permissions: [
      'pacientes:leer',
      'catalogo:leer',
      'catalogo:editar',
      'precios:editar',
      'promociones:editar',
    ],
  };
}

const ana: Caller = {
  accountId: ANA.account,
  sessionId: 'eeeeeeee-0000-4000-8000-0000000000fe',
  role: 'paciente',
  accountRole: 'paciente',
  scope: 'completo',
  region: 'latam',
  practiceId: null,
  permissions: [],
};

const key = (k: string) => ({ key: k, bodyHash: `huella-${k}` });

const TOXIN = {
  nombre: 'Toxina botulínica · tercio superior',
  categoria: 'toxina',
  duracion_minutos: 40,
  sesiones_previstas: 1,
  precio: { centavos: 192000 },
  requiere_consentimiento: true,
};

beforeAll(async () => {
  await owner.query(`delete from practice where id = any($1::uuid[])`, [[MINE.practice, OTHER.practice]]);
  await owner.query(`delete from account where id = any($1::uuid[])`, [
    [MINE.doctor, OTHER.doctor, ANA.account],
  ]);
  await owner.query(`delete from idempotency_key where account_id = any($1::uuid[])`, [
    [MINE.doctor, OTHER.doctor],
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
      [p.account, `duena.${p.practice.slice(-1)}@tramo3.local`],
    );
    await owner.query(
      `insert into practitioner (practice_id, account_id, role, status, first_name, last_name)
       values ($1, $2, 'doctora', 'activa', 'Andrea', 'Paz')`,
      [p.practice, p.account],
    );
  }

  // Ana, vinculada a la mía, EMBARAZADA en su ficha: es lo que cierra el tratamiento.
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, 'ana@tramo3.local', 'paciente', 'latam', 'Ana', 'Antelo')`,
    [ANA.account],
  );
  await owner.query(
    `insert into patient (id, practice_id, first_name, last_name, birth_date, email, how_arrived)
     values ($1, $2, 'Ana', 'Antelo', '1992-04-18', 'ana.ficha@tramo3.local', 'instagram')`,
    [ANA.patient, MINE.practice],
  );
  await owner.query(
    `insert into medical_history (practice_id, patient_id, pregnancy_or_lactation,
                                  pregnancy_or_lactation_source, pregnancy_or_lactation_source_at)
     values ($1, $2, 'embarazo', 'paciente', now())`,
    [MINE.practice, ANA.patient],
  );
  await owner.query(
    `insert into patient_link (id, practice_id, patient_id, account_id, status, email,
                               practice_name, practitioner_name)
     values ($1, $2, $3, $4, 'vinculada', 'ana@tramo3.local', 'Clínica Paz', 'Dra. Andrea Paz')`,
    [ANA.link, MINE.practice, ANA.patient, ANA.account],
  );
});

afterAll(async () => {
  await owner.query(`delete from practice where id = any($1::uuid[])`, [[MINE.practice, OTHER.practice]]);
  await owner.query(`delete from account where id = any($1::uuid[])`, [
    [MINE.doctor, OTHER.doctor, ANA.account],
  ]);
  await owner.end();
  await app.end();
});

describe('el catálogo de la doctora', () => {
  it('crea el tratamiento con su precio base, y el nombre repetido es 409', async () => {
    const created = (await catalog.create(TOXIN, doctor(MINE.practice, MINE.doctor), key('t1'))) as {
      id: string;
      precio: { centavos: number; moneda: string };
      estado: string;
      veces_aplicado: number;
    };
    toxin = created.id;

    // La moneda sale de `practice.currency`, nunca del cuerpo.
    expect(created.precio).toEqual({ centavos: 192000, moneda: 'BOB' });
    expect(created.estado).toBe('activo');
    expect(created.veces_aplicado).toBe(0);

    await expect(
      catalog.create(TOXIN, doctor(MINE.practice, MINE.doctor), key('t2')),
    ).rejects.toMatchObject({ code: 'nombre_repetido' });

    // El reintento con LA MISMA clave repite la respuesta y no crea un segundo tratamiento. Y
    // repite LA MISMA RESPUESTA, no la fila interna: antes se guardaba la fila con sus nombres
    // en inglés, así que el reintento devolvía otro cuerpo que el primero.
    const again = (await catalog.create(TOXIN, doctor(MINE.practice, MINE.doctor), key('t1'))) as {
      id: string;
    };
    expect(again.id).toBe(toxin);
    expect(again).toEqual(created);
  });

  it('un tratamiento que se repite exige su intervalo mínimo, que es la regla clínica', async () => {
    await expect(
      catalog.create(
        { ...TOXIN, nombre: 'Peeling medio', categoria: 'peeling', sesiones_previstas: 4 },
        doctor(MINE.practice, MINE.doctor),
        key('t3'),
      ),
    ).rejects.toMatchObject({ code: 'intervalo_necesario' });

    const created = (await catalog.create(
      {
        nombre: 'Peeling medio',
        categoria: 'peeling',
        duracion_minutos: 45,
        sesiones_previstas: 4,
        intervalo_minimo_dias: 21,
        precio: { centavos: 85000 },
        requiere_consentimiento: false,
      },
      doctor(MINE.practice, MINE.doctor),
      key('t4'),
    )) as { id: string };
    peeling = created.id;
  });

  it('el catálogo de al lado no existe para mí', async () => {
    const mine = (await catalog.list(doctor(MINE.practice, MINE.doctor), {})) as {
      tratamientos: { id: string }[];
    };
    expect(mine.tratamientos.map((t) => t.id).sort()).toEqual([toxin, peeling].sort());

    const theirs = (await catalog.list(doctor(OTHER.practice, OTHER.doctor), {})) as {
      tratamientos: unknown[];
    };
    expect(theirs.tratamientos).toEqual([]);

    // Y con el identificador exacto: no se distingue «no es tuyo» de «no existe».
    await expect(
      catalog.edit(toxin, { nombre: 'Robado' }, doctor(OTHER.practice, OTHER.doctor)),
    ).rejects.toMatchObject({ code: 'tratamiento_no_existe' });
  });

  it('el protocolo va y vuelve con su reloj, y el semáforo con sus días', async () => {
    const saved = (await catalog.saveProtocol(
      toxin,
      {
        pasos: [
          { momento: 'antes', desfase_horas: -24, texto: 'No tomes alcohol.' },
          { momento: 'despues', desfase_horas: 3, texto: 'No te recuestes.' },
        ],
        semaforo: [{ dia: 1, normal: 'Puntos rojos.', llamar_si: 'Fiebre.' }],
      },
      doctor(MINE.practice, MINE.doctor),
    )) as { pasos: unknown[]; semaforo: unknown[] };

    expect(saved.pasos).toHaveLength(2);
    expect(saved.semaforo).toEqual([{ dia: 1, normal: 'Puntos rojos.', llamar_si: 'Fiebre.' }]);

    // Un paso de «antes» con horas positivas no tiene sentido y no entra.
    await expect(
      catalog.saveProtocol(
        toxin,
        { pasos: [{ momento: 'antes', desfase_horas: 5, texto: 'Mal.' }] },
        doctor(MINE.practice, MINE.doctor),
      ),
    ).rejects.toMatchObject({ code: 'desfase_sin_sentido' });
  });

  it('los precios por zona exigen su precio base', async () => {
    await expect(
      catalog.savePrices(
        { precios: [{ tratamiento_id: toxin, zona: 'entrecejo', centavos: 70000 }] },
        doctor(MINE.practice, MINE.doctor),
      ),
    ).rejects.toMatchObject({ code: 'falta_precio_base' });

    const saved = (await catalog.savePrices(
      {
        precios: [
          { tratamiento_id: toxin, zona: null, centavos: 192000 },
          { tratamiento_id: toxin, zona: 'entrecejo', centavos: 70000 },
        ],
      },
      doctor(MINE.practice, MINE.doctor),
    )) as { precios: { zona: string | null; centavos: number; moneda: string }[] };

    expect(saved.precios).toEqual(
      expect.arrayContaining([
        { tratamiento_id: toxin, zona: null, centavos: 192000, moneda: 'BOB' },
        { tratamiento_id: toxin, zona: 'entrecejo', centavos: 70000, moneda: 'BOB' },
      ]),
    );
  });

  it('reactivar un tratamiento cuyo nombre ya está en uso es 409, no 500', async () => {
    const taken = (await catalog.create(
      { ...TOXIN, nombre: 'Hilos tensores' },
      doctor(MINE.practice, MINE.doctor),
      key('h1'),
    )) as { id: string };

    await catalog.archive(taken.id, doctor(MINE.practice, MINE.doctor), true);
    // Otro activo se queda con el nombre: el índice único es PARCIAL, solo entre los activos.
    await catalog.create(
      { ...TOXIN, nombre: 'Hilos tensores' },
      doctor(MINE.practice, MINE.doctor),
      key('h2'),
    );

    // Reactivar es la operación que viola ese índice, y el resto del módulo da `nombre_repetido`.
    await expect(
      catalog.archive(taken.id, doctor(MINE.practice, MINE.doctor), false),
    ).rejects.toMatchObject({ code: 'nombre_repetido' });
  });

  it('el PATCH que deja un tratamiento repetido sin intervalo da su código, no un 500', async () => {
    // `peeling` tiene cuatro sesiones previstas y 21 días de intervalo.
    await expect(
      catalog.edit(peeling, { intervalo_minimo_dias: null }, doctor(MINE.practice, MINE.doctor)),
    ).rejects.toMatchObject({ code: 'intervalo_necesario' });

    // Y al revés: subir las sesiones de uno que no tiene intervalo rompe la misma regla.
    await expect(
      catalog.edit(toxin, { sesiones_previstas: 3 }, doctor(MINE.practice, MINE.doctor)),
    ).rejects.toMatchObject({ code: 'intervalo_necesario' });

    // La fila no se movió: la regla la sostiene la base y el mensaje lo pone el contrato.
    const after = (await catalog.list(doctor(MINE.practice, MINE.doctor), {})) as {
      tratamientos: { id: string; sesiones_previstas: number }[];
    };
    expect(after.tratamientos.find((t) => t.id === toxin)?.sesiones_previstas).toBe(1);
  });
});

describe('la regla clínica manda sobre la comercial', () => {
  it('una contraindicación absoluta cierra el tratamiento, y su promoción con él', async () => {
    // El embarazo bloquea la toxina; el peeling queda abierto.
    await catalog.saveContraindications(
      toxin,
      { contraindicaciones: [{ clave: 'embarazo', absoluta: true }] },
      doctor(MINE.practice, MINE.doctor),
    );
    // Una promoción vigente que cubre TODO el catálogo visible.
    await catalog.createPromotion(
      {
        nombre: 'Vuelve en primavera',
        descuento: { tipo: 'porcentaje', valor: 20 },
        vigencia: { desde: '2026-10-01', hasta: '2026-11-30' },
      },
      doctor(MINE.practice, MINE.doctor),
      key('p1'),
    );

    const seen = (await patientCatalog.run({ practice_id: MINE.practice }, ana)) as {
      consulta: string;
      moneda: string;
      tratamientos: {
        id: string;
        disponible: boolean;
        disponible_desde: string | null;
        precio: { centavos: number };
        precio_con_promocion: { centavos: number } | null;
        promocion: unknown;
      }[];
    };

    expect(seen.consulta).toBe('Clínica Paz');
    expect(seen.moneda).toBe('BOB');

    const blocked = seen.tratamientos.find((t) => t.id === toxin)!;
    expect(blocked.disponible).toBe(false);
    // El motivo NO viaja: ni `disponible_desde`, ni la promoción, ni nada de su ficha.
    expect(blocked.disponible_desde).toBeNull();
    expect(blocked.promocion).toBeNull();
    expect(blocked.precio_con_promocion).toBeNull();

    const open = seen.tratamientos.find((t) => t.id === peeling)!;
    expect(open.disponible).toBe(true);
    // 85 000 menos 20 % = 68 000, en centavos y sin decimales.
    expect(open.precio_con_promocion).toEqual({ centavos: 68000, moneda: 'BOB' });
    expect(open.promocion).toMatchObject({ nombre: 'Vuelve en primavera', hasta: '2026-11-30' });
  });

  it('ni un campo de su ficha sale en la respuesta', async () => {
    const raw = JSON.stringify(await patientCatalog.run({ practice_id: MINE.practice }, ana));
    for (const leak of ['embarazo', 'lactancia', 'alergia', 'contraindic', 'fototipo']) {
      expect(raw.toLowerCase()).not.toContain(leak);
    }
  });

  it('una consulta que no es suya es 404, y una doctora no entra a esta pantalla', async () => {
    await expect(
      patientCatalog.run({ practice_id: OTHER.practice }, ana),
    ).rejects.toMatchObject({ code: 'vinculo_no_existe' });

    await expect(
      patientCatalog.run({ practice_id: MINE.practice }, doctor(MINE.practice, MINE.doctor)),
    ).rejects.toMatchObject({ code: 'rol_no_corresponde' });
  });
});
