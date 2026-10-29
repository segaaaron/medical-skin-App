// `POST /v1/recovery/code` · el orden, que es parte del contrato, y las dos cosas
// que el contrato promete y es fácil romper:
//
//   · el 401 es UNO para tres situaciones —código mal, correo sin cuenta, cuenta sin
//     código vivo— con el mismo cuerpo y el mismo contador decreciente;
//   · el intento NO SE CUENTA cuando el fallo es del servidor, porque el 500 promete que
//     «el código sigue valiendo».
//
// Y la tercera, que es de forma pero igual de dura: el token no lleva rol.

import { describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import type { LiveCode, RecoveryCodePort, RecoveryLimitsPort } from '../domain/ports';
import { CheckRecoveryCode, type CodeHasher, type RecoveryTokenPort } from './check-code';

const CUENTA = '11111111-1111-4111-8111-111111111111';
const IP = '201.131.0.9';
const PETICION = { correo: 'carla.rojas@gmail.com', codigo: '418203' };

/** El señuelo: `accountId` nulo y un hash que verificar igual. */
const SENUELO: LiveCode = {
  verdict: 'live',
  accountId: null,
  codeHash: '$argon2id$senuelo',
  expiresAt: new Date('2026-10-27T13:28:00.000Z'),
  attemptsLeft: 5,
  voidedReason: null,
};

const VIVO: LiveCode = { ...SENUELO, accountId: CUENTA, codeHash: '$argon2id$real' };

function armar(opciones: {
  codigo?: LiveCode;
  coincide?: boolean;
  intentosGastados?: number;
  codigoVivo?: boolean;
  sePidio?: boolean;
  quedan?: number;
  demasiadosPorIp?: boolean;
}) {
  const pasos: string[] = [];
  const firmados: { sub: string; alcance: string; region: string }[] = [];

  const codes: RecoveryCodePort = {
    mint: () => Promise.resolve(true),
    live: () => {
      pasos.push('codigo:vigente');
      return Promise.resolve(opciones.codigo ?? VIVO);
    },
    miss: () => {
      pasos.push('codigo:intento');
      return Promise.resolve();
    },
  };

  const limits: RecoveryLimitsPort = {
    countRequest: () => Promise.resolve({ tooMany: false }),
    countAttemptByIp: () => {
      pasos.push('contador:ip');
      return Promise.resolve({ tooMany: opciones.demasiadosPorIp ?? false });
    },
    historyOf: () => {
      pasos.push('contador:historia');
      return Promise.resolve({
        attemptsSpent: opciones.intentosGastados ?? 0,
        codeIsLive: opciones.codigoVivo ?? true,
        codeWasAsked: opciones.sePidio ?? true,
      });
    },
    recordMiss: () => {
      pasos.push('contador:fallo');
      return Promise.resolve(opciones.quedan ?? 4);
    },
    clearAttempts: () => {
      pasos.push('contador:limpiar');
      return Promise.resolve();
    },
  };

  const hasher: CodeHasher = {
    verify: (hash) => {
      pasos.push(`argon2:${hash}`);
      return Promise.resolve(opciones.coincide ?? false);
    },
  };

  const tokens: RecoveryTokenPort = {
    signRecovery: (claims) => {
      firmados.push(claims);
      return Promise.resolve({
        token: 'eyJ.recuperacion',
        expiresAt: new Date('2026-10-27T13:23:00.000Z'),
      });
    },
  };

  return {
    caso: new CheckRecoveryCode(codes, limits, hasher, tokens, 'latam'),
    pasos,
    firmados,
  };
}

async function errorDe(trabajo: () => Promise<unknown>): Promise<ContractError> {
  try {
    await trabajo();
  } catch (fallo) {
    if (fallo instanceof ContractError) return fallo;
    throw fallo;
  }
  throw new Error('no lanzó y tenía que lanzar');
}

describe('POST /v1/recovery/code · el orden', () => {
  it('la forma primero: un código corto no llega ni al contador', async () => {
    const { caso, pasos } = armar({});
    const error = await errorDe(() => caso.run({ ...PETICION, codigo: '418' }, IP));

    expect(error.code).toBe('codigo_incompleto');
    expect(pasos).toEqual([]);
  });

  it('el límite por IP antes de comparar nada', async () => {
    const { caso, pasos } = armar({ demasiadosPorIp: true });
    const error = await errorDe(() => caso.run(PETICION, IP));

    expect(error.code).toBe('demasiados_intentos');
    expect(error.status).toBe(429);
    expect(pasos).toEqual(['contador:ip']);
  });

  it('el verificado de Argon2id corre SIEMPRE, también contra el señuelo', async () => {
    const { caso, pasos } = armar({ codigo: SENUELO });
    await errorDe(() => caso.run(PETICION, IP));

    expect(pasos).toContain('argon2:$argon2id$senuelo');
  });
});

describe('POST /v1/recovery/code · el 401 es uno para tres', () => {
  it('correo sin cuenta y código mal dan el mismo cuerpo y el mismo contador', async () => {
    const sinCuenta = await errorDe(() => armar({ codigo: SENUELO }).caso.run(PETICION, IP));
    const codigoMal = await errorDe(() =>
      armar({ codigo: VIVO, coincide: false }).caso.run(PETICION, IP),
    );

    expect(sinCuenta.code).toBe('codigo_no_coincide');
    expect(sinCuenta.code).toBe(codigoMal.code);
    expect(sinCuenta.status).toBe(401);
    expect(sinCuenta.userMessage).toBe(codigoMal.userMessage);
    expect(sinCuenta.data).toEqual(codigoMal.data);
    expect(sinCuenta.data).toEqual({ intentos_restantes: 4 });
  });

  it('la frase concuerda en singular con un intento', async () => {
    const error = await errorDe(() => armar({ quedan: 1 }).caso.run(PETICION, IP));
    expect(error.userMessage).toBe('Ese código no es. Te queda 1 intento.');
  });

  it('un correo sin cuenta NO gasta intento en la base: no hay fila que gastar', async () => {
    const { caso, pasos } = armar({ codigo: SENUELO });
    await errorDe(() => caso.run(PETICION, IP));

    expect(pasos).not.toContain('codigo:intento');
    // Pero sí en el contador de Redis, que es el que puede contar sin fila.
    expect(pasos).toContain('contador:fallo');
  });
});

describe('POST /v1/recovery/code · los dos 410, también para quien no existe', () => {
  it('cinco intentos gastados: 410 `codigo_anulado` con motivo `intentos`', async () => {
    const real = await errorDe(() =>
      armar({ codigo: { ...VIVO, verdict: 'voided', voidedReason: 'intentos' } }).caso.run(
        PETICION,
        IP,
      ),
    );
    const inventado = await errorDe(() =>
      armar({ codigo: SENUELO, intentosGastados: 5 }).caso.run(PETICION, IP),
    );

    expect(real.code).toBe('codigo_anulado');
    expect(real.status).toBe(410);
    expect(inventado.code).toBe(real.code);
    expect(inventado.data).toEqual(real.data);
    expect(real.data).toEqual({ motivo: 'intentos' });
  });

  it('código caducado: 410 `codigo_caducado`, y lo mismo para un correo inventado', async () => {
    const real = await errorDe(() =>
      armar({ codigo: { ...VIVO, verdict: 'expired' } }).caso.run(PETICION, IP),
    );
    const inventado = await errorDe(() =>
      armar({ codigo: SENUELO, codigoVivo: false, sePidio: true }).caso.run(PETICION, IP),
    );

    expect(real.code).toBe('codigo_caducado');
    expect(inventado.code).toBe(real.code);
    expect(inventado.status).toBe(410);
  });

  it('pedir otro código anula el anterior, y la frase lo distingue de los intentos', async () => {
    const error = await errorDe(() =>
      armar({ codigo: { ...VIVO, verdict: 'voided', voidedReason: 'codigo_nuevo' } }).caso.run(
        PETICION,
        IP,
      ),
    );
    expect(error.data).toEqual({ motivo: 'codigo_nuevo' });
    expect(error.userMessage).toContain('tu cuenta sigue bien');
  });

  it('un 410 no gasta intento: no se comparó nada', async () => {
    const { caso, pasos } = armar({ codigo: { ...VIVO, verdict: 'expired' } });
    await errorDe(() => caso.run(PETICION, IP));

    expect(pasos).not.toContain('argon2:$argon2id$real');
    expect(pasos).not.toContain('codigo:intento');
    expect(pasos).not.toContain('contador:fallo');
  });
});

describe('POST /v1/recovery/code · el token', () => {
  it('firma `sub`, `alcance` y `region`, Y NADA MÁS: sin rol y sin sesión', async () => {
    const { caso, firmados } = armar({ coincide: true });
    const respuesta = await caso.run(PETICION, IP);

    expect(respuesta).toEqual({
      token: 'eyJ.recuperacion',
      token_caduca_en: '2026-10-27T13:23:00.000Z',
      alcance: 'recuperacion',
    });
    // Si esta lista crece con `rol`, el flujo de recuperación se convierte en un oráculo
    // mejor que el del acceso: diría QUÉ es la persona, no solo que existe.
    expect(Object.keys(firmados[0] ?? {}).sort()).toEqual(['alcance', 'region', 'sub']);
    expect(firmados[0]?.sub).toBe(CUENTA);
  });

  it('validar el código no cambia la contraseña ni cierra sesiones', async () => {
    const { caso, pasos } = armar({ coincide: true });
    await caso.run(PETICION, IP);

    // Lo único que toca es el contador de intentos, que ya no significa nada.
    expect(pasos).toEqual([
      'contador:ip',
      'codigo:vigente',
      'contador:historia',
      'argon2:$argon2id$real',
      'contador:limpiar',
    ]);
  });
});
