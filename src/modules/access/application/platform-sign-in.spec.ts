// LA PRUEBA BLOQUEANTE DE `POST /v1/platform/access`, y es una sola frase:
//
//   un correo que NO existe y una contraseña mal dan la misma respuesta, el mismo cuerpo y
//   el mismo `datos`.
//
// Importa más aquí que en la app, no menos: esta es la única ruta de `/v1/platform/…`
// alcanzable sin token, así que es la única que un desconocido puede golpear desde internet.
// Un 401 que distinguiera los dos casos serviría la lista de los correos del equipo de
// MedSkin a quien pregunte. Es un padrón.
//
// Y con ella, el ORDEN, que es lo que hace esa frase verdad: pausa → Argon2id SIEMPRE →
// 401 → y solo después `status`. Si el `403 cuenta_suspendida` saliera antes de verificar la
// contraseña, la suspensión sería el oráculo que el 401 cierra.
//
// Sin NestJS y sin base: el caso de uso recibe sus puertos.

import { describe, expect, it } from 'vitest';

import type { Config } from '../../../shared/config/config';
import { ContractError } from '../../../shared/contract/error-catalog';
import type { PlatformTokens } from '../../../shared/platform/platform-token';
import type { AccessPausePort, ClockPort, PasswordHasher, PauseState } from '../domain/ports';
import type { PlatformCredential, PlatformCredentialPort } from '../domain/platform-credential';
import { PlatformSignIn } from './platform-sign-in';

const AHORA = new Date('2026-10-30T18:14:00.000Z');
const CUENTA = '55555555-5555-4555-8555-555555555555';

/** El señuelo: sin fila, y un hash que hay que verificar igual. */
const SENUELO: PlatformCredential = {
  platformAccountId: null,
  label: null,
  permissions: null,
  status: null,
  hash: '$argon2id$senuelo',
  lockedUntil: null,
  attemptsLeft: 5,
};

const SOPORTE: PlatformCredential = {
  platformAccountId: CUENTA,
  label: 'Andrea del equipo de soporte',
  permissions: ['plataforma:consultas:crear', 'plataforma:consultas:leer'],
  status: 'activa',
  hash: '$argon2id$real',
  lockedUntil: null,
  attemptsLeft: 5,
};

const SUSPENDIDA: PlatformCredential = { ...SOPORTE, status: 'suspendida' };

const reloj: ClockPort = {
  now: () => AHORA,
  localTime: () => '14:29',
};

const cfg = { REGION: 'latam', REGION_ETIQUETA: 'Bolivia · bo-1' } as Config;

type Pasos = string[];

function montar(
  credential: PlatformCredential,
  opciones: { coincide?: boolean; enPausa?: boolean } = {},
): { caso: PlatformSignIn; pasos: Pasos } {
  const pasos: Pasos = [];

  const credentials: PlatformCredentialPort = {
    read: (email) => {
      pasos.push(`read:${email}`);
      return Promise.resolve(credential);
    },
    recordAttempt: (_email, matched) => {
      pasos.push(`attempt:${matched}`);
      return Promise.resolve();
    },
  };

  const passwords: PasswordHasher = {
    verify: () => {
      pasos.push('argon2id');
      return Promise.resolve(opciones.coincide ?? true);
    },
    hash: () => Promise.resolve('$argon2id$nuevo'),
  };

  const libre: PauseState = { paused: false, pausedUntil: null, attemptsLeft: 4 };
  const enPausa: PauseState = {
    paused: true,
    pausedUntil: new Date(AHORA.getTime() + 15 * 60_000),
    attemptsLeft: 0,
  };

  const pause: AccessPausePort = {
    peek: () => {
      pasos.push('peek');
      return Promise.resolve(opciones.enPausa === true ? enPausa : libre);
    },
    recordFailure: () => {
      pasos.push('recordFailure');
      return Promise.resolve(libre);
    },
    clear: () => {
      pasos.push('clear');
      return Promise.resolve();
    },
  };

  const tokens = {
    sign: (caller: { subject: string; label: string }) => {
      pasos.push(`sign:${caller.subject}`);
      return Promise.resolve({
        token: 'eyJhbGciOiJFZERTQSJ9.firmado',
        expiresAt: new Date(AHORA.getTime() + 900_000),
      });
    },
  } as unknown as PlatformTokens;

  return {
    caso: new PlatformSignIn(credentials, passwords, pause, tokens, reloj, cfg),
    pasos,
  };
}

async function fallo(caso: PlatformSignIn, body: unknown = { correo: 'a@b.com', contrasena: 'x' }) {
  try {
    await caso.run({ body, ip: '1.2.3.4' });
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw error;
  }
  throw new Error('la petición pasó y tenía que fallar');
}

describe('POST /v1/platform/access · el 401 no dice si el correo existe', () => {
  it('correo inexistente y contraseña mal dan EXACTAMENTE la misma respuesta', async () => {
    const inexistente = montar(SENUELO, { coincide: false });
    const malaClave = montar(SOPORTE, { coincide: false });

    const a = await fallo(inexistente.caso);
    const b = await fallo(malaClave.caso);

    expect(a.code).toBe('acceso_no_coincide');
    expect(b.code).toBe('acceso_no_coincide');
    expect(a.status).toBe(b.status);
    expect(a.body()).toEqual(b.body());
  });

  it('y los dos caminos ejecutan Argon2id, que es lo que iguala el tiempo', async () => {
    const inexistente = montar(SENUELO, { coincide: false });
    await fallo(inexistente.caso);
    expect(inexistente.pasos).toContain('argon2id');

    const malaClave = montar(SOPORTE, { coincide: false });
    await fallo(malaClave.caso);
    expect(malaClave.pasos).toContain('argon2id');
  });

  it('el orden es pausa → Argon2id → 401, y el `status` NO se mira', async () => {
    // Una cuenta suspendida con la contraseña mal responde 401, no 403: si respondiera 403
    // la suspensión sería el oráculo que el 401 cierra.
    const { caso, pasos } = montar(SUSPENDIDA, { coincide: false });
    const error = await fallo(caso);

    expect(error.code).toBe('acceso_no_coincide');
    expect(pasos.indexOf('peek')).toBeLessThan(pasos.indexOf('argon2id'));
    expect(pasos).not.toContain('sign:' + CUENTA);
  });

  it('la pausa se devuelve ANTES de verificar nada', async () => {
    const { caso, pasos } = montar(SENUELO, { enPausa: true });
    const error = await fallo(caso);

    expect(error.code).toBe('acceso_en_pausa');
    expect(error.status).toBe(429);
    expect(pasos).not.toContain('argon2id');
  });
});

describe('POST /v1/platform/access · lo que pasa', () => {
  it('entra y devuelve el token con sus permisos fuera', async () => {
    const { caso, pasos } = montar(SOPORTE);
    const salida = await caso.run({ body: { correo: 'a@b.com', contrasena: 'x' }, ip: '1.2.3.4' });

    expect(salida.token).toContain('eyJ');
    expect(salida.etiqueta).toBe('Andrea del equipo de soporte');
    expect(salida.region).toBe('latam');
    expect(salida.region_etiqueta).toBe('Bolivia · bo-1');
    // Fuera del token a propósito: es lo que la consola usa para no dibujar un botón que va
    // a responder 403.
    expect(salida.permisos).toEqual([
      'plataforma:consultas:crear',
      'plataforma:consultas:leer',
    ]);
    expect(pasos).toContain('clear');
  });

  it('suspendida con la contraseña BIEN sí responde 403, con la frase de la consola', async () => {
    const { caso } = montar(SUSPENDIDA);
    const error = await fallo(caso);

    expect(error.code).toBe('cuenta_suspendida');
    expect(error.status).toBe(403);
    expect(error.body().error.mensaje).toBe('Tu cuenta de consola está suspendida.');
  });

  it('un permiso que no está en la lista cerrada NO se firma: 500', async () => {
    const { caso, pasos } = montar({ ...SOPORTE, permissions: ['plataforma:inventado'] });
    await expect(
      caso.run({ body: { correo: 'a@b.com', contrasena: 'x' }, ip: '1.2.3.4' }),
    ).rejects.toThrow(/permiso desconocido/);
    expect(pasos).not.toContain(`sign:${CUENTA}`);
  });

  it('una fila sin permisos tampoco entra', async () => {
    const { caso } = montar({ ...SOPORTE, permissions: [] });
    await expect(
      caso.run({ body: { correo: 'a@b.com', contrasena: 'x' }, ip: '1.2.3.4' }),
    ).rejects.toThrow(/sin permisos/);
  });

  it('el cuerpo vacío se queja del campo, no del acceso', async () => {
    const { caso } = montar(SOPORTE);
    expect((await fallo(caso, { contrasena: 'x' })).code).toBe('correo_vacio');
    expect((await fallo(caso, { correo: 'a@b.com' })).code).toBe('contrasena_vacia');
  });

  it('un cuerpo con `permisos` o `region` se ignora sin avisar', async () => {
    const { caso } = montar(SOPORTE);
    const salida = await caso.run({
      body: {
        correo: 'a@b.com',
        contrasena: 'x',
        permisos: ['plataforma:suplantar'],
        region: 'eu',
      },
      ip: '1.2.3.4',
    });
    // Los dos salen del servidor: los permisos de la fila, la región del despliegue.
    expect(salida.permisos).not.toContain('plataforma:suplantar');
    expect(salida.region).toBe('latam');
  });
});
