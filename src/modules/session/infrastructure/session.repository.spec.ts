// El repositorio de `GET /v1/session` contra la base REAL en Docker, con los roles de
// aplicación y `withTenantContext()`. Sin un solo doble, y EN NINGÚN MOMENTO SE DESACTIVA
// RLS: la siembra la hace el dueño del esquema —que es quien migra— y todo lo que se
// comprueba pasa por `app_practitioner` y `app_patient`.
//
// Por qué existe, además del aislamiento: hay dos cosas que un test con dobles no puede
// ver y que revientan en la primera petición de verdad.
//
//   1. **El camino de la paciente.** `app_patient` no tiene un solo `GRANT` sobre
//      `practice`, `license` ni `practitioner`, y un privilegio de columna se comprueba
//      ANTES que cualquier política: un `left join` a esas tres tablas no le devuelve
//      nulos, le devuelve «permiso denegado» (42501). La consulta de la consulta va aparte
//      por eso, y esto lo fija.
//   2. **Los grants por columna de la doctora.** `practice` se concede columna por columna
//      —`nota_interna` queda fuera a propósito—, así que leer `name` o la lista del primer
//      día solo funciona si esas columnas están en el `GRANT`.

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SessionRepository } from './session.repository';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

// La consulta de la prueba: su dueña, su recepción con lista explícita de permisos, y su
// paciente, que no es de ningún inquilino.
const MIA = {
  practice: 'eeeeeeee-0000-4000-8000-000000000001',
  doctora: 'eeeeeeee-0000-4000-8000-000000000002',
  recepcion: 'eeeeeeee-0000-4000-8000-000000000003',
  paciente: 'eeeeeeee-0000-4000-8000-000000000004',
  suspendida: 'eeeeeeee-0000-4000-8000-000000000005',
  sesionDoctora: 'eeeeeeee-0000-4000-8000-00000000000a',
  sesionRecepcion: 'eeeeeeee-0000-4000-8000-00000000000b',
  sesionPaciente: 'eeeeeeee-0000-4000-8000-00000000000c',
  sesionCerrada: 'eeeeeeee-0000-4000-8000-00000000000d',
  sesionSuspendida: 'eeeeeeee-0000-4000-8000-00000000000e',
  sesionRotacion: 'eeeeeeee-0000-4000-8000-000000000011',
  sesionRotacionPaciente: 'eeeeeeee-0000-4000-8000-000000000012',
  correoDoctora: 'sesion.doctora@ciclo.local',
  correoRecepcion: 'sesion.recepcion@ciclo.local',
  correoPaciente: 'sesion.paciente@ciclo.local',
  correoSuspendida: 'sesion.suspendida@ciclo.local',
};

// La consulta ajena. Su sesión existe y no se lee desde el contexto de la mía.
const AJENA = {
  practice: 'eeeeeeee-0000-4000-8000-0000000000f1',
  doctora: 'eeeeeeee-0000-4000-8000-0000000000f2',
  sesion: 'eeeeeeee-0000-4000-8000-0000000000fa',
  correoDoctora: 'sesion.ajena@ciclo.local',
};

const NADIE = 'eeeeeeee-0000-4000-8000-0000000000ff';
const REFRESCO_CADUCA = '2026-12-01T10:00:00.000Z';

// Los resúmenes de la rotación. Tienen que medir 32 o más: la función los rechaza más
// cortos a propósito, porque un resumen corto no es un resumen de HMAC-SHA256.
const RESUMEN_DOCTORA = 'd0'.repeat(32);
const RESUMEN_PACIENTE = 'd1'.repeat(32);
const RESUMEN_NUEVO = 'e0'.repeat(32);
const OTRO_RESUMEN = 'e1'.repeat(32);
const HASH = '$argon2id$v=19$m=65536,p=4,t=3$Y2ljbG9kZXZpZGExMg$BcVqHhiTZ4RrQZ4kYgVvxCuUAneDdfTxZ6qz6hUwcLY';

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 2 });
const repo = new SessionRepository(app);

const comoDoctora = (sessionId: string) => ({
  accountId: MIA.doctora,
  sessionId,
  practiceId: MIA.practice,
  accountRole: 'practitioner' as const,
});
const comoPaciente = (sessionId: string) => ({
  accountId: MIA.paciente,
  sessionId,
  practiceId: null,
  accountRole: 'paciente' as const,
});

async function seedPractice(t: { practice: string; doctora: string; correoDoctora: string }, name: string) {
  await owner.query(
    `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit)
     values ($1, $2, 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300)`,
    [t.practice, name],
  );
  await owner.query(`insert into license (practice_id, status) values ($1, 'verificada')`, [
    t.practice,
  ]);
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'practitioner', 'latam', 'Andrea', 'Paz')`,
    [t.doctora, t.correoDoctora],
  );
  await owner.query(
    `insert into practitioner (practice_id, account_id, first_name, last_name, role)
     values ($1, $2, 'Andrea', 'Paz', 'doctora')`,
    [t.practice, t.doctora],
  );
  // Su credencial definitiva: es lo que hace que `password_is_temporary` sea una lectura y
  // no el nulo de un `left join` sin fila.
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, set_at) values ($1, $2, false, now())`,
    [t.doctora, HASH],
  );
  await owner.query('update practice set owner_account_id = $1 where id = $2', [
    t.doctora,
    t.practice,
  ]);
}

async function seed() {
  await clean();
  await seedPractice(MIA, 'Clínica Paz');
  await seedPractice(AJENA, 'Clínica ajena');

  // Recepción con la lista EXPLÍCITA escrita: es el caso que distingue «los permisos de su
  // rol» de «los que el dueño le editó de uno en uno».
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'practitioner', 'latam', 'Rosa', 'Mamani')`,
    [MIA.recepcion, MIA.correoRecepcion],
  );
  await owner.query(
    `insert into practitioner (practice_id, account_id, first_name, last_name, role, permissions)
     values ($1, $2, 'Rosa', 'Mamani', 'recepcion', $3)`,
    [MIA.practice, MIA.recepcion, ['pacientes:leer', 'agenda:leer']],
  );

  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'paciente', 'latam', 'Valeria', 'Antelo'),
            ($3, $4, 'paciente', 'latam', 'Carla', 'Rojas')`,
    [MIA.paciente, MIA.correoPaciente, MIA.suspendida, MIA.correoSuspendida],
  );
  await owner.query(`update account set status = 'suspendida' where id = $1`, [MIA.suspendida]);

  // Cinco sesiones: cuatro de esta consulta y una de la ajena. La cerrada lleva su motivo,
  // que es lo que la lista de «sesiones activas» escribe al revocarla.
  await owner.query(
    `insert into session (id, account_id, practice_id, scope, refresh_hash, refresh_expires_at,
                          device_id, revoked_at, revoked_reason)
     values ($1,  $2, $3,   'completo', 'resumen-doctora',   $4, 'disp-1', null, null),
            ($5,  $6, $3,   'completo', 'resumen-recepcion', $4, 'disp-2', null, null),
            ($7,  $8, null, 'completo', 'resumen-paciente',  $4, 'disp-3', null, null),
            ($9,  $8, null, 'completo', null,                null, 'disp-4', now(), 'signed_out_others'),
            ($10, $11, null,'completo', 'resumen-suspendida', $4, 'disp-5', null, null),
            ($12, $13, $14, 'completo', 'resumen-ajena',     $4, 'disp-6', null, null),
            ($15, $2, $3,   'completo', $16,                 $4, 'disp-7', null, null),
            ($17, $8, null, 'completo', $18,                 $4, 'disp-8', null, null)`,
    [
      MIA.sesionDoctora,
      MIA.doctora,
      MIA.practice,
      REFRESCO_CADUCA,
      MIA.sesionRecepcion,
      MIA.recepcion,
      MIA.sesionPaciente,
      MIA.paciente,
      MIA.sesionCerrada,
      MIA.sesionSuspendida,
      MIA.suspendida,
      AJENA.sesion,
      AJENA.doctora,
      AJENA.practice,
      MIA.sesionRotacion,
      RESUMEN_DOCTORA,
      MIA.sesionRotacionPaciente,
      RESUMEN_PACIENTE,
    ],
  );
}

async function clean() {
  await owner.query('delete from practice where id = any($1::uuid[])', [
    [MIA.practice, AJENA.practice],
  ]);
  await owner.query('delete from account where email = any($1::citext[])', [
    [MIA.correoDoctora, MIA.correoRecepcion, MIA.correoPaciente, MIA.correoSuspendida, AJENA.correoDoctora],
  ]);
}

beforeAll(seed, 60_000);
afterAll(async () => {
  await clean();
  await Promise.all([owner.end(), app.end()]);
}, 60_000);

describe('la lectura de la sesión', () => {
  it('a la doctora le da su consulta, su licencia y su lista del primer día', async () => {
    const snapshot = await repo.read(comoDoctora(MIA.sesionDoctora));

    expect(snapshot).not.toBeNull();
    expect(snapshot?.accountStatus).toBe('activa');
    expect(snapshot?.revokedAt).toBeNull();
    expect(snapshot?.refreshExpiresAt?.toISOString()).toBe(REFRESCO_CADUCA);
    expect(snapshot?.practice).toEqual({ id: MIA.practice, name: 'Clínica Paz' });
    expect(snapshot?.licenseStatus).toBe('verificada');
    // Las tres tareas nacen sin hacer y la lista sin cerrar: `siguiente_paso` es
    // `primer_dia`, y eso lo decide el caso de uso con este dato.
    expect(snapshot?.firstDayDone).toBe(false);
    // Nulo significa «los de su rol», y el 100 % de las filas de la primera entrega.
    expect(snapshot?.permissions).toBeNull();
  });

  it('a recepción le da la lista explícita que el dueño le escribió', async () => {
    const snapshot = await repo.read({
      accountId: MIA.recepcion,
      sessionId: MIA.sesionRecepcion,
      practiceId: MIA.practice,
      accountRole: 'practitioner',
    });

    expect(snapshot?.permissions).toEqual(['pacientes:leer', 'agenda:leer']);
  });

  it('a la paciente le da su sesión SIN tocar las tres tablas que su rol no puede leer', async () => {
    // Si la consulta de la consulta fuera un `left join`, esto no devolvería nulos: moriría
    // con «permiso denegado» (42501), porque `app_patient` no tiene grants ahí.
    const snapshot = await repo.read(comoPaciente(MIA.sesionPaciente));

    expect(snapshot?.practice).toBeNull();
    expect(snapshot?.licenseStatus).toBeNull();
    expect(snapshot?.permissions).toBeNull();
    expect(snapshot?.accountStatus).toBe('activa');
  });

  it('una sesión cerrada se lee con su `revoked_at`: el 401 lo decide el caso de uso', async () => {
    const snapshot = await repo.read(comoPaciente(MIA.sesionCerrada));

    expect(snapshot).not.toBeNull();
    expect(snapshot?.revokedAt).toBeInstanceOf(Date);
  });

  it('la cuenta suspendida sale como tal y no desaparece', async () => {
    const snapshot = await repo.read({
      accountId: MIA.suspendida,
      sessionId: MIA.sesionSuspendida,
      practiceId: null,
      accountRole: 'paciente',
    });

    expect(snapshot?.accountStatus).toBe('suspendida');
  });
});

describe('qué ve otro inquilino · nada', () => {
  it('la sesión de la doctora de otra consulta no devuelve fila', async () => {
    expect(await repo.read(comoDoctora(AJENA.sesion))).toBeNull();
  });

  it('la sesión de su propia paciente tampoco: la política es por CUENTA, no por consulta', async () => {
    expect(await repo.read(comoDoctora(MIA.sesionPaciente))).toBeNull();
  });

  it('y la paciente no lee la de su doctora', async () => {
    expect(await repo.read(comoPaciente(MIA.sesionDoctora))).toBeNull();
  });

  it('un `sid` que no existe devuelve lo mismo que uno ajeno: nulo', async () => {
    expect(await repo.read(comoDoctora(NADIE))).toBeNull();
  });
});

// =========================================================================================
// POST /v1/session/refresh · el mapeo de las catorce columnas y el ROLLBACK, que es lo que
// esta capa añade. La rotación, el reuso y la ventana de 20 s son de la base y las prueba
// `refresh-and-first-use.spec.ts` contra el motor: aquí no se repiten.
// =========================================================================================

const nada = () => Promise.resolve();

// Las dos vidas del contrato en segundos, en el orden de la función: paciente, consulta.
const VIDAS = {
  patientSeconds: 30 * 24 * 60 * 60,
  practitionerSeconds: 12 * 60 * 60,
};

/** Cuántas horas desde ahora, redondeado: la caducidad la calcula la base con `now()`. */
const horasHasta = (cuando: Date | null | undefined) =>
  cuando === null || cuando === undefined
    ? null
    : Math.round((cuando.getTime() - Date.now()) / 3_600_000);

async function filaDeSesion(sessionId: string) {
  const { rows } = await owner.query<{ refresh_hash: string | null; refresh_expires_at: Date | null }>(
    'select refresh_hash, refresh_expires_at from session where id = $1',
    [sessionId],
  );
  return rows[0];
}

describe('la rotación del refresco', () => {
  it('rota y devuelve el veredicto con el rol de la consulta y los tres hechos del paso', async () => {
    const rotated = await repo.rotate({
      digest: RESUMEN_DOCTORA,
      newDigest: RESUMEN_NUEVO,
      ...VIDAS,
      withinTransaction: nada,
    });

    expect(rotated.verdict).toBe('rotated');
    expect(rotated.sessionId).toBe(MIA.sesionRotacion);
    expect(rotated.accountId).toBe(MIA.doctora);
    expect(rotated.practiceId).toBe(MIA.practice);
    expect(rotated.scope).toBe('completo');
    // `role` es `account.role` y NO es el `rol` del token; el del token sale del de al lado.
    expect(rotated.accountRole).toBe('practitioner');
    expect(rotated.practitionerRole).toBe('doctora');
    expect(rotated.permissions).toBeNull();
    expect(rotated.accountStatus).toBe('activa');
    expect(rotated.passwordIsTemporary).toBe(false);
    expect(rotated.licenseStatus).toBe('verificada');
    expect(rotated.firstDayDone).toBe(false);
    // La caducidad la calcula la FUNCIÓN con el rol delante (0020): a una doctora le toca
    // el hueco de 12 h, no el de 30 días de la paciente.
    expect(horasHasta(rotated.refreshExpiresAt)).toBe(12);
    expect(rotated.graced).toBe(false);
    // Y la fila quedó con el resumen nuevo: el viejo ya no es el vigente.
    expect((await filaDeSesion(MIA.sesionRotacion))?.refresh_hash).toBe(RESUMEN_NUEVO);
  });

  it('si lo de dentro de la transacción lanza, el ROLLBACK deja el refresco que llegó valiendo', async () => {
    const antes = await filaDeSesion(MIA.sesionRotacionPaciente);

    await expect(
      repo.rotate({
        digest: RESUMEN_PACIENTE,
        // Otro, y no el de la prueba anterior: `session_refresh_uq` es único sobre la
        // columna, así que dos filas no pueden llevar el mismo resumen vigente.
        newDigest: OTRO_RESUMEN,
        ...VIDAS,
        // Es exactamente lo que hace el `429`: cuenta, no cabe, y lanza.
        withinTransaction: () => Promise.reject(new Error('demasiados refrescos')),
      }),
    ).rejects.toThrow(/demasiados refrescos/);

    const despues = await filaDeSesion(MIA.sesionRotacionPaciente);
    expect(despues?.refresh_hash).toBe(RESUMEN_PACIENTE);
    expect(despues?.refresh_expires_at?.toISOString()).toBe(antes?.refresh_expires_at?.toISOString());
  });

  it('un resumen que no está en ninguna fila es `invalid` y no dice de quién era', async () => {
    const rotated = await repo.rotate({
      digest: 'f0'.repeat(32),
      newDigest: RESUMEN_NUEVO,
      ...VIDAS,
      withinTransaction: nada,
    });

    expect(rotated.verdict).toBe('invalid');
    expect(rotated.sessionId).toBeNull();
    expect(rotated.accountId).toBeNull();
    expect(rotated.practiceId).toBeNull();
    expect(rotated.accountStatus).toBeNull();
  });

  it('a la paciente le toca el hueco de 30 días, y lo elige la base con el rol en la mano', async () => {
    // Una sola transacción, también para ella: la función ya calcula la caducidad, así que
    // no hay un segundo `UPDATE` que pueda fallar después de una rotación confirmada.
    const rotated = await repo.rotate({
      digest: RESUMEN_PACIENTE,
      newDigest: 'e2'.repeat(32),
      ...VIDAS,
      withinTransaction: nada,
    });

    expect(rotated.verdict).toBe('rotated');
    expect(rotated.accountRole).toBe('paciente');
    expect(rotated.practitionerRole).toBeNull();
    expect(rotated.licenseStatus).toBeNull();
    // Sin consulta no hay primer día que terminar.
    expect(rotated.firstDayDone).toBe(true);
    expect(horasHasta(rotated.refreshExpiresAt)).toBe(30 * 24);
    // Y la fila quedó con esa caducidad, no con la de la doctora.
    expect(horasHasta((await filaDeSesion(MIA.sesionRotacionPaciente))?.refresh_expires_at)).toBe(
      30 * 24,
    );
  });

  it('las dos vidas al revés no dejan a una doctora con 30 días: la base pone la cota', async () => {
    // La cota vive en la base (31 días y 13 h) y el número en el contrato. Es lo que
    // convierte un cambio de orden de los dos argumentos en un fallo a gritos.
    await expect(
      repo.rotate({
        digest: RESUMEN_DOCTORA,
        newDigest: 'e3'.repeat(32),
        patientSeconds: VIDAS.practitionerSeconds,
        practitionerSeconds: VIDAS.patientSeconds,
        withinTransaction: nada,
      }),
    ).rejects.toThrow(/vida del refresco de doctora esta fuera de rango/);
  });
});
