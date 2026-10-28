// El límite del refresco, contra el Redis de verdad (6380). Sin dobles: lo que se prueba
// es el comportamiento del almacén, y un doble de Redis probaría el doble.
//
// Dos reglas y una medida:
//   · 60 por `sid` en una hora, y el 61 es `429`;
//   · un fallo de Redis NO abre la puerta: lanza, y el endpoint responde 500;
//   · la gracia se cuenta aparte, para poder medir cuántos refrescos entran por ella.

import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { ContractError, ServiceFailure } from '../../../shared/contract/error-catalog';
import { Counters } from '../../../shared/security/counters';
import { RefreshLimits, REFRESHES_PER_SESSION_PER_HOUR } from './refresh-limits';

const url = process.env.REDIS_URL ?? 'redis://localhost:6380';
const SESION = 'eeeeeeee-0000-4000-8000-0000000000c1';
const OTRA = 'eeeeeeee-0000-4000-8000-0000000000c2';

const redis = new Redis(url, { maxRetriesPerRequest: 1 });
const limits = new RefreshLimits(new Counters(redis, 'llave_de_prueba_de_32_bytes_o_mas_aqui'));

const limpiar = () =>
  redis.del(`sesion:refrescos:${SESION}`, `sesion:refrescos:${OTRA}`, 'sesion:refrescos:gracia');

beforeEach(limpiar);
afterAll(async () => {
  await limpiar();
  await redis.quit();
});

async function errorDe(trabajo: () => Promise<unknown>): Promise<ContractError> {
  try {
    await trabajo();
  } catch (fallo) {
    if (fallo instanceof ContractError) return fallo;
    throw fallo;
  }
  throw new Error('se esperaba un ContractError y no se lanzó ninguno');
}

describe('el límite de refrescos', () => {
  it('los 60 de la hora pasan y el 61 es 429 `demasiados_refrescos`', async () => {
    for (let i = 0; i < REFRESHES_PER_SESSION_PER_HOUR; i += 1) {
      await limits.countRefresh(SESION, false);
    }

    const error = await errorDe(() => limits.countRefresh(SESION, false));

    expect(error.code).toBe('demasiados_refrescos');
    expect(error.status).toBe(429);
    // Sin frase a propósito: la app espera y reintenta con retroceso, no muestra texto.
    expect(error.userMessage).toBe('');
  });

  it('cuenta por `sid` y no por cuenta: otro dispositivo de la misma persona no gasta su cuota', async () => {
    for (let i = 0; i < REFRESHES_PER_SESSION_PER_HOUR; i += 1) {
      await limits.countRefresh(SESION, false);
    }

    // La otra sesión arranca de cero. Es la decisión del 28 de octubre: con el contador por
    // cuenta, un dispositivo en bucle dejaría a la doctora fuera en el teléfono que sí va.
    await expect(limits.countRefresh(OTRA, false)).resolves.toBeUndefined();
  });

  it('la ventana se fija en el primer incremento, así que una hora es una hora', async () => {
    await limits.countRefresh(SESION, false);
    const primera = await redis.pttl(`sesion:refrescos:${SESION}`);
    await limits.countRefresh(SESION, false);
    const segunda = await redis.pttl(`sesion:refrescos:${SESION}`);

    // La segunda no renueva: si lo hiciera, el límite no caducaría nunca.
    expect(segunda).toBeLessThanOrEqual(primera);
    expect(primera).toBeGreaterThan(59 * 60 * 1000);
  });

  it('la gracia se mide aparte y no gasta el límite del cliente dos veces', async () => {
    await limits.countRefresh(SESION, true);

    expect(await redis.get('sesion:refrescos:gracia')).toBe('1');
    expect(await redis.get(`sesion:refrescos:${SESION}`)).toBe('1');
  });

  it('un Redis caído NO abre la puerta: es 500 con la frase del refresco', async () => {
    const roto = new Redis('redis://localhost:6399', {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    const sinRedis = new RefreshLimits(new Counters(roto, 'llave_de_prueba_de_32_bytes_o_mas'));

    const error = await errorDe(() => sinRedis.countRefresh(SESION, false));

    expect(error).toBeInstanceOf(ServiceFailure);
    expect(error.status).toBe(500);
    expect(error.userMessage).toBe(
      'No pudimos renovar tu sesión. Puedes seguir con lo último guardado.',
    );
    roto.disconnect();
  });
});
