// Las reglas del código, sin NestJS, sin base y sin Redis.
//
// La prueba que importa es la última: EL VEREDICTO DE UN CORREO QUE NO TIENE CUENTA. Si se
// rompe, el código de estado de `POST /v1/recovery/code` dice si un correo existe
// —410 para los reales, 401 para los inventados—, y eso es dato de salud.

import { describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import {
  CODE_DIGITS,
  mintCode,
  readCode,
  readEmail,
  verdictForUnknownAccount,
} from './code';

function errorDe(trabajo: () => unknown): ContractError {
  try {
    trabajo();
  } catch (fallo) {
    if (fallo instanceof ContractError) return fallo;
    throw fallo;
  }
  throw new Error('no lanzó y tenía que lanzar');
}

describe('el código · forma', () => {
  it('son seis dígitos, y los ceros de delante no se pierden', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = mintCode();
      expect(code).toHaveLength(CODE_DIGITS);
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it('menos de seis es `codigo_incompleto`; otra cosa, `codigo_no_es_numero`', () => {
    expect(errorDe(() => readCode('4182')).code).toBe('codigo_incompleto');
    expect(errorDe(() => readCode(undefined)).code).toBe('codigo_incompleto');
    expect(errorDe(() => readCode('41820a')).code).toBe('codigo_no_es_numero');
    expect(errorDe(() => readCode('4182031')).code).toBe('codigo_no_es_numero');
  });

  it('pegar desde el correo trae espacios, y pegar tiene que funcionar', () => {
    expect(readCode(' 418 203 ')).toBe('418203');
  });
});

describe('el correo · forma, nunca existencia', () => {
  it('vacío y mal escrito son dos errores distintos, los dos sin consultar nada', () => {
    expect(errorDe(() => readEmail('   ')).code).toBe('correo_vacio');
    expect(errorDe(() => readEmail('carla')).code).toBe('correo_mal_escrito');
    expect(errorDe(() => readEmail('carla@gmail')).code).toBe('correo_mal_escrito');
  });

  it('se normaliza aquí: la clave del contador es un HMAC de esta cadena', () => {
    expect(readEmail('  Carla.Rojas@Gmail.com ')).toBe('carla.rojas@gmail.com');
  });
});

describe('el veredicto de un correo sin cuenta · el oráculo que cierra', () => {
  it('cinco intentos gastados son `voided`, igual que el código real al quinto', () => {
    expect(
      verdictForUnknownAccount({ attemptsSpent: 5, codeIsLive: true, codeWasAsked: true }),
    ).toBe('voided');
  });

  it('se pidió un código y ya no está vivo: `expired`, igual que el real a los 10 min', () => {
    expect(
      verdictForUnknownAccount({ attemptsSpent: 0, codeIsLive: false, codeWasAsked: true }),
    ).toBe('expired');
  });

  it('nunca se pidió nada: `live`, y la comparación contra el señuelo falla con un 401', () => {
    // Es el caso de una cuenta REAL que nunca pidió código: la función de la base devuelve
    // también `live` con el señuelo. Los dos caminos tienen que coincidir aquí.
    expect(
      verdictForUnknownAccount({ attemptsSpent: 0, codeIsLive: false, codeWasAsked: false }),
    ).toBe('live');
  });

  it('con código vivo y sin intentos gastados: `live`', () => {
    expect(
      verdictForUnknownAccount({ attemptsSpent: 2, codeIsLive: true, codeWasAsked: true }),
    ).toBe('live');
  });
});
