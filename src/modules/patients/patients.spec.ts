// El tramo 2 contra la base real, en UN solo archivo: los diez endpoints de ficha y vínculos.
//
// Tres cosas y nada más, que es lo que decidió el dueño el 28 de octubre:
//   1 · que otra consulta no ve nada,
//   2 · el camino bueno de cada escritura,
//   3 · la regla que este tramo inventa: la doctora gana sobre la paciente, campo por campo.
//
// Lo que NO se prueba porque ya lo garantiza otra cosa: las validaciones de forma (son las del
// alta, con su propio spec), que `app_patient` no pueda tocar `fototipo` ni `notas` (no tiene
// `GRANT` sobre esas columnas) y los códigos de error de cada rama (el catálogo es una tabla).

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Caller } from '../access/application/caller';
import { EditPatient } from './application/edit-patient';
import { ListPatients } from './application/list-patients';
import { PatientLinks } from './application/patient-links';
import { ReadPatient } from './application/read-patient';
import { WritePatientHistory } from './application/write-patient-history';
import { PatientHistoryRepository } from './infrastructure/patient-history.repository';
import { PatientLinksRepository } from './infrastructure/patient-links.repository';
import { PatientsReadRepository } from './infrastructure/patients-read.repository';
import { HistoryWriteRepository } from './infrastructure/history-write.repository';
import { PatientsWriteRepository } from './infrastructure/patients-write.repository';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 2 });
const clock = { now: () => new Date('2026-10-28T12:00:00Z') };

const read = new PatientsReadRepository(app);
const write = new PatientsWriteRepository(app);
const list = new ListPatients(read, clock);
const file = new ReadPatient(read, clock, new HistoryWriteRepository(app));
const edit = new EditPatient(write, clock);
const links = new PatientLinks(new PatientLinksRepository(app));
const history = new WritePatientHistory(new PatientHistoryRepository(app));

/** Dos consultas: la nuestra y la de al lado, que es la que no se puede ver. */
const MINE = { practice: 'dddddddd-0000-4000-8000-000000000001', doctor: 'dddddddd-0000-4000-8000-000000000011' };
const OTHER = { practice: 'dddddddd-0000-4000-8000-000000000002', doctor: 'dddddddd-0000-4000-8000-000000000012' };
const ANA = { patient: 'dddddddd-0000-4000-8000-000000000021', account: 'dddddddd-0000-4000-8000-000000000031', link: 'dddddddd-0000-4000-8000-000000000041' };
const THEIRS = { patient: 'dddddddd-0000-4000-8000-000000000022', link: 'dddddddd-0000-4000-8000-000000000042' };

function doctor(practice: string, account: string): Caller {
  return {
    accountId: account,
    sessionId: 'dddddddd-0000-4000-8000-0000000000ff',
    role: 'doctor',
    accountRole: 'doctor',
    scope: 'completo',
    region: 'latam',
    practiceId: practice,
    permissions: ['pacientes:leer', 'pacientes:crear', 'historia:leer'],
  };
}

const ana: Caller = {
  accountId: ANA.account,
  sessionId: 'dddddddd-0000-4000-8000-0000000000fe',
  role: 'patient',
  accountRole: 'patient',
  scope: 'completo',
  region: 'latam',
  practiceId: null,
  permissions: [],
};

async function seedPractice(p: { practice: string; account: string; name: string }) {
  await owner.query(
    `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit)
     values ($1, $2, 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300)`,
    [p.practice, p.name],
  );
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'doctor', 'latam', 'Andrea', 'Paz')`,
    [p.account, `duena.${p.practice.slice(-1)}@tramo2.local`],
  );
  await owner.query(
    `insert into practitioner (practice_id, account_id, role, status, first_name, last_name)
     values ($1, $2, 'doctor', 'activa', 'Andrea', 'Paz')`,
    [p.practice, p.account],
  );
  await owner.query(`update practice set owner_account_id = $2 where id = $1`, [
    p.practice,
    p.account,
  ]);
}

async function seedPatient(p: {
  practice: string;
  patient: string;
  link: string;
  account: string | null;
  status: string;
}) {
  await owner.query(
    `insert into patient (id, practice_id, first_name, last_name, birth_date, email, phone,
                          how_arrived)
     values ($1, $2, 'Valeria', 'Antelo', '1992-04-18', $3, '+59177124408', 'instagram')`,
    [p.patient, p.practice, `valeria.${p.patient.slice(-2)}@tramo2.local`],
  );
  await owner.query(
    `insert into medical_history (practice_id, patient_id, has_allergies, allergies,
                                  allergies_source, allergies_source_at, past_conditions,
                                  past_conditions_source, past_conditions_source_at)
     values ($1, $2, true, '{lidocaína}', 'doctor', now(), '{herpes}', 'doctor', now())`,
    [p.practice, p.patient],
  );
  await owner.query(
    `insert into patient_link (id, practice_id, patient_id, account_id, status, email,
                               practice_name, practitioner_name, city)
     values ($1, $2, $3, $4, $5, $6, 'Clínica Paz', 'Dra. Andrea Paz', 'Santa Cruz')`,
    [p.link, p.practice, p.patient, p.account, p.status, `valeria.${p.patient.slice(-2)}@tramo2.local`],
  );
}

beforeAll(async () => {
  // `medical_history_audit` y `access_audit` NO tienen clave foránea hacia lo que describen
  // (§12.2.8): sobreviven al borrado de la ficha, así que se limpian a mano o la segunda
  // corrida cuenta las filas de la primera.
  await owner.query(`delete from medical_history_audit where patient_id = any($1::uuid[])`, [
    [ANA.patient, THEIRS.patient],
  ]);
  await owner.query(`delete from access_audit where subject_id = any($1::uuid[])`, [
    [ANA.patient, THEIRS.patient],
  ]);
  await owner.query(`delete from practice where id = any($1::uuid[])`, [
    [MINE.practice, OTHER.practice],
  ]);
  await owner.query(`delete from account where id = any($1::uuid[])`, [
    [MINE.doctor, OTHER.doctor, ANA.account],
  ]);
  await seedPractice({ ...MINE, account: MINE.doctor, name: 'Clínica Paz' });
  await seedPractice({ ...OTHER, account: OTHER.doctor, name: 'Clínica de al lado' });
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, 'ana@tramo2.local', 'patient', 'latam', 'Ana', 'Antelo')`,
    [ANA.account],
  );
  await seedPatient({
    practice: MINE.practice,
    patient: ANA.patient,
    link: ANA.link,
    account: ANA.account,
    status: 'vinculada',
  });
  await seedPatient({
    practice: OTHER.practice,
    patient: THEIRS.patient,
    link: THEIRS.link,
    account: null,
    status: 'invitada',
  });
});

afterAll(async () => {
  await owner.query(`delete from practice where id = any($1::uuid[])`, [
    [MINE.practice, OTHER.practice],
  ]);
  await owner.query(`delete from account where id = any($1::uuid[])`, [
    [MINE.doctor, OTHER.doctor, ANA.account],
  ]);
  await owner.end();
  await app.end();
});

describe('otra consulta no existe para mí', () => {
  it('la lista solo trae las fichas propias, y la ficha de al lado es un 404', async () => {
    const mine = await list.run({}, doctor(MINE.practice, MINE.doctor));
    expect(mine.pacientes.map((p) => p.id)).toEqual([ANA.patient]);

    // Y al revés: la de al lado ve la suya y no la mía.
    const theirs = await list.run({}, doctor(OTHER.practice, OTHER.doctor));
    expect(theirs.pacientes.map((p) => p.id)).toEqual([THEIRS.patient]);

    // Con el identificador exacto: no se distingue «no es tuya» de «no existe».
    await expect(
      file.run(THEIRS.patient, doctor(MINE.practice, MINE.doctor)),
    ).rejects.toMatchObject({ code: 'paciente_no_existe' });
    // Y la escritura tampoco alcanza: el `UPDATE` no toca una fila de otra consulta.
    await expect(
      edit.run(THEIRS.patient, { celular: '+59177000000' }, doctor(MINE.practice, MINE.doctor)),
    ).rejects.toMatchObject({ code: 'paciente_no_existe' });
  });

  it('recepción no abre la ficha, y sí puede buscar', async () => {
    const reception: Caller = {
      ...doctor(MINE.practice, MINE.doctor),
      role: 'doctor',
      permissions: ['pacientes:leer'],
    };
    await expect(list.run({}, reception)).resolves.toMatchObject({ cuantas: 1 });
    await expect(file.run(ANA.patient, reception)).rejects.toMatchObject({ code: 'sin_permiso' });
  });
});

describe('la lista y la ficha', () => {
  it('busca por trigramas y trae la alerta, que es una palabra y no un dato', async () => {
    const found = await list.run({ busca: 'valeri' }, doctor(MINE.practice, MINE.doctor));
    expect(found.pacientes[0]).toMatchObject({
      nombre_completo: 'Valeria Antelo',
      edad: 34,
      vinculo: 'vinculada',
      alerta: 'alergias',
      ultima_sesion_en: null,
    });
    // Una búsqueda de un carácter no se atiende.
    await expect(
      list.run({ busca: 'v' }, doctor(MINE.practice, MINE.doctor)),
    ).rejects.toMatchObject({ code: 'busqueda_muy_corta' });
  });

  it('la ficha trae el vínculo y los antecedentes, y abrirla deja su línea en la bitácora', async () => {
    const before = await owner.query<{ n: string }>(
      `select count(*)::text as n from access_audit
        where subject_id = $1 and action = 'paciente.ficha_abierta'`,
      [ANA.patient],
    );
    const ficha = await file.run(ANA.patient, doctor(MINE.practice, MINE.doctor));

    expect(ficha).toMatchObject({
      nombre: 'Valeria',
      edad: 34,
      estado: 'activa',
      vinculo: { estado: 'vinculada', ya_eligio_contrasena: false },
    });
    expect(ficha.antecedentes.alergias).toEqual({ tiene: true, cuales: ['lidocaína'] });
    expect(ficha.antecedentes.fuentes.alergias).toMatchObject({ quien: 'doctor' });
    // Un campo que nadie llenó es `null`, que es distinto de un campo en `false`.
    expect(ficha.antecedentes.fuentes.notas).toBeNull();

    const after = await owner.query<{ n: string }>(
      `select count(*)::text as n from access_audit
        where subject_id = $1 and action = 'paciente.ficha_abierta'`,
      [ANA.patient],
    );
    expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n) + 1);
  });
});

describe('editar, archivar y reactivar', () => {
  it('el PATCH cambia solo lo que nombra, y avisa de los dos correos', async () => {
    const changed = await edit.run(
      ANA.patient,
      { celular: '+59170000000', correo: 'otro@tramo2.local' },
      doctor(MINE.practice, MINE.doctor),
    );
    // La ficha está vinculada: el correo de la cuenta NO cambió y la app tiene que decirlo.
    expect(changed).toMatchObject({ aviso_correo: true });

    const ficha = await file.run(ANA.patient, doctor(MINE.practice, MINE.doctor));
    expect(ficha.celular).toBe('+59170000000');
    expect(ficha.correo).toBe('otro@tramo2.local');
    // Y el del acceso sigue siendo el de antes: son dos correos y no se unifican.
    expect(ficha.vinculo?.correo).toBe(`valeria.${ANA.patient.slice(-2)}@tramo2.local`);
    // Lo que no se nombró no se tocó.
    expect(ficha.nombre).toBe('Valeria');

    await expect(edit.run(ANA.patient, {}, doctor(MINE.practice, MINE.doctor))).rejects.toMatchObject(
      { code: 'nada_que_cambiar' },
    );
  });

  it('archivar es idempotente y no deja editar; reactivar la devuelve', async () => {
    const first = await edit.archive(ANA.patient, doctor(MINE.practice, MINE.doctor), true);
    expect(first).toMatchObject({ estado: 'archivada' });

    // La misma fecha en el reintento: es la del archivado de verdad, no la de este segundo.
    const again = await edit.archive(ANA.patient, doctor(MINE.practice, MINE.doctor), true);
    expect(again).toEqual(first);

    await expect(
      edit.run(ANA.patient, { celular: '+59177124408' }, doctor(MINE.practice, MINE.doctor)),
    ).rejects.toMatchObject({ code: 'paciente_archivada' });

    // Y sale de la lista por omisión, pero `estado=todas` la trae.
    const active = await list.run({}, doctor(MINE.practice, MINE.doctor));
    expect(active.cuantas).toBe(0);
    const all = await list.run({ estado: 'todas' }, doctor(MINE.practice, MINE.doctor));
    expect(all.cuantas).toBe(1);

    const back = await edit.archive(ANA.patient, doctor(MINE.practice, MINE.doctor), false);
    expect(back).toMatchObject({ estado: 'activa', archivada_en: null });
  });

  it('una ficha con una cita por delante NO se archiva', async () => {
    // La cita viva la pone la base: lo que se prueba es el muro del archivado, no la agenda.
    const { rows } = await owner.query<{ id: string }>(
      `insert into treatment (practice_id, name, category, duration_minutes, planned_sessions)
       values ($1, 'Valoración', 'valoracion', 30, 1) returning id`,
      [MINE.practice],
    );
    const treatment = rows[0]!.id;
    const { rows: made } = await owner.query<{ id: string }>(
      `insert into appointment (practice_id, patient_id, treatment_id, starts_at, ends_at,
                                status, price_cents)
       values ($1, $2, $3, now() + interval '5 days', now() + interval '5 days 30 minutes',
               'confirmada', 0)
       returning id`,
      [MINE.practice, ANA.patient, treatment],
    );

    // «Una ficha archivada con una cita viva es una paciente que se presenta y no está en la
    // agenda»: es el 409 que el contrato describe para justificar su existencia.
    await expect(
      edit.archive(ANA.patient, doctor(MINE.practice, MINE.doctor), true),
    ).rejects.toMatchObject({ code: 'cita_futura' });

    // Cancelada, la ficha se archiva: lo que bloquea es la cita VIVA, no cualquier fila.
    await owner.query(
      `update appointment set status = 'cancelada', cancelled_at = now(), cancelled_by = 'practice'
        where id = $1`,
      [made[0]!.id],
    );
    const archived = await edit.archive(ANA.patient, doctor(MINE.practice, MINE.doctor), true);
    expect(archived).toMatchObject({ estado: 'archivada' });
    await edit.archive(ANA.patient, doctor(MINE.practice, MINE.doctor), false);

    await owner.query(`delete from appointment where patient_id = $1`, [ANA.patient]);
    await owner.query(`delete from treatment where id = $1`, [treatment]);
  });
});

describe('los vínculos, que son de la paciente', () => {
  it('ella ve el suyo; una doctora no entra a esta pantalla', async () => {
    const mine = await links.list(ana);
    expect(mine.vinculos).toHaveLength(1);
    expect(mine.vinculos[0]).toMatchObject({
      consulta: 'Clínica Paz',
      doctora: 'Dra. Andrea Paz',
      ciudad: 'Santa Cruz',
      ficha_medica_pendiente: true,
    });

    await expect(links.list(doctor(MINE.practice, MINE.doctor))).rejects.toMatchObject({
      code: 'rol_no_corresponde',
    });
    // Un vínculo de otra cuenta no es suyo: el mismo 404 que uno inventado.
    await expect(links.decide(THEIRS.link, ana, true)).rejects.toMatchObject({
      code: 'vinculo_no_existe',
    });
  });

  it('rechazar revoca y no borra la ficha; decidir dos veces es 409', async () => {
    await owner.query(`update patient_link set status = 'invitada' where id = $1`, [ANA.link]);

    const rejected = await links.decide(ANA.link, ana, false);
    expect(rejected.estado).toBe('revocada');

    await expect(links.decide(ANA.link, ana, true)).rejects.toMatchObject({
      code: 'vinculo_ya_resuelto',
    });

    // El expediente es de la consulta y se conserva: la ficha sigue ahí.
    const ficha = await file.run(ANA.patient, doctor(MINE.practice, MINE.doctor));
    expect(ficha.vinculo?.estado).toBe('revocada');
  });
});

describe('la ficha médica que llena la paciente', () => {
  it('lo que escribió la doctora NO se pisa, y la respuesta lo dice', async () => {
    await owner.query(`update patient_link set status = 'vinculada' where id = $1`, [ANA.link]);

    const saved = await history.run(
      ANA.link,
      {
        // Vacío en la base y suyo: se guarda.
        medicacion: { toma: true, cuales: ['ibuprofeno'] },
        embarazo_o_lactancia: 'ninguno',
        // Los dos que la doctora ya escribió: no se pisan.
        alergias: { tiene: false, cuales: [] },
        antecedentes: ['nada'],
      },
      ana,
    );

    expect(saved.guardado).toEqual(['medicacion', 'embarazo_o_lactancia']);
    expect(saved.no_guardado).toEqual([
      { campo: 'alergias', por_que: 'lo_escribio_tu_doctora' },
      { campo: 'antecedentes', por_que: 'lo_escribio_tu_doctora' },
    ]);
    expect(saved.siguiente_paso).toBe('inicio');

    // En la base: la alergia de la doctora intacta, la medicación con fuente `paciente`.
    const ficha = await file.run(ANA.patient, doctor(MINE.practice, MINE.doctor));
    expect(ficha.antecedentes.alergias).toEqual({ tiene: true, cuales: ['lidocaína'] });
    expect(ficha.antecedentes.medicacion).toEqual({ toma: true, cuales: ['ibuprofeno'] });
    expect(ficha.antecedentes.fuentes.medicacion).toMatchObject({ quien: 'patient' });

    // Y nada se borró: el valor anterior de la medicación quedó en la auditoría.
    const audit = await owner.query<{ field: string; actor_source: string }>(
      `select field, actor_source from medical_history_audit where patient_id = $1`,
      [ANA.patient],
    );
    expect(audit.rows.map((r) => r.field).sort()).toEqual([
      'embarazo_o_lactancia',
      'medicacion',
    ]);
    expect(audit.rows.every((r) => r.actor_source === 'patient')).toBe(true);
  });

  it('sin aceptar todavía no hay ficha médica que llenar', async () => {
    await owner.query(`update patient_link set status = 'invitada' where id = $1`, [ANA.link]);
    await expect(
      history.run(ANA.link, { medicacion: { toma: false, cuales: [] } }, ana),
    ).rejects.toMatchObject({ code: 'vinculo_sin_aceptar' });
  });
});

describe('los antecedentes escritos por la doctora', () => {
  it('ella escribe cualquier campo, incluso uno que ya había escrito, y queda el anterior', async () => {
    const written = (await file.writeHistory(
      ANA.patient,
      {
        // `alergias` ya era suya y lo reescribe: la doctora escribe cualquiera, SIEMPRE.
        alergias: { tiene: true, cuales: ['lidocaína', 'articaína'] },
        // Y dos que la paciente no puede tocar: el fototipo lo evalúa quien la ve.
        fototipo: 3,
        notas: 'Pide empezar por la zona periocular.',
      },
      doctor(MINE.practice, MINE.doctor),
    )) as { guardado: string[]; antecedentes: { fototipo: number | null; notas: string | null } };

    expect(written.guardado).toEqual(
      expect.arrayContaining(['alergias', 'fototipo', 'notas']),
    );
    expect(written.antecedentes.fototipo).toBe(3);
    expect(written.antecedentes.notas).toBe('Pide empezar por la zona periocular.');

    // Nada se borra: el valor anterior de las alergias quedó en la auditoría.
    const { rows } = await owner.query<{ field: string; previous_value: unknown }>(
      `select field, previous_value from medical_history_audit
        where patient_id = $1 and actor_source = 'doctor' and field = 'alergias'`,
      [ANA.patient],
    );
    expect(rows[0]?.previous_value).toEqual(['lidocaína']);
  });

  it('una ficha archivada no se edita', async () => {
    await edit.archive(ANA.patient, doctor(MINE.practice, MINE.doctor), true);
    await expect(
      file.writeHistory(ANA.patient, { fototipo: 4 }, doctor(MINE.practice, MINE.doctor)),
    ).rejects.toMatchObject({ code: 'paciente_archivada' });
    await edit.archive(ANA.patient, doctor(MINE.practice, MINE.doctor), false);
  });
});
