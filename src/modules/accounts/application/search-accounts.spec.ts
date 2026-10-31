// `GET /v1/platform/accounts?correo=` · `cuentas.md`, 31 de octubre de 2026.
//
// Lo que se fija aquí, y las dos primeras son las que justifican el archivo:
//   · **el correo es EXACTO**: nada que parezca una búsqueda parcial llega a la base;
//   · **«no existe» es un 200 con lista vacía**, nunca un 404 — un 404 diría «ese correo no
//     está en MedSkin» por el código de estado, que es el oráculo que el acceso cierra;
//   · el renglón lleva CINCO campos, y el teléfono no está aunque el rol ya pueda leerlo.
//
// Sin base y sin NestJS: el caso de uso recibe su puerto.

import { describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import { readAccountLookup } from '../domain/account-lookup';
import type { ConsoleAccountRow, ConsoleActor } from '../domain/ports';
import { SearchAccounts } from './search-accounts';

const ACTOR: ConsoleActor = {
  subject: '99999999-9999-4999-8999-999999999999',
  label: 'Soporte MedSkin',
  region: 'latam',
};

const FILA: ConsoleAccountRow = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'andrea.paz@clinicapaz.bo',
  role: 'doctor',
  status: 'activa',
  lockedUntil: null,
};

function armar(filas: readonly ConsoleAccountRow[]) {
  const pedido: string[] = [];
  const puerto = {
    findByEmail: (p: { email: string }) => {
      pedido.push(p.email);
      return Promise.resolve(filas);
    },
  };
  return { caso: new SearchAccounts(puerto), pedido };
}

/** El `codigo` del contrato, que es lo que la consola lleva indexado. */
function codigoDe(ejecutar: () => unknown): string {
  try {
    ejecutar();
  } catch (failure) {
    if (failure instanceof ContractError) return failure.code;
    throw failure;
  }
  throw new Error('no lanzó ningún error del contrato');
}

describe('readAccountLookup · el correo es exacto, no una búsqueda', () => {
  it('acepta un correo completo, lo recorta y lo baja a minúsculas', () => {
    expect(readAccountLookup({ correo: '  Andrea.Paz@ClinicaPaz.BO ' })).toEqual({
      email: 'andrea.paz@clinicapaz.bo',
    });
  });

  it('LO QUE PARECE UNA BÚSQUEDA PARCIAL NO PASA, y es la razón de esta validación', () => {
    // Un `%paz%` sobre `account` devolvería un listado de personas de MedSkin con dos
    // caracteres, y ahí dentro hay pacientes: ese es el padrón que §12.2.1 cierra.
    for (const parcial of ['paz', '%paz%', 'paz@', '@clinicapaz.bo', 'andrea paz']) {
      expect(codigoDe(() => readAccountLookup({ correo: parcial })), parcial).toBe(
        'cuerpo_no_valido',
      );
    }
  });

  it('sin `correo` es `400 cuerpo_no_valido` sobre ese campo, y no un volcado', () => {
    expect(codigoDe(() => readAccountLookup({}))).toBe('cuerpo_no_valido');
    expect(codigoDe(() => readAccountLookup({ correo: '' }))).toBe('cuerpo_no_valido');
    expect(codigoDe(() => readAccountLookup({ correo: 123 }))).toBe('cuerpo_no_valido');
  });
});

describe('GET /v1/platform/accounts', () => {
  it('encuentra la cuenta y devuelve CINCO campos, sin el teléfono', async () => {
    const { caso, pedido } = armar([FILA]);
    const salida = await caso.run(readAccountLookup({ correo: FILA.email }), ACTOR);

    expect(salida.cuentas).toEqual([
      {
        id: FILA.id,
        correo: FILA.email,
        rol: 'doctor',
        estado: 'activa',
        pausa_hasta: null,
      },
    ]);
    // El teléfono NO viaja aunque la 0075 le diera el `SELECT` a este rol: esta lectura barre
    // `account` por correo, así que puede devolver la fila de una paciente.
    expect(Object.keys(salida.cuentas[0] ?? {}).sort()).toEqual([
      'correo',
      'estado',
      'id',
      'pausa_hasta',
      'rol',
    ]);
    // Y a la base va el correo ya normalizado, no lo que escribió el cliente.
    expect(pedido).toEqual([FILA.email]);
  });

  it('UN CORREO QUE NO EXISTE ES 200 CON LISTA VACÍA, nunca un 404', async () => {
    // Un 404 aquí diría «ese correo no está en MedSkin» por el código de estado, que es
    // exactamente el oráculo que la respuesta idéntica del acceso cierra en la app.
    const { caso } = armar([]);
    await expect(
      caso.run(readAccountLookup({ correo: 'nadie@ejemplo.com' }), ACTOR),
    ).resolves.toEqual({ cuentas: [] });
  });

  it('la pausa viaja como instante cuando la hay: es lo que la consola va a levantar', async () => {
    const { caso } = armar([{ ...FILA, lockedUntil: new Date('2026-10-28T14:29:00Z') }]);
    const salida = await caso.run(readAccountLookup({ correo: FILA.email }), ACTOR);

    expect(salida.cuentas[0]?.pausa_hasta).toBe('2026-10-28T14:29:00.000Z');
  });
});
