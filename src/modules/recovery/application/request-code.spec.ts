// `POST /v1/recovery` · la prueba de LA RESPUESTA IDÉNTICA.
//
// No comprueba que un doble fue llamado: comprueba que el caso de uso NO TIENE RAMAS. El
// contrato dice «mismo 202, mismo cuerpo, mismo `caduca_en` calculado, mismo tiempo de
// respuesta» exista o no el correo, y la única forma de cumplirlo es que la petición no
// consulte la base: acuñar escribe dos filas cuando la cuenta existe y ninguna cuando no,
// y eso se mide con un cronómetro.
//
// Así que lo que se fija aquí es que el caso de uso no recibe NINGÚN puerto de base, que
// los pasos son los mismos para cualquier correo, y que lo que se encola es a quién
// escribirle y no qué escribirle.

import { describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import type { ClockPort } from '../../access/domain/ports';
import type { RecoveryLimitsPort, RecoveryMailJob, RecoveryQueuePort } from '../domain/ports';
import { RequestRecoveryCode } from './request-code';

const AHORA = new Date('2026-10-27T13:18:00.000Z');
const IP = '201.131.0.9';

function armar(opciones: { demasiados?: boolean } = {}) {
  const pasos: string[] = [];
  const encolados: RecoveryMailJob[] = [];

  const limits: RecoveryLimitsPort = {
    countRequest: () => {
      pasos.push('contador:pedido');
      return Promise.resolve({ tooMany: opciones.demasiados ?? false });
    },
    countAttemptByIp: () => Promise.resolve({ tooMany: false }),
    historyOf: () =>
      Promise.resolve({ attemptsSpent: 0, codeIsLive: false, codeWasAsked: false }),
    recordMiss: () => Promise.resolve(4),
    clearAttempts: () => Promise.resolve(),
  };

  const queue: RecoveryQueuePort = {
    enqueue: (job) => {
      pasos.push('cola:encolar');
      encolados.push(job);
      return Promise.resolve();
    },
  };

  const clock: ClockPort = { now: () => AHORA, localTime: () => '09:28' };

  return { caso: new RequestRecoveryCode(limits, queue, clock), pasos, encolados };
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

describe('POST /v1/recovery · idéntica exista o no el correo', () => {
  it('los pasos son los mismos para cualquier correo: contar y encolar, y nada más', async () => {
    const existe = armar();
    await existe.caso.run({ correo: 'carla.rojas@gmail.com' }, IP);

    const noExiste = armar();
    await noExiste.caso.run({ correo: 'nadie.de.aqui@gmail.com' }, IP);

    expect(existe.pasos).toEqual(['contador:pedido', 'cola:encolar']);
    expect(noExiste.pasos).toEqual(existe.pasos);
  });

  it('el cuerpo es el mismo salvo la frase, que lleva el correo que llegó', async () => {
    const { caso } = armar();
    const uno = await caso.run({ correo: 'carla.rojas@gmail.com' }, IP);
    const otro = await caso.run({ correo: 'nadie.de.aqui@gmail.com' }, IP);

    expect(uno.caduca_en).toBe(otro.caduca_en);
    expect(uno.puede_reenviar_en).toBe(otro.puede_reenviar_en);
    expect(uno.intentos_restantes).toBe(otro.intentos_restantes);
    expect(uno.mensaje).toBe(
      'Si carla.rojas@gmail.com tiene cuenta en MedSkin, el código ya está en su bandeja.',
    );
  });

  it('los dos relojes de la pantalla: 10 minutos de vida y 45 segundos de reenvío', async () => {
    const { caso } = armar();
    const respuesta = await caso.run({ correo: 'carla.rojas@gmail.com' }, IP);

    expect(respuesta.caduca_en).toBe('2026-10-27T13:28:00.000Z');
    expect(respuesta.puede_reenviar_en).toBe('2026-10-27T13:18:45.000Z');
    expect(respuesta.intentos_restantes).toBe(5);
  });

  it('lo que se encola es a quién escribirle, no qué escribirle', async () => {
    const { caso, encolados } = armar();
    await caso.run({ correo: 'carla.rojas@gmail.com' }, IP);

    expect(encolados).toHaveLength(1);
    // Las dos claves, y ni una más: el código en claro no está porque todavía no existe.
    expect(Object.keys(encolados[0] ?? {}).sort()).toEqual(['email', 'expiresAt']);
  });

  it('el 429 cuenta igual exista o no la cuenta, y la frase es la misma', async () => {
    const error = await errorDe(() =>
      armar({ demasiados: true }).caso.run({ correo: 'carla.rojas@gmail.com' }, IP),
    );
    expect(error.code).toBe('demasiados_codigos');
    expect(error.status).toBe(429);
  });

  it('la forma del correo se comprueba antes de contar: no gasta cupo ni encola', async () => {
    const vacio = armar();
    expect((await errorDe(() => vacio.caso.run({ correo: '  ' }, IP))).code).toBe('correo_vacio');
    expect(vacio.pasos).toEqual([]);

    const malo = armar();
    expect((await errorDe(() => malo.caso.run({ correo: 'carla' }, IP))).code).toBe(
      'correo_mal_escrito',
    );
    expect(malo.pasos).toEqual([]);
  });
});
