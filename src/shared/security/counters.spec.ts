// Los contadores y la pausa, contra la BASE de verdad. Sin dobles: lo que se prueba aquí es el
// comportamiento del almacén, y un doble probaría el doble.
//
// Las tres reglas de `_convenciones.md` · «Los contadores» son las tres primeras pruebas:
// cuenta exista o no la cuenta, la clave lleva el HMAC del correo y nunca el correo, y un
// fallo del almacén NO abre la puerta.

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { AccessPause, LIMIT_PER_EMAIL, LIMIT_PER_IP } from '../../modules/access/infrastructure/access-pause';
import { ContractError } from '../contract/error-catalog';
import { COUNTER_KEYS, Counters } from './counters';

const url =
  process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';
const LLAVE = 'llave_de_prueba_de_32_bytes_o_mas_aqui';
const CORREO = 'carla.rojas@contadores.local';
const IP = '201.131.0.77';

const pool = new Pool({ connectionString: url, max: 3 });
const counters = new Counters(pool, LLAVE);
const pause = new AccessPause(counters);

async function limpiar(): Promise<void> {
  const huella = counters.fingerprint(CORREO);
  await counters.forget(COUNTER_KEYS.signInByEmail(huella), COUNTER_KEYS.signInByIp(IP));
}

beforeEach(limpiar);
afterAll(async () => {
  await limpiar();
  await pool.end();
});

describe('Counters', () => {
  it('la huella es HMAC y NO contiene el correo', () => {
    const huella = counters.fingerprint(CORREO);
    expect(huella).toMatch(/^[0-9a-f]{64}$/);
    expect(COUNTER_KEYS.signInByEmail(huella)).not.toContain('carla');
    expect(COUNTER_KEYS.signInByEmail(huella)).not.toContain('@');
  });

  it('la huella no cambia con mayúsculas ni con espacios alrededor', () => {
    expect(counters.fingerprint('  CARLA.Rojas@Contadores.Local ')).toBe(
      counters.fingerprint(CORREO),
    );
  });

  it('la huella depende de la llave del servicio: no es un hash desnudo', () => {
    const otra = new Counters(pool, 'otra_llave_de_servicio_de_32_bytes_x');
    expect(otra.fingerprint(CORREO)).not.toBe(counters.fingerprint(CORREO));
  });

  it('la ventana se fija en el primer incremento y NO se renueva en los siguientes', async () => {
    const clave = `prueba:ventana:${Date.now()}`;
    const primero = await counters.increment(clave, 900);
    expect(primero.hits).toBe(1);
    const tope = primero.expiresAt?.getTime() ?? 0;

    const segundo = await counters.increment(clave, 900);
    expect(segundo.hits).toBe(2);
    // Mismo vencimiento, con el margen del reloj: si se renovara, una pausa de 15 minutos
    // sería perpetua para quien siga intentando.
    expect(Math.abs((segundo.expiresAt?.getTime() ?? 0) - tope)).toBeLessThan(1_000);
    await counters.forget(clave);
  });

  it('una clave que no existe cuenta 0 y no tiene vencimiento', async () => {
    const vacio = await counters.peek(`prueba:no-existe:${Date.now()}`);
    expect(vacio).toEqual({ hits: 0, expiresAt: null });
  });
});

describe('AccessPause · la pausa del acceso', () => {
  it('cinco fallos por correo disparan la pausa, con su `pausedUntil`', async () => {
    for (let i = 1; i < LIMIT_PER_EMAIL; i += 1) {
      const estado = await pause.recordFailure(CORREO, IP);
      expect(estado.paused, `fallo ${i}`).toBe(false);
      expect(estado.attemptsLeft).toBe(LIMIT_PER_EMAIL - i);
    }

    const quinto = await pause.recordFailure(CORREO, IP);
    expect(quinto.paused).toBe(true);
    expect(quinto.attemptsLeft).toBe(0);
    expect(quinto.pausedUntil).toBeInstanceOf(Date);
    // 15 minutos, `acceso.md` · Reglas de negocio.
    const minutos = ((quinto.pausedUntil as Date).getTime() - Date.now()) / 60_000;
    expect(minutos).toBeGreaterThan(14);
    expect(minutos).toBeLessThanOrEqual(15);
  });

  it('cuenta igual para un correo que no tiene cuenta: no hay fila que consultar', async () => {
    // El contador es de la CADENA, no de la cuenta. Es lo que hace idéntica la respuesta.
    const inexistente = 'nadie.en.absoluto@contadores.local';
    try {
      for (let i = 0; i < LIMIT_PER_EMAIL; i += 1) await pause.recordFailure(inexistente, IP);
      expect((await pause.peek(inexistente, IP)).paused).toBe(true);
    } finally {
      await pause.clear(inexistente, IP);
    }
  });

  it('`peek` no incrementa: el paso 2 del contrato mira, no cuenta', async () => {
    await pause.recordFailure(CORREO, IP);
    const antes = await pause.peek(CORREO, IP);
    const despues = await pause.peek(CORREO, IP);
    expect(antes.attemptsLeft).toBe(LIMIT_PER_EMAIL - 1);
    expect(despues.attemptsLeft).toBe(LIMIT_PER_EMAIL - 1);
  });

  it('se limpia al entrar bien, y limpia también la IP', async () => {
    await pause.recordFailure(CORREO, IP);
    await pause.clear(CORREO, IP);
    expect(await pause.peek(CORREO, IP)).toEqual({
      paused: false,
      pausedUntil: null,
      attemptsLeft: LIMIT_PER_EMAIL,
    });
  });

  it('la IP sola también pausa, con su propio límite', async () => {
    const ipSola = '198.51.100.7';
    const clave = COUNTER_KEYS.signInByIp(ipSola);
    try {
      for (let i = 0; i < LIMIT_PER_IP; i += 1) await counters.increment(clave, 900);
      const estado = await pause.peek('otro.correo@contadores.local', ipSola);
      expect(estado.paused).toBe(true);
      // Y los intentos por correo siguen intactos: son dos contadores.
      expect(estado.attemptsLeft).toBe(LIMIT_PER_EMAIL);
    } finally {
      await counters.forget(clave);
    }
  });

  it('si el almacén no responde, el endpoint da 500 y NO deja pasar', async () => {
    // Un límite de intentos que falla hacia el lado cómodo no es un límite.
    const caido = new Pool({
      connectionString: 'postgresql://nadie:nada@127.0.0.1:1/ninguna',
      max: 1,
      connectionTimeoutMillis: 500,
    });
    caido.on('error', () => undefined);
    const pausaCaida = new AccessPause(new Counters(caido, LLAVE));

    try {
      await pausaCaida.peek(CORREO, IP);
      throw new Error('tenía que lanzar y no lanzó');
    } catch (fallo) {
      expect(fallo).toBeInstanceOf(ContractError);
      expect((fallo as ContractError).code).toBe('fallo_de_servicio');
      expect((fallo as ContractError).status).toBe(500);
    } finally {
      await caido.end().catch(() => undefined);
    }
  });
});
