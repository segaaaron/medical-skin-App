// La idempotencia, contra el Redis de verdad. Lo que se fija aquí es la decisión escrita
// del 27 de octubre: la repetición devuelve LA RESPUESTA COMPLETA, contraseña temporal
// incluida. Devolverla mutilada rompería justo el caso que la idempotencia existe para
// cubrir: la app mandó el alta, perdió la respuesta y no tiene la contraseña que entregar.

import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';

import { ContractError } from '../contract/error-catalog';
import { IdempotencyStore, LIFETIME_SECONDS } from './idempotency-store';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380', {
  maxRetriesPerRequest: 1,
});
const store = new IdempotencyStore(redis);

const CUENTA = '11111111-1111-4111-8111-111111111111';
const OTRA_CUENTA = '99999999-9999-4999-8999-999999999999';
const claves: string[] = [];

function clave(): string {
  const k = randomUUID();
  claves.push(k);
  return k;
}

afterAll(async () => {
  for (const k of claves) {
    await redis.del(`idem:${CUENTA}:${k}`, `idem:${OTRA_CUENTA}:${k}`);
  }
  await redis.quit();
});

describe('IdempotencyStore', () => {
  it('una clave nueva no repite nada', async () => {
    expect(await store.replay({ key: clave(), accountId: CUENTA, body: { a: 1 } })).toBeNull();
  });

  it('la repetición devuelve la respuesta completa, contraseña temporal incluida', async () => {
    const key = clave();
    const body = { correo: 'carla@medskin.local', nombre: 'Carla' };
    const respuesta = {
      cuenta_id: 'cta_1',
      contrasena_temporal: 'tejado-lila-07',
      caduca_en: '2026-10-30T18:24:00-04:00',
    };

    await store.remember({ key, accountId: CUENTA, body, status: 201, response: respuesta });
    const repetida = await store.replay({ key, accountId: CUENTA, body });

    expect(repetida).toEqual({ status: 201, response: respuesta });
  });

  it('el mismo cuerpo con las claves en otro orden es el mismo cuerpo', async () => {
    const key = clave();
    await store.remember({
      key,
      accountId: CUENTA,
      body: { a: 1, b: { c: 2, d: 3 } },
      status: 201,
      response: { ok: true },
    });

    const repetida = await store.replay({
      key,
      accountId: CUENTA,
      body: { b: { d: 3, c: 2 }, a: 1 },
    });
    expect(repetida?.status).toBe(201);
  });

  it('la misma clave con OTRO cuerpo es 409 clave_idempotencia_reutilizada', async () => {
    const key = clave();
    await store.remember({
      key,
      accountId: CUENTA,
      body: { correo: 'a@b.com' },
      status: 201,
      response: { ok: true },
    });

    try {
      await store.replay({ key, accountId: CUENTA, body: { correo: 'otro@b.com' } });
      throw new Error('tenía que lanzar el 409 y no lanzó');
    } catch (fallo) {
      expect(fallo).toBeInstanceOf(ContractError);
      expect((fallo as ContractError).code).toBe('clave_idempotencia_reutilizada');
      expect((fallo as ContractError).status).toBe(409);
    }
  });

  it('la clave de una cuenta no sirve en otra: una clave robada no vale en otro expediente', async () => {
    const key = clave();
    const body = { correo: 'a@b.com' };
    await store.remember({ key, accountId: CUENTA, body, status: 201, response: { ok: true } });

    expect(await store.replay({ key, accountId: OTRA_CUENTA, body })).toBeNull();
  });

  it('vive 24 h', async () => {
    const key = clave();
    await store.remember({ key, accountId: CUENTA, body: {}, status: 200, response: {} });
    const ttl = await redis.ttl(`idem:${CUENTA}:${key}`);

    expect(ttl).toBeGreaterThan(LIFETIME_SECONDS - 10);
    expect(ttl).toBeLessThanOrEqual(LIFETIME_SECONDS);
  });
});
