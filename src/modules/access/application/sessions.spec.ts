// Los cuatro endpoints de sesión. Lo que se fija aquí es que ningún id del cliente se
// usa sin pasar por la política de `session`, y que el 404 cubre a propósito los dos casos
// —sesión de otra cuenta y sesión inventada—, que es lo que impide usar este endpoint para
// averiguar si una sesión existe.

import { describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import type { ActiveSession, ClockPort, OwnerOfSessions, SessionPort } from '../domain/ports';
import type { Caller } from './caller';
import { CloseOtherSessions, CloseSession, ListSessions, SignOut } from './sessions';

const AHORA = new Date('2026-10-27T14:31:00.000Z');
const ESTA = '33333333-3333-4333-8333-333333333333';
const OTRA = '44444444-4444-4444-8444-444444444444';

const PACIENTE: Caller = {
  accountId: '11111111-1111-4111-8111-111111111111',
  sessionId: ESTA,
  role: 'paciente',
  accountRole: 'paciente',
  scope: 'completo',
  region: 'latam',
  practiceId: null,
  permissions: [],
};

const clock: ClockPort = { now: () => AHORA, localTime: () => '10:31' };

function puerto(opciones: {
  filas?: ActiveSession[];
  revoca?: boolean;
  cuantas?: number;
}): { port: SessionPort; vistos: Array<{ owner: OwnerOfSessions; id?: string }> } {
  const vistos: Array<{ owner: OwnerOfSessions; id?: string }> = [];
  return {
    vistos,
    port: {
      open: () => Promise.resolve({ sessionId: ESTA, licenseStatus: null, firstDayDone: true, practitionerRole: null, permissions: null }),
      nextStepFacts: () => Promise.resolve({ licenseStatus: null, firstDayDone: true, practitionerRole: null, permissions: null }),
      list: (owner) => {
        vistos.push({ owner });
        return Promise.resolve(opciones.filas ?? []);
      },
      revokeOne: (owner, id) => {
        vistos.push({ owner, id });
        return Promise.resolve(opciones.revoca ?? true);
      },
      revokeOthers: (owner, id) => {
        vistos.push({ owner, id });
        return Promise.resolve(opciones.cuantas ?? 0);
      },
    },
  };
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

describe('DELETE /v1/access', () => {
  it('cierra la sesión del token y devuelve `cerrada_en`', async () => {
    const { port, vistos } = puerto({});
    const respuesta = await new SignOut(port, clock).run(PACIENTE);

    expect(respuesta).toEqual({ cerrada_en: AHORA.toISOString() });
    expect(vistos[0]?.id).toBe(ESTA);
    expect(vistos[0]?.owner.accountId).toBe(PACIENTE.accountId);
  });

  it('cerrar lo ya cerrado también devuelve 200: es idempotente', async () => {
    const { port } = puerto({ revoca: false });
    const respuesta = await new SignOut(port, clock).run(PACIENTE);
    expect(respuesta.cerrada_en).toBe(AHORA.toISOString());
  });
});

describe('GET /v1/access/sessions', () => {
  it('marca `esta` en la sesión del token y devuelve ciudad y nada más fino', async () => {
    const filas: ActiveSession[] = [
      {
        id: ESTA,
        model: 'iPhone 15 Pro',
        os: 'iOS 18.2',
        appVersion: '2.4.1',
        city: 'Santa Cruz',
        signedInAt: new Date('2026-10-27T12:02:00.000Z'),
        lastSeenAt: AHORA,
      },
      {
        id: OTRA,
        model: 'iPad Pro',
        os: 'iPadOS 18.1',
        appVersion: '2.4.1',
        city: 'Santa Cruz',
        signedInAt: new Date('2026-10-20T23:40:00.000Z'),
        lastSeenAt: new Date('2026-10-27T01:12:00.000Z'),
      },
    ];
    const { port } = puerto({ filas });

    const respuesta = await new ListSessions(port).run(PACIENTE);

    expect(respuesta.cuantas).toBe(2);
    expect(respuesta.sesiones[0]).toEqual({
      id: ESTA,
      esta: true,
      dispositivo: 'iPhone 15 Pro',
      sistema: 'iOS 18.2',
      app: '2.4.1',
      ciudad: 'Santa Cruz',
      entro_en: '2026-10-27T12:02:00.000Z',
      ultima_vez: AHORA.toISOString(),
    });
    expect(respuesta.sesiones[1]?.esta).toBe(false);
    // Ni IP, ni dirección, ni identificador de dispositivo: no salen del puerto.
    expect(Object.keys(respuesta.sesiones[0] ?? {})).toEqual([
      'id',
      'esta',
      'dispositivo',
      'sistema',
      'app',
      'ciudad',
      'entro_en',
      'ultima_vez',
    ]);
  });
});

describe('DELETE /v1/access/sessions/{session_id}', () => {
  it('cerrar la actual por id es 400 es_esta_sesion', async () => {
    const { port, vistos } = puerto({});
    const error = await errorDe(() => new CloseSession(port).run(ESTA, PACIENTE));

    expect(error.code).toBe('es_esta_sesion');
    expect(error.field).toBe('sesion_id');
    expect(vistos).toEqual([]);
  });

  it('una sesión de otra cuenta no borra nada y responde 404', async () => {
    const { port } = puerto({ revoca: false });
    const error = await errorDe(() => new CloseSession(port).run(OTRA, PACIENTE));

    expect(error.code).toBe('sesion_no_existe');
    expect(error.status).toBe(404);
  });

  it('un id que no es uuid responde el MISMO 404 y no consulta nada', async () => {
    const { port, vistos } = puerto({ revoca: true });
    const error = await errorDe(() => new CloseSession(port).run('ses_inventada', PACIENTE));

    expect(error.code).toBe('sesion_no_existe');
    expect(vistos).toEqual([]);
  });

  it('cerrarla de verdad devuelve la cuenta de cerradas', async () => {
    const { port } = puerto({ revoca: true });
    expect(await new CloseSession(port).run(OTRA, PACIENTE)).toEqual({ cerradas: 1 });
  });
});

describe('DELETE /v1/access/sessions', () => {
  it('cierra todas menos la actual y devuelve cuántas', async () => {
    const { port, vistos } = puerto({ cuantas: 3 });
    expect(await new CloseOtherSessions(port).run(PACIENTE)).toEqual({ cerradas: 3 });
    expect(vistos[0]?.id).toBe(ESTA);
  });
});
