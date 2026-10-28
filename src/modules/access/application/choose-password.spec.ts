// POST /v1/acceso/contrasena-nueva · las reglas y el 409 que prometen las dos frases.
//
// Lo que esta prueba fija y no se puede perder: el 500 y el 410 de este endpoint prometen
// por escrito que «todavía puedes entrar con la temporal», y eso solo es verdad porque la
// temporal se consume AL GUARDAR la nueva. Aquí se comprueba que un fallo antes de guardar
// no toca nada, y que las cinco escrituras del guardado van en una sola llamada.

import { describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import type {
  AccessCredential,
  ClockPort,
  CredentialPort,
  PasswordHasher,
  SavePasswordVerdict,
  SessionPort,
  TokenPort,
} from '../domain/ports';
import type { Caller } from './caller';
import { ChoosePassword } from './choose-password';

const AHORA = new Date('2026-10-27T14:14:00.000Z');

const TEMPORAL: AccessCredential = {
  accountId: '11111111-1111-4111-8111-111111111111',
  accountRole: 'paciente',
  accountStatus: null,
  region: null,
  hash: '$argon2id$temporal',
  isTemporary: true,
  tempExpiresAt: new Date(AHORA.getTime() + 3_600_000),
  tempUsedAt: null,
  practiceId: null,
  practitionerRole: null,
  permissions: null,
};

const PACIENTE: Caller = {
  accountId: TEMPORAL.accountId as string,
  sessionId: '33333333-3333-4333-8333-333333333333',
  role: 'paciente',
  accountRole: 'paciente',
  scope: 'contrasena_temporal',
  region: 'latam',
  practiceId: null,
  permissions: [],
};

function armar(opciones: {
  actual?: AccessCredential | null;
  esLaTemporal?: boolean;
  veredicto?: SavePasswordVerdict;
}) {
  const pasos: string[] = [];

  const credentials: CredentialPort = {
    read: () => Promise.resolve(TEMPORAL),
    recordAttempt: () => Promise.resolve(),
    readMine: () => {
      pasos.push('credencial:mia');
      return Promise.resolve(opciones.actual === undefined ? TEMPORAL : opciones.actual);
    },
    saveFinalPassword: (p) => {
      pasos.push(`guardar:${p.via}:${p.currentSessionId}:${p.refreshDigest}`);
      return Promise.resolve({
        verdict: opciones.veredicto ?? ('saved' as const),
        permissions: null,
      });
    },
  };

  const passwords: PasswordHasher = {
    verify: () => {
      pasos.push('argon2:comparar');
      return Promise.resolve(opciones.esLaTemporal ?? false);
    },
    hash: () => {
      pasos.push('argon2:hashear');
      return Promise.resolve('$argon2id$nuevo');
    },
  };

  const sessions: SessionPort = {
    open: () => Promise.resolve({ sessionId: 'x', licenseStatus: null, firstDayDone: true }),
    nextStepFacts: () => {
      pasos.push('paso:estado');
      return Promise.resolve({ licenseStatus: 'sin_enviar', firstDayDone: false });
    },
    list: () => Promise.resolve([]),
    revokeOne: () => Promise.resolve(true),
    revokeOthers: () => Promise.resolve(0),
  };

  const tokens: TokenPort = {
    sign: (claims) => {
      pasos.push(`token:${claims.alcance}`);
      return Promise.resolve({ token: 'jwt', expiresAt: new Date(AHORA.getTime() + 900_000) });
    },
    mintRefresh: () => ({ refresh: 'rfr_nuevo', digest: 'resumen' }),
  };

  const clock: ClockPort = { now: () => AHORA, localTime: () => '10:29' };

  return { pasos, caso: new ChoosePassword(credentials, passwords, sessions, tokens, clock) };
}

async function errorDe(trabajo: () => Promise<unknown>): Promise<ContractError> {
  try {
    await trabajo();
  } catch (fallo) {
    if (fallo instanceof ContractError) return fallo;
    throw fallo;
  }
  throw new Error('se esperaba un ErrorDeContrato y no se lanzó ninguno');
}

describe('POST /v1/acceso/contrasena-nueva · las reglas de la contraseña', () => {
  it('menos de 8 caracteres es contrasena_corta, y no se escribe nada', async () => {
    const { caso, pasos } = armar({});
    const error = await errorDe(() => caso.run({ nueva: 'siete12' }, PACIENTE));

    expect(error.code).toBe('contrasena_corta');
    expect(error.field).toBe('nueva');
    expect(pasos).toEqual([]);
  });

  it('una de las más usadas es contrasena_muy_usada', async () => {
    const { caso, pasos } = armar({});
    const error = await errorDe(() => caso.run({ nueva: 'contraseña' }, PACIENTE));

    expect(error.code).toBe('contrasena_muy_usada');
    expect(pasos).toEqual([]);
  });

  it('ocho emojis son ocho caracteres, no cuatro', async () => {
    const { caso } = armar({ actual: null });
    const respuesta = await caso.run({ nueva: '🌵🌵🌵🌵🌵🌵🌵🌵' }, PACIENTE);
    expect(respuesta.token).toBe('jwt');
  });

  it('no exige mayúscula, número ni símbolo', async () => {
    const { caso } = armar({ actual: null });
    const respuesta = await caso.run({ nueva: 'tejadolila' }, PACIENTE);
    expect(respuesta.token).toBe('jwt');
  });

  it('escribir la misma temporal es 400 contrasena_igual_a_la_temporal, sin guardar', async () => {
    const { caso, pasos } = armar({ esLaTemporal: true });
    const error = await errorDe(() => caso.run({ nueva: 'tejado-lila-07' }, PACIENTE));

    expect(error.code).toBe('contrasena_igual_a_la_temporal');
    expect(pasos).toContain('argon2:comparar');
    expect(pasos.some((p) => p.startsWith('guardar:'))).toBe(false);
  });
});

describe('POST /v1/acceso/contrasena-nueva · el guardado', () => {
  it('devuelve token de alcance COMPLETO, refresco y el `siguiente_paso` real', async () => {
    const { caso, pasos } = armar({ actual: null });
    const respuesta = await caso.run({ nueva: 'tejado-nuevo-07' }, PACIENTE);

    expect(pasos).toContain('token:completo');
    expect(respuesta.refresco).toBe('rfr_nuevo');
    expect(respuesta.refresco_caduca_en).toBe(
      new Date(AHORA.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    );
    // La paciente no tiene licencia ni primer día: su paso es `inicio` hasta el tramo 2.
    expect(respuesta.siguiente_paso).toBe('inicio');
    expect(respuesta.sesion_id).toBe(PACIENTE.sessionId);
  });

  it('la doctora sigue a `licencia` cuando su licencia está sin enviar', async () => {
    const { caso } = armar({ actual: null });
    const doctora: Caller = {
      ...PACIENTE,
      role: 'doctora',
      accountRole: 'practitioner',
      practiceId: '22222222-2222-4222-8222-222222222222',
    };

    const respuesta = await caso.run({ nueva: 'tejado-nuevo-07' }, doctora);

    expect(respuesta.siguiente_paso).toBe('licencia');
    expect(respuesta.refresco_caduca_en).toBe(
      new Date(AHORA.getTime() + 12 * 60 * 60 * 1000).toISOString(),
    );
  });

  it('guarda con la vía del alcance del token y NO con un campo del cuerpo', async () => {
    const porRecuperacion = armar({ actual: null });
    await porRecuperacion.caso.run({ nueva: 'tejado-nuevo-07' }, {
      ...PACIENTE,
      scope: 'recuperacion',
    });

    expect(
      porRecuperacion.pasos.some((p) => p.startsWith('guardar:recuperacion:')),
    ).toBe(true);
    // Por recuperación no hay temporal que comparar: no se pide la credencial actual.
    expect(porRecuperacion.pasos).not.toContain('credencial:mia');
  });

  it('el veredicto `already_chosen` es 409 contrasena_ya_elegida', async () => {
    const { caso } = armar({ actual: null, veredicto: 'already_chosen' });
    const error = await errorDe(() => caso.run({ nueva: 'tejado-nuevo-07' }, PACIENTE));

    expect(error.code).toBe('contrasena_ya_elegida');
    expect(error.status).toBe(409);
  });

  it('el veredicto `no_code` también: para quien lo lee es el mismo hecho', async () => {
    const { caso } = armar({ actual: null, veredicto: 'no_code' });
    const error = await errorDe(() =>
      caso.run({ nueva: 'tejado-nuevo-07' }, { ...PACIENTE, scope: 'recuperacion' }),
    );

    expect(error.code).toBe('contrasena_ya_elegida');
  });

  it('el refresco se acuña ANTES de guardar: la sesión se asciende en la misma transacción', async () => {
    const { caso, pasos } = armar({ actual: null });
    await caso.run({ nueva: 'tejado-nuevo-07' }, PACIENTE);

    expect(pasos).toContain(`guardar:temporal:${PACIENTE.sessionId}:resumen`);
  });
});
