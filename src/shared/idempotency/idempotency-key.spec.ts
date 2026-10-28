// La cabecera `Idempotency-Key`. Lo que esta prueba fija:
//
//   · **sin cabecera es `400 clave_idempotencia_faltante` y no se ejecuta nada.** Antes
//     devolvía `null` y los cuatro controladores hacían `if (key !== null)`, así que el
//     mecanismo entero se apagaba en silencio mientras la petición se atendía igual —y el
//     contrato la exige en «todo `POST` que crea algo»—. Que no se ejecute nada no es una
//     promesa de este archivo: la clave es el ARGUMENTO con el que se llama al caso de uso
//     (`return this.register.run(body, callerOf(req), readIdempotencyKey(req, body))`), así
//     que no hay camino que llegue al caso de uso sin ella;
//   · el `mensaje` va **vacío**, como `ruta_no_existe` y `formato_no_admitido`: es un error
//     de la app y no hay nada que contarle a una persona que no puede arreglarlo;
//   · **una sola huella del cuerpo en todo el servicio, y ordena las claves**: había dos
//     implementaciones y el mismo cuerpo en otro orden era «otra petición» en un endpoint y
//     la misma en el otro.

import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { ContractError } from '../contract/error-catalog';
import { KEY_MAX_LENGTH, fingerprintOf, readIdempotencyKey } from './idempotency-key';

/** Lo mínimo de una petición: este lector solo mira una cabecera. */
function peticion(header?: string | string[]): FastifyRequest {
  return { headers: header === undefined ? {} : { 'idempotency-key': header } } as FastifyRequest;
}

const CUERPO = { nombre: 'Valeria', correo: 'valeria@gmail.com' };

function errorDe(trabajo: () => unknown): ContractError {
  try {
    trabajo();
  } catch (fallo) {
    if (fallo instanceof ContractError) return fallo;
    throw fallo;
  }
  throw new Error('no lanzó y tenía que lanzar');
}

describe('la cabecera es obligatoria', () => {
  it('sin cabecera, vacía o en blanco: 400 y la misma respuesta', () => {
    for (const header of [undefined, '', '   ']) {
      const fallo = errorDe(() => readIdempotencyKey(peticion(header), CUERPO));
      expect({ codigo: fallo.code, estado: fallo.status, mensaje: fallo.userMessage }).toEqual({
        codigo: 'clave_idempotencia_faltante',
        estado: 400,
        // Vacío a propósito: es un error de la app, no del usuario.
        mensaje: '',
      });
      expect(fallo.field).toBeNull();
    }
  });

  it('con cabecera devuelve la clave recortada y la huella del cuerpo', () => {
    const record = readIdempotencyKey(peticion('  7f8e9d10-1111-4111-8111-111111111111 '), CUERPO);

    expect(record.key).toBe('7f8e9d10-1111-4111-8111-111111111111');
    expect(record.bodyHash).toBe(fingerprintOf(CUERPO));
  });

  it('una cabecera repetida toma la primera, y una larguísima se acota', () => {
    expect(readIdempotencyKey(peticion(['uno', 'dos']), CUERPO).key).toBe('uno');
    expect(readIdempotencyKey(peticion('x'.repeat(500)), CUERPO).key).toHaveLength(
      KEY_MAX_LENGTH,
    );
  });
});

describe('la huella del cuerpo', () => {
  it('el mismo cuerpo con las claves en otro orden es la MISMA petición', () => {
    // Es el defecto que tenía la huella de la consola: con `JSON.stringify` a secas, un
    // cliente que serializa en otro orden entre dos reintentos recibía un 409 por una
    // petición idéntica.
    expect(fingerprintOf({ a: 1, b: { c: 2, d: 3 } })).toBe(
      fingerprintOf({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it('un cuerpo distinto es otra huella, y el orden de un arreglo SÍ cuenta', () => {
    expect(fingerprintOf({ a: 1 })).not.toBe(fingerprintOf({ a: 2 }));
    expect(fingerprintOf([1, 2])).not.toBe(fingerprintOf([2, 1]));
    // Un campo ausente y uno `undefined` son el mismo cuerpo: `JSON.stringify` los serializa
    // igual, así que la huella tiene que decir lo mismo.
    expect(fingerprintOf({ a: 1, b: undefined })).toBe(fingerprintOf({ a: 1 }));
  });
});
