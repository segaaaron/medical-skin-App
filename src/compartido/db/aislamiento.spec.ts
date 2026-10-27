// La prueba bloqueante de §7.3: falla si el inquilino A lee una fila del B.
// Contra la base real en Docker, sin un solo doble: un mock de RLS prueba el mock.
//
// Y la prueba que de verdad importa, la última de este archivo: la misma comprobación a
// través de PgBouncer en modo transacción (6432), que es donde se vería la fuga si alguien
// fijara el contexto con un `SET` de sesión en vez de con `set_config(..., true)`.
//
// En ningún momento se desactiva RLS. Las filas de prueba las siembra la conexión del
// DUEÑO del esquema, que es la que migra; las lecturas, las únicas que se comprueban, van
// siempre por los tres roles de aplicación y por el ayudante de contexto.

import { Pool, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { enContextoDeInquilino, type ContextoInquilino } from './contexto-inquilino';

const urlDueno = process.env.DATABASE_URL_OWNER ?? 'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const urlApp = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';
const urlPooler = process.env.DATABASE_URL_POOLER ?? 'postgresql://medskin:dev_local_only@localhost:6432/medskin';

// Identificadores fijos: así una ejecución que se corta no deja basura que la siguiente
// no sepa limpiar.
const A = {
  practice: 'aaaaaaaa-0000-4000-8000-000000000001',
  licencia: 'aaaaaaaa-0000-4000-8000-000000000002',
  practitioner: 'aaaaaaaa-0000-4000-8000-000000000003',
  cuenta: 'aaaaaaaa-0000-4000-8000-000000000004',
  sesion: 'aaaaaaaa-0000-4000-8000-000000000005',
};
const B = {
  practice: 'bbbbbbbb-0000-4000-8000-000000000001',
  licencia: 'bbbbbbbb-0000-4000-8000-000000000002',
  practitioner: 'bbbbbbbb-0000-4000-8000-000000000003',
  cuenta: 'bbbbbbbb-0000-4000-8000-000000000004',
  sesion: 'bbbbbbbb-0000-4000-8000-000000000005',
};
const PACIENTE = {
  cuenta: 'cccccccc-0000-4000-8000-000000000001',
  sesion: 'cccccccc-0000-4000-8000-000000000002',
  codigo: 'cccccccc-0000-4000-8000-000000000003',
};
// La consola no es un inquilino y su operador no tiene fila en `cuenta`: solo hace falta
// un `cuenta_id` para el contexto.
const PLATAFORMA = { cuenta: 'dddddddd-0000-4000-8000-000000000001' };

const ctxDoctoraA: ContextoInquilino = { rol: 'app_doctora', practiceId: A.practice, cuentaId: A.cuenta };
const ctxDoctoraB: ContextoInquilino = { rol: 'app_doctora', practiceId: B.practice, cuentaId: B.cuenta };
const ctxPaciente: ContextoInquilino = { rol: 'app_paciente', cuentaId: PACIENTE.cuenta };
const ctxPlataforma: ContextoInquilino = { rol: 'app_plataforma', cuentaId: PLATAFORMA.cuenta };

const dueno = new Pool({ connectionString: urlDueno, max: 1 });
// max: 1 a propósito: obliga a reutilizar la misma conexión entre transacciones, que es
// donde se vería un contexto que sobrevive al COMMIT.
const app = new Pool({ connectionString: urlApp, max: 1 });
const pooler = new Pool({ connectionString: urlPooler, max: 1 });

async function sembrar() {
  await limpiar();
  const lado = async (l: typeof A, nombre: string, correo: string) => {
    await dueno.query(
      `insert into practice (id, nombre, region, pais, zona_horaria, moneda, plan, limite_pacientes, nota_interna)
       values ($1, $2, 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300, 'nota de la consola')`,
      [l.practice, nombre],
    );
    await dueno.query(`insert into licencia (id, practice_id, estado) values ($1, $2, 'sin_enviar')`, [
      l.licencia,
      l.practice,
    ]);
    await dueno.query(
      `insert into cuenta (id, correo, rol, region, nombre, apellido)
       values ($1, $2, 'practitioner', 'latam', 'Andrea', 'Paz')`,
      [l.cuenta, correo],
    );
    await dueno.query(
      `insert into practitioner (id, practice_id, cuenta_id, nombre, apellido, rol)
       values ($1, $2, $3, 'Andrea', 'Paz', 'duena')`,
      [l.practitioner, l.practice, l.cuenta],
    );
    await dueno.query(
      `insert into credencial (cuenta_id, hash, es_temporal, temporal_caduca_en)
       values ($1, 'argon2id$de-prueba', true, now() + interval '72 hours')`,
      [l.cuenta],
    );
    await dueno.query(
      `insert into sesion (id, cuenta_id, practice_id, alcance, dispositivo_id, app_version, plataforma)
       values ($1, $2, $3, 'completo', 'disp-1', '2.4.1', 'ios')`,
      [l.sesion, l.cuenta, l.practice],
    );
    await dueno.query(
      `insert into clave_idempotencia (clave, cuenta_id, practice_id, cuerpo_hash, caduca_en)
       values ('clave-de-prueba', $1, $2, 'sha256-x', now() + interval '24 hours')`,
      [l.cuenta, l.practice],
    );
    await dueno.query(
      `insert into service_failure (service, operation, severity, error_code, error_message, practice_id, trace_id, will_retry)
       values ('api', 'acceso.entrar', 'error', 'fallo_de_servicio', 'VipsJpeg: Premature end of input file', $1, $2, false)`,
      [l.practice, `trace-${nombre}`],
    );
    await dueno.query(
      `insert into acceso_auditoria (practice_id, actor_cuenta_id, actor_etiqueta, accion)
       values ($1, $2, 'Andrea Paz', 'licencia.enviar')`,
      [l.practice, l.cuenta],
    );
  };

  await lado(A, 'Clinica A', 'doctora.a@prueba.local');
  await lado(B, 'Clinica B', 'doctora.b@prueba.local');

  await dueno.query(
    `insert into cuenta (id, correo, rol, region, nombre, apellido)
     values ($1, 'paciente@prueba.local', 'paciente', 'latam', 'Valeria', 'Antelo')`,
    [PACIENTE.cuenta],
  );
  await dueno.query(
    `insert into credencial (cuenta_id, hash, es_temporal, temporal_caduca_en)
     values ($1, 'argon2id$de-prueba', true, now() + interval '72 hours')`,
    [PACIENTE.cuenta],
  );
  await dueno.query(
    `insert into sesion (id, cuenta_id, alcance, dispositivo_id) values ($1, $2, 'completo', 'disp-2')`,
    [PACIENTE.sesion, PACIENTE.cuenta],
  );
  await dueno.query(
    `insert into codigo_recuperacion (id, cuenta_id, codigo_hash, caduca_en)
     values ($1, $2, 'argon2id$codigo', now() + interval '10 minutes')`,
    [PACIENTE.codigo, PACIENTE.cuenta],
  );
}

async function limpiar() {
  await dueno.query('delete from practice where id = any($1::uuid[])', [[A.practice, B.practice]]);
  await dueno.query('delete from cuenta where id = any($1::uuid[])', [[A.cuenta, B.cuenta, PACIENTE.cuenta]]);
  // Estas tres no se las lleva ningún cascade porque no tienen claves foráneas: la de
  // idempotencia porque su inquilino es «el de quien llama», y las dos bitácoras porque
  // deben sobrevivir al borrado de lo que describen (§12.2.8).
  await dueno.query('delete from clave_idempotencia where cuenta_id = any($1::uuid[])', [
    [A.cuenta, B.cuenta, PACIENTE.cuenta],
  ]);
  await dueno.query('delete from service_failure where practice_id = any($1::uuid[])', [[A.practice, B.practice]]);
  await dueno.query('delete from acceso_auditoria where practice_id = any($1::uuid[])', [[A.practice, B.practice]]);
}

/**
 * Lee por el rol y el contexto que se le den, y devuelve las filas. Todas las columnas que
 * estas pruebas leen son identificadores o cadenas, así que la forma por defecto basta.
 */
function leer<T extends QueryResultRow = Record<string, string>>(
  pool: Pool,
  ctx: ContextoInquilino,
  sql: string,
  params: unknown[] = [],
) {
  return enContextoDeInquilino(pool, ctx, async (cliente) => (await cliente.query<T>(sql, params)).rows);
}

/**
 * «No lee nada» tiene dos formas legítimas y las dos valen: cero filas porque la política
 * las filtró, o permiso denegado porque el rol no tiene ni el grant. La segunda es la más
 * fuerte: no hay consulta que escribir.
 */
async function loQueVe(pool: Pool, ctx: ContextoInquilino, sql: string, params: unknown[] = []) {
  try {
    return `${(await leer(pool, ctx, sql, params)).length} filas`;
  } catch (fallo) {
    if ((fallo as { code?: string }).code === '42501') return 'permiso denegado';
    throw fallo;
  }
}

beforeAll(sembrar, 30_000);
afterAll(async () => {
  await limpiar();
  await Promise.all([dueno.end(), app.end(), pooler.end()]);
});

describe('aislamiento entre inquilinos · conexión directa (5433)', () => {
  it('el inquilino A no lee ni una fila del B, tabla por tabla', async () => {
    const delB = {
      practice: await loQueVe(app, ctxDoctoraA, 'select id from practice where id = $1', [B.practice]),
      licencia: await loQueVe(app, ctxDoctoraA, 'select id from licencia where practice_id = $1', [B.practice]),
      practitioner: await loQueVe(app, ctxDoctoraA, 'select id from practitioner where practice_id = $1', [B.practice]),
      clave_idempotencia: await loQueVe(app, ctxDoctoraA, 'select clave from clave_idempotencia where practice_id = $1', [B.practice]),
      service_failure: await loQueVe(app, ctxDoctoraA, 'select id from service_failure where practice_id = $1', [B.practice]),
      acceso_auditoria: await loQueVe(app, ctxDoctoraA, 'select id from acceso_auditoria where practice_id = $1', [B.practice]),
    };
    expect(delB).toEqual({
      practice: '0 filas',
      licencia: '0 filas',
      practitioner: '0 filas',
      clave_idempotencia: '0 filas',
      service_failure: '0 filas',
      acceso_auditoria: '0 filas',
    });

    // Y no pasa por estar todo vacío: con su propio contexto, A sí ve lo suyo.
    const propio = {
      practice: (await leer(app, ctxDoctoraA, 'select id from practice')).map((f) => f.id),
      licencia: (await leer(app, ctxDoctoraA, 'select practice_id from licencia')).map((f) => f.practice_id),
      practitioner: (await leer(app, ctxDoctoraA, 'select practice_id from practitioner')).map((f) => f.practice_id),
      clave_idempotencia: (await leer(app, ctxDoctoraA, 'select practice_id from clave_idempotencia')).map((f) => f.practice_id),
      service_failure: (await leer(app, ctxDoctoraA, 'select practice_id from service_failure')).map((f) => f.practice_id),
      acceso_auditoria: (await leer(app, ctxDoctoraA, 'select practice_id from acceso_auditoria')).map((f) => f.practice_id),
    };
    expect(propio).toEqual({
      practice: [A.practice],
      licencia: [A.practice],
      practitioner: [A.practice],
      clave_idempotencia: [A.practice],
      service_failure: [A.practice],
      acceso_auditoria: [A.practice],
    });
  });

  it('una cuenta no lee la cuenta, la credencial ni la sesión de otra', async () => {
    // `cuenta` no lleva practice_id: su aislamiento es por fila (§12.2.1).
    expect({
      cuenta: await loQueVe(app, ctxDoctoraA, 'select id from cuenta where id = $1', [B.cuenta]),
      credencial: await loQueVe(app, ctxDoctoraA, 'select id from credencial where cuenta_id = $1', [B.cuenta]),
      sesion: await loQueVe(app, ctxDoctoraA, 'select id from sesion where cuenta_id = $1', [B.cuenta]),
    }).toEqual({ cuenta: '0 filas', credencial: '0 filas', sesion: '0 filas' });

    // Una doctora tampoco ve la sesión de su paciente: saber desde dónde entra no es
    // parte de atenderla (acceso.md).
    expect(await loQueVe(app, ctxDoctoraA, 'select id from sesion where cuenta_id = $1', [PACIENTE.cuenta])).toBe('0 filas');

    // Y la paciente lee la suya, y solo la suya.
    expect((await leer(app, ctxPaciente, 'select id from cuenta')).map((f) => f.id)).toEqual([PACIENTE.cuenta]);
    expect((await leer(app, ctxPaciente, 'select id from sesion')).map((f) => f.id)).toEqual([PACIENTE.sesion]);
  });

  it('el hash de la contraseña no se puede leer, con contexto propio y todo', async () => {
    await expect(leer(app, ctxPaciente, 'select hash from credencial')).rejects.toMatchObject({ code: '42501' });
  });

  it('el rol de plataforma no lee nada clínico, ni credenciales, ni códigos, ni sesiones', async () => {
    expect({
      practitioner: await loQueVe(app, ctxPlataforma, 'select id from practitioner'),
      credencial: await loQueVe(app, ctxPlataforma, 'select id from credencial'),
      sesion: await loQueVe(app, ctxPlataforma, 'select id from sesion'),
      codigo_recuperacion: await loQueVe(app, ctxPlataforma, 'select id from codigo_recuperacion'),
    }).toEqual({
      practitioner: 'permiso denegado',
      credencial: 'permiso denegado',
      sesion: 'permiso denegado',
      codigo_recuperacion: 'permiso denegado',
    });

    // Y no pasa porque el rol esté roto: en sus cuatro tablas sí lee (_convenciones.md).
    const practices = (await leer(app, ctxPlataforma, 'select id from practice where id = any($1::uuid[])', [[A.practice, B.practice]])).length;
    const licencias = (await leer(app, ctxPlataforma, 'select id from licencia where practice_id = any($1::uuid[])', [[A.practice, B.practice]])).length;
    const cuentas = (await leer(app, ctxPlataforma, 'select correo from cuenta where id = any($1::uuid[])', [[A.cuenta, B.cuenta, PACIENTE.cuenta]])).length;
    const fallos = (await leer(app, ctxPlataforma, 'select id from service_failure where practice_id = any($1::uuid[])', [[A.practice, B.practice]])).length;
    expect({ practices, licencias, cuentas, fallos }).toEqual({ practices: 2, licencias: 2, cuentas: 3, fallos: 2 });

    // De `cuenta` ve «correo, rol, estado y pausa», y nada más: ni el nombre.
    await expect(leer(app, ctxPlataforma, 'select nombre from cuenta')).rejects.toMatchObject({ code: '42501' });
  });

  it('ni la doctora ni la plataforma pueden leer un código de recuperación', async () => {
    expect({
      doctora: await loQueVe(app, ctxDoctoraA, 'select id from codigo_recuperacion'),
      plataforma: await loQueVe(app, ctxPlataforma, 'select id from codigo_recuperacion'),
    }).toEqual({ doctora: 'permiso denegado', plataforma: 'permiso denegado' });
  });

  it('la bitácora es inmutable: nadie puede reescribirla ni borrarla', async () => {
    await expect(
      leer(app, ctxDoctoraA, 'update acceso_auditoria set accion = $1 where practice_id = $2', ['falseada', A.practice]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      leer(app, ctxPlataforma, 'delete from acceso_auditoria where practice_id = $1', [A.practice]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('el contexto no sobrevive al COMMIT', async () => {
    expect((await leer(app, ctxDoctoraA, 'select id from practice')).length).toBe(1);

    // Misma conexión (el pool es de una), transacción nueva y sin contexto.
    const cliente = await app.connect();
    try {
      const { rows } = await cliente.query<{ rol: string; practice: string; cuenta: string }>(
        `select current_user as rol,
                coalesce(current_setting('medskin.practice_id', true), '') as practice,
                coalesce(current_setting('medskin.cuenta_id', true), '') as cuenta`,
      );
      expect(rows[0]).toEqual({ rol: 'medskin', practice: '', cuenta: '' });
      // Y sin rol adoptado la conexión de la aplicación no puede leer nada: NOINHERIT y
      // sin grants directos. Falla cerrada.
      await expect(cliente.query('select id from practice')).rejects.toMatchObject({ code: '42501' });
    } finally {
      cliente.release();
    }
  });
});

describe('a través de PgBouncer en modo transacción (6432)', () => {
  it('el aislamiento se mantiene cuando dos inquilinos se turnan la misma conexión', async () => {
    // Las dos transacciones salen por el mismo socket de cliente y, con un solo cliente
    // activo, por la misma conexión al servidor. Si el contexto se filtrara, A vería B.
    const deA = (await leer(pooler, ctxDoctoraA, 'select id from practice')).map((f) => f.id);
    const deB = (await leer(pooler, ctxDoctoraB, 'select id from practice')).map((f) => f.id);
    const otraVezA = (await leer(pooler, ctxDoctoraA, 'select id from practice')).map((f) => f.id);

    expect(deA).toEqual([A.practice]);
    expect(deB).toEqual([B.practice]);
    expect(otraVezA).toEqual([A.practice]);

    expect({
      aVeB: await loQueVe(pooler, ctxDoctoraA, 'select id from practice where id = $1', [B.practice]),
      bVeA: await loQueVe(pooler, ctxDoctoraB, 'select id from practice where id = $1', [A.practice]),
    }).toEqual({ aVeB: '0 filas', bVeA: '0 filas' });
  });

  it('el rol adoptado tampoco sobrevive al COMMIT detrás del pooler', async () => {
    await leer(pooler, ctxPlataforma, 'select id from practice limit 1');

    const cliente = await pooler.connect();
    try {
      const { rows } = await cliente.query<{ rol: string; practice: string; cuenta: string }>(
        `select current_user as rol, coalesce(current_setting('medskin.practice_id', true), '') as practice`,
      );
      expect(rows[0]).toEqual({ rol: 'medskin', practice: '' });
      await expect(cliente.query('select id from practice')).rejects.toMatchObject({ code: '42501' });
    } finally {
      cliente.release();
    }
  });

  it('la fuga que justifica la regla: un SET de sesión SÍ se filtra al siguiente cliente', async () => {
    // Esta prueba no comprueba nuestro código: comprueba el motor. Existe para que la
    // regla 2 de §7.3 no sea folclore. Son tres pasos, en este orden a propósito, porque
    // el segundo ensucia la conexión del servidor y el tercero la deja limpia otra vez.

    // 1 · Lo que hace el ayudante: `set_config(..., true)`. No se filtra.
    await leer(pooler, ctxDoctoraA, 'select 1');
    const limpio = new Pool({ connectionString: urlPooler, max: 1 });
    try {
      const { rows } = await limpio.query<{ heredado: string }>(
        `select coalesce(current_setting('medskin.practice_id', true), '') as heredado`,
      );
      expect(rows[0]?.heredado).toBe('');
    } finally {
      await limpio.end();
    }

    // 2 · Lo que nadie hace nunca: un `SET` de sesión. Dos sockets de cliente distintos,
    // uno detrás del otro, sobre el mismo PgBouncer en modo transacción.
    const primero = new Pool({ connectionString: urlPooler, max: 1 });
    await primero.query(`select set_config('medskin.practice_id', $1, false)`, [A.practice]);
    await primero.end(); // el cliente se va; la conexión al servidor vuelve al pool tal cual

    const segundo = new Pool({ connectionString: urlPooler, max: 1 });
    let heredado: string;
    try {
      const { rows } = await segundo.query<{ heredado: string }>(
        `select coalesce(current_setting('medskin.practice_id', true), '') as heredado`,
      );
      heredado = rows[0]?.heredado ?? '';
    } finally {
      await segundo.end();
    }
    // Si esto dejara de filtrar, hay que revisar la configuración del pooler antes de
    // alegrarse: la regla se escribió porque filtra.
    expect(heredado).toBe(A.practice);

    // 3 · Y se deja la conexión como estaba, que es la otra cara de la misma moneda: lo
    // que un cliente ensucia en sesión se lo come el siguiente, incluida esta prueba.
    const tercero = new Pool({ connectionString: urlPooler, max: 1 });
    try {
      await tercero.query(`select set_config('medskin.practice_id', '', false)`);
      const { rows } = await tercero.query<{ heredado: string }>(
        `select coalesce(current_setting('medskin.practice_id', true), '') as heredado`,
      );
      expect(rows[0]?.heredado).toBe('');
    } finally {
      await tercero.end();
    }
  });
});
