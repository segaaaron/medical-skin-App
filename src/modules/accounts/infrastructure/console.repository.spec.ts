// LAS DOS ACCIONES DE CONSOLA CONTRA LA BASE REAL, porque lo que defienden no lo puede
// sostener un doble:
//
//   1. **Soporte no ve la contraseña.** La función devuelve dos columnas y ninguna es la
//      contraseña: no es que el controlador no la ponga, es que no la tiene de dónde sacar.
//   2. **Levantar la pausa no toca `credential`.** `app_platform` no tiene ni política ni
//      grant sobre esa tabla; lo que se comprueba aquí es que el hash de la fila es el mismo
//      después de la operación, en la base y no en un espía.
//   3. **El 404 es uno solo**: una cuenta que no existe, una borrada y —en el reenvío— una ya
//      decidida responden lo mismo, y ninguna de las dos operaciones escribe nada entonces.
//   4. **Las dos dejan su línea en `access_audit`** con el `sub` y la etiqueta del operador,
//      y **sin el correo y sin la contraseña**, que es lo único que hace revisable que
//      soporte actuó sobre la cuenta de una persona.
//
// Siembra el dueño del esquema, que es quien migra; todo lo que se comprueba pasa por
// `withTenantContext()` con el rol de verdad. En ningún momento se desactiva RLS.

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import { Argon2Passwords } from '../../../shared/security/passwords';
import { LiftAccessPause } from '../application/lift-access-pause';
import { ResendPlatformAccess } from '../application/resend-platform-access';
import type { RegistrationClock } from '../application/register-patient';
import type { PlatformDeliveryFacts } from '../domain/access-delivery';
import type { ConsoleActor, PlatformAccessMailPort } from '../domain/ports';
import { ConsoleRepository } from './console.repository';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl =
  process.env.DATABASE_URL_POOLER ??
  process.env.DATABASE_URL ??
  'postgresql://medskin:dev_local_only@localhost:5433/medskin';

// Espacio de identificadores propio: esta prueba no comparte semilla con ninguna otra.
const OPERADOR = 'c0c0c0c0-0000-4000-8000-000000000001';
const PAUSADA = 'c0c0c0c0-0000-4000-8000-000000000002';
const YA_ELIGIO = 'c0c0c0c0-0000-4000-8000-000000000003';
const BORRADA = 'c0c0c0c0-0000-4000-8000-000000000004';
const INVENTADA = 'c0c0c0c0-0000-4000-8000-000000000009';

const CORREO_PAUSADA = 'rocio.pausada@consola.local';
const CORREO_YA_ELIGIO = 'ana.eligio@consola.local';
const CORREO_BORRADA = 'borrada+c0c0c0c0@medskin.invalid';

const HASH =
  '$argon2id$v=19$m=19456,p=1,t=2$c2VtaWxsYWRlcHJ1ZWJh$BcVqHhiTZ4RrQZ4kYgVvxCuUAneDdfTxZ6qz6hUwcLY';

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 2 });

/** El operador de soporte. No tiene fila en `account` y no hace falta que la tenga. */
const SOPORTE: ConsoleActor = { subject: OPERADOR, label: 'Marcela · soporte', region: 'latam' };

const RELOJ: RegistrationClock = {
  now: () => new Date(),
  localTime: () => '18:24',
  localLongWhen: () => 'sábado 31 a las 18:24',
  localDay: () => '3 de agosto',
};

const mandados: PlatformDeliveryFacts[] = [];
const CORREO_QUE_SALE: PlatformAccessMailPort = {
  sendAccess: (facts) => {
    mandados.push(facts);
    return Promise.resolve();
  },
};
const CORREO_CAIDO: PlatformAccessMailPort = {
  sendAccess: () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:1025')),
};

function reenvio(mail: PlatformAccessMailPort = CORREO_QUE_SALE): ResendPlatformAccess {
  return new ResendPlatformAccess(
    new ConsoleRepository(app),
    new Argon2Passwords(),
    RELOJ,
    mail,
  );
}

const pausa = (): LiftAccessPause => new LiftAccessPause(new ConsoleRepository(app));

async function limpiar(): Promise<void> {
  await owner.query('delete from account where id = any($1::uuid[])', [
    [PAUSADA, YA_ELIGIO, BORRADA],
  ]);
  await owner.query('delete from access_audit where actor_account_id = $1', [OPERADOR]);
}

async function credencialDe(accountId: string): Promise<{ hash: string; is_temporary: boolean; temp_first_used_at: Date | null } | undefined> {
  const { rows } = await owner.query<{
    hash: string;
    is_temporary: boolean;
    temp_first_used_at: Date | null;
  }>('select hash, is_temporary, temp_first_used_at from credential where account_id = $1', [
    accountId,
  ]);
  return rows[0];
}

async function bitacora(): Promise<
  { action: string; actor_label: string | null; subject_id: string | null; data: Record<string, unknown> | null; practice_id: string | null }[]
> {
  const { rows } = await owner.query<{
    action: string;
    actor_label: string | null;
    subject_id: string | null;
    data: Record<string, unknown> | null;
    practice_id: string | null;
  }>(
    `select action, actor_label, subject_id, data, practice_id from access_audit
      where actor_account_id = $1 order by id`,
    [OPERADOR],
  );
  return rows;
}

beforeAll(async () => {
  await limpiar();
  // La cuenta en pausa por intentos, con su temporal SIN estrenar: es el caso de las dos.
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name, failed_attempts,
                          locked_until)
     values ($1, $2, 'patient', 'latam', 'Rocio', 'Vargas', 5, now() + interval '15 minutes')`,
    [PAUSADA, CORREO_PAUSADA],
  );
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, temp_expires_at, temp_first_used_at)
     values ($1, $2, true, now() + interval '72 hours', now() - interval '1 day')`,
    [PAUSADA, HASH],
  );
  // La que ya eligió su contraseña: el `409` del reenvío.
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, $2, 'patient', 'latam', 'Ana', 'Mendez')`,
    [YA_ELIGIO, CORREO_YA_ELIGIO],
  );
  await owner.query(
    `insert into credential (account_id, hash, is_temporary, set_at)
     values ($1, $2, false, now())`,
    [YA_ELIGIO, HASH],
  );
  // Una cuenta borrada: el mismo 404 que una inventada, en las dos rutas.
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name, status, deleted_at)
     values ($1, $2, 'patient', 'latam', 'Borrada', 'Borrada', 'borrada', now())`,
    [BORRADA, CORREO_BORRADA],
  );
});

afterAll(async () => {
  await limpiar();
  await app.end();
  await owner.end();
});

beforeEach(async () => {
  mandados.length = 0;
  await owner.query('delete from access_audit where actor_account_id = $1', [OPERADOR]);
  await owner.query(
    `update account set failed_attempts = 5, locked_until = now() + interval '15 minutes'
      where id = $1`,
    [PAUSADA],
  );
  await owner.query('update credential set hash = $2 where account_id = $1', [PAUSADA, HASH]);
});

describe('POST /v1/platform/accounts/{id}/access/resend', () => {
  it('la contraseña va a su correo y NO a la respuesta: soporte no la ve', async () => {
    const respuesta = await reenvio().run(PAUSADA, SOPORTE);

    // El cuerpo del contrato, entero: dos campos y ninguno es la contraseña.
    expect(Object.keys(respuesta).sort()).toEqual(['caduca_en', 'enviado_en']);
    expect(JSON.stringify(respuesta)).not.toMatch(/[a-z]+-[a-z]+-\d{2}/);
    const vida = new Date(respuesta.caduca_en).getTime() - Date.now();
    expect(vida).toBeGreaterThan(71 * 3600_000);
    expect(vida).toBeLessThanOrEqual(72 * 3600_000);

    // El correo salió a su propia dirección, con la temporal dentro, y es la que abre la
    // credencial que quedó en la base: lo que se manda tiene que funcionar.
    expect(mandados[0]?.email).toBe(CORREO_PAUSADA);
    const guardada = await credencialDe(PAUSADA);
    expect(guardada?.hash).not.toBe(HASH);
    expect(guardada?.is_temporary).toBe(true);
    expect(
      await new Argon2Passwords().verify(guardada?.hash ?? '', mandados[0]?.temporaryPassword ?? ''),
    ).toBe(true);
    // Y no se des-ocurre que ya probó su correo (napkin §1.10, migración 0017).
    expect(guardada?.temp_first_used_at).toBeInstanceOf(Date);
  });

  it('queda en la bitácora con quién la ejecutó, y sin el correo ni la contraseña', async () => {
    await reenvio().run(PAUSADA, SOPORTE);
    const filas = await bitacora();

    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      action: 'cuenta.acceso_pedido',
      actor_label: 'Marcela · soporte',
      subject_id: PAUSADA,
      // Esta acción no es de ninguna consulta, y `app_platform` no fija consulta.
      practice_id: null,
      data: { via: 'correo', origen: 'consola' },
    });
    const fila = JSON.stringify(filas[0]);
    expect(fila).not.toContain(CORREO_PAUSADA);
    expect(fila).not.toMatch(/[a-z]+-[a-z]+-\d{2}/);
  });

  it('una cuenta que ya eligió su contraseña es 409, y no se le toca nada', async () => {
    const fallo = await reenvio().run(YA_ELIGIO, SOPORTE).catch((e: unknown) => e);

    expect((fallo as ContractError).code).toBe('ya_eligio_su_contrasena');
    expect((fallo as ContractError).status).toBe(409);
    // La frase del catálogo, sin nombre: soporte no puede leer el nombre de nadie.
    expect((fallo as ContractError).userMessage).toBe(
      'Ya eligió su contraseña. Si no puede entrar, dile que use «Olvidé mi contraseña».',
    );
    expect((await credencialDe(YA_ELIGIO))?.hash).toBe(HASH);
    expect(mandados).toEqual([]);
    expect(await bitacora()).toEqual([]);
  });

  it('una cuenta borrada y una inventada responden lo MISMO, y no mandan nada', async () => {
    const borrada = await reenvio().run(BORRADA, SOPORTE).catch((e: unknown) => e);
    const inventada = await reenvio().run(INVENTADA, SOPORTE).catch((e: unknown) => e);

    for (const fallo of [borrada, inventada]) {
      expect((fallo as ContractError).code).toBe('cuenta_no_existe');
      expect((fallo as ContractError).status).toBe(404);
      expect((fallo as ContractError).userMessage).toBe('No encontramos esa cuenta.');
    }
    expect(mandados).toEqual([]);
    expect(await bitacora()).toEqual([]);
  });

  it('el relé caído es un 500, y su causa no lleva el correo ni la contraseña', async () => {
    const fallo = await reenvio(CORREO_CAIDO).run(PAUSADA, SOPORTE).catch((e: unknown) => e);

    expect((fallo as ContractError).code).toBe('fallo_de_servicio');
    expect((fallo as ContractError).userMessage).toBe(
      'No pudimos reenviar el acceso. El servidor no respondió: puedes volver a intentarlo.',
    );
    const cadena = cadenaDe(fallo);
    expect(cadena).toContain(PAUSADA);
    expect(cadena).toContain('ECONNREFUSED');
    expect(cadena).not.toContain(CORREO_PAUSADA);
    expect(cadena).not.toMatch(/[a-z]+-[a-z]+-\d{2}/);
    // Y reintentar SÍ sirve, que es lo que la frase promete: la línea de bitácora dice que
    // se pidió —que es verdad— y la cuenta sigue con una temporal sin estrenar.
    expect((await bitacora())[0]?.action).toBe('cuenta.acceso_pedido');
    expect((await credencialDe(PAUSADA))?.is_temporary).toBe(true);
  });
});

describe('DELETE /v1/platform/accounts/{id}/lock', () => {
  it('levanta la pausa, deja los intentos en cero y NO toca la contraseña', async () => {
    const antes = await credencialDe(PAUSADA);
    const respuesta = await pausa().run(PAUSADA, SOPORTE);

    expect(respuesta).toEqual({ pausa_hasta: null, intentos: 0 });

    const { rows } = await owner.query<{ locked_until: Date | null; failed_attempts: number }>(
      'select locked_until, failed_attempts from account where id = $1',
      [PAUSADA],
    );
    expect(rows[0]).toMatchObject({ locked_until: null, failed_attempts: 0 });
    // «No cambia su contraseña», y no es una comprobación del código: `app_platform` no
    // tiene ni política ni grant sobre `credential`.
    expect((await credencialDe(PAUSADA))?.hash).toBe(antes?.hash);
  });

  it('es idempotente: levantarla dos veces responde lo mismo', async () => {
    const primera = await pausa().run(PAUSADA, SOPORTE);
    const segunda = await pausa().run(PAUSADA, SOPORTE);
    expect(segunda).toEqual(primera);
  });

  it('queda en la bitácora, con su propia acción y sin dato de nadie', async () => {
    await pausa().run(PAUSADA, SOPORTE);
    const filas = await bitacora();

    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      action: 'cuenta.pausa_levantada',
      actor_label: 'Marcela · soporte',
      subject_id: PAUSADA,
      practice_id: null,
      data: {},
    });
    expect(JSON.stringify(filas[0])).not.toContain(CORREO_PAUSADA);
  });

  it('una cuenta borrada y una inventada son el MISMO 404, y no escriben nada', async () => {
    const borrada = await pausa().run(BORRADA, SOPORTE).catch((e: unknown) => e);
    const inventada = await pausa().run(INVENTADA, SOPORTE).catch((e: unknown) => e);

    for (const fallo of [borrada, inventada]) {
      expect((fallo as ContractError).code).toBe('cuenta_no_existe');
      expect((fallo as ContractError).status).toBe(404);
    }
    expect(await bitacora()).toEqual([]);
    // Y la cuenta borrada sigue borrada: levantarle la pausa sería devolverle un acceso que
    // el borrado le quitó.
    const { rows } = await owner.query<{ status: string; deleted_at: Date | null }>(
      'select status, deleted_at from account where id = $1',
      [BORRADA],
    );
    expect(rows[0]?.status).toBe('borrada');
    expect(rows[0]?.deleted_at).toBeInstanceOf(Date);
  });
});

/** La cadena de causas en texto: es lo que `FailureLog` recorre para escribir la fila. */
function cadenaDe(fallo: unknown): string {
  const partes: string[] = [];
  let actual: unknown = fallo;
  for (let i = 0; i < 5 && actual instanceof Error; i += 1) {
    partes.push(actual.name, actual.message);
    actual = actual.cause;
  }
  return partes.join(' · ');
}
