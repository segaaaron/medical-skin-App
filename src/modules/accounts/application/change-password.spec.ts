// `PATCH /v1/cuentas/mia/contrasena` · el orden y lo que el contrato promete.
//
// Lo que se fija aquí: que la nueva pasa las MISMAS reglas que `contrasena-nueva`, que el
// 429 se mira antes de comparar, que un fallo de `actual` gasta intento y un acierto lo
// limpia, y que las demás sesiones se cierran SIEMPRE —no hay interruptor, y se quitó a
// propósito—.

import { describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import type { ClockPort, PasswordHasher } from '../../access/domain/ports';
import type { OwnCredentialPort, PasswordAttemptsPort } from '../domain/ports';
import { ChangeOwnPassword } from './change-password';

const AHORA = new Date('2026-10-27T14:14:00.000Z');

const DOCTORA: Caller = {
  accountId: '11111111-1111-4111-8111-111111111111',
  sessionId: '33333333-3333-4333-8333-333333333333',
  role: 'doctora',
  accountRole: 'practitioner',
  scope: 'completo',
  region: 'latam',
  practiceId: '22222222-2222-4222-8222-222222222222',
  permissions: [],
};

function armar(opciones: { coincide?: boolean; gastados?: number; cerradas?: number }) {
  const pasos: string[] = [];

  const credentials: OwnCredentialPort = {
    readMine: () => {
      pasos.push('credencial:mia');
      return Promise.resolve({ hash: '$argon2id$actual' });
    },
    replace: () => {
      pasos.push('credencial:escribir');
      return Promise.resolve({ sessionsRevoked: opciones.cerradas ?? 1 });
    },
  };

  const passwords: PasswordHasher = {
    verify: () => {
      pasos.push('argon2:comparar');
      return Promise.resolve(opciones.coincide ?? true);
    },
    hash: () => {
      pasos.push('argon2:hashear');
      return Promise.resolve('$argon2id$nueva');
    },
  };

  const attempts: PasswordAttemptsPort = {
    spent: () => {
      pasos.push('contador:mirar');
      return Promise.resolve(opciones.gastados ?? 0);
    },
    recordFailure: () => {
      pasos.push('contador:fallo');
      return Promise.resolve();
    },
    clear: () => {
      pasos.push('contador:limpiar');
      return Promise.resolve();
    },
  };

  const clock: ClockPort = { now: () => AHORA, localTime: () => '10:14' };

  return { caso: new ChangeOwnPassword(credentials, passwords, attempts, clock), pasos };
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

describe('PATCH /v1/cuentas/mia/contrasena', () => {
  it('cambia, cierra las demás y devuelve cuántas', async () => {
    const { caso, pasos } = armar({ cerradas: 2 });
    const respuesta = await caso.run({ actual: 'la-de-ahora', nueva: 'cometa-nieve-11' }, DOCTORA);

    expect(respuesta).toEqual({ cambiada_en: AHORA.toISOString(), sesiones_cerradas: 2 });
    expect(pasos).toEqual([
      'contador:mirar',
      'credencial:mia',
      'argon2:comparar',
      'argon2:hashear',
      'credencial:escribir',
      'contador:limpiar',
    ]);
  });

  it('las reglas de la nueva son las de `contrasena-nueva`, y se miran primero', async () => {
    const corta = armar({});
    expect(
      (await errorDe(() => corta.caso.run({ actual: 'la-de-ahora', nueva: 'siete77' }, DOCTORA)))
        .code,
    ).toBe('contrasena_corta');
    expect(corta.pasos).toEqual([]);

    const usada = armar({});
    expect(
      (await errorDe(() => usada.caso.run({ actual: 'la-de-ahora', nueva: 'password' }, DOCTORA)))
        .code,
    ).toBe('contrasena_muy_usada');
  });

  it('la nueva igual a la actual no es un fallo de autenticación: no gasta intento', async () => {
    const { caso, pasos } = armar({});
    const error = await errorDe(() =>
      caso.run({ actual: 'cometa-nieve-11', nueva: 'cometa-nieve-11' }, DOCTORA),
    );

    expect(error.code).toBe('contrasena_igual_a_la_actual');
    expect(error.field).toBe('nueva');
    expect(pasos).toEqual([]);
  });

  it('la actual mal gasta intento y nombra el campo: quien llama ya está dentro', async () => {
    const { caso, pasos } = armar({ coincide: false });
    const error = await errorDe(() =>
      caso.run({ actual: 'la-que-no-es', nueva: 'cometa-nieve-11' }, DOCTORA),
    );

    expect(error.code).toBe('contrasena_actual_no_coincide');
    expect(error.status).toBe(401);
    expect(error.field).toBe('actual');
    expect(pasos).toContain('contador:fallo');
    expect(pasos).not.toContain('credencial:escribir');
  });

  it('al quinto fallo, 429 con la frase de este contrato y sin comparar nada', async () => {
    const { caso, pasos } = armar({ gastados: 5 });
    const error = await errorDe(() =>
      caso.run({ actual: 'la-de-ahora', nueva: 'cometa-nieve-11' }, DOCTORA),
    );

    expect(error.code).toBe('demasiados_intentos');
    expect(error.status).toBe(429);
    expect(error.userMessage).toBe('Demasiados intentos. Prueba de nuevo en 15 minutos.');
    expect(pasos).toEqual(['contador:mirar']);
  });

  it('sin credencial no se improvisa nada: es el mismo 401 que una contraseña mal', async () => {
    const credentials: OwnCredentialPort = {
      readMine: () => Promise.resolve(null),
      replace: () => Promise.reject(new Error('no tenía que llegar aquí')),
    };
    const caso = new ChangeOwnPassword(
      credentials,
      { verify: () => Promise.resolve(true), hash: () => Promise.resolve('$argon2id$x') },
      {
        spent: () => Promise.resolve(0),
        recordFailure: () => Promise.resolve(),
        clear: () => Promise.resolve(),
      },
      { now: () => AHORA, localTime: () => '10:14' },
    );

    const error = await errorDe(() =>
      caso.run({ actual: 'la-de-ahora', nueva: 'cometa-nieve-11' }, DOCTORA),
    );
    expect(error.code).toBe('contrasena_actual_no_coincide');
  });
});
