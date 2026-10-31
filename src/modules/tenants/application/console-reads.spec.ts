// LA LECTURA DE LISTA DE LA CONSOLA.
//
// La prueba que justifica este archivo es la última: **la búsqueda no devuelve ni un campo
// que la ficha no tenga**. Es la única lectura de consola que devuelve más de una consulta,
// así que es la única que puede filtrar el padrón por accidente, y lo que lo acota es el
// subconjunto de campos. Si alguien añade uno aquí sin añadirlo a la ficha, esto falla.
//
// AQUÍ SE PROBABA TAMBIÉN LA BANDEJA DE LICENCIAS, con su enlace firmado de cinco minutos a
// la credencial. Se fue con la revisión manual el 30 de octubre de 2026: MedSkin no verifica
// licencias.
//
// Sin base y sin NestJS: los casos de uso reciben sus puertos.

import { describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import { readConsoleSearch, PAGE_DEFAULT } from '../domain/console-search';
import type { ConsoleSearchPort, TenantRow } from '../domain/platform-ports';
import { SearchTenants } from './console-reads';

const ACTOR = { subject: '55555555-5555-4555-8555-555555555555', label: 'Soporte', region: 'latam' as const };

function consulta(n: number): TenantRow {
  return {
    id: `1111111${n}-1111-4111-8111-111111111111`,
    name: `Consultorio ${n}`,
    region: 'latam',
    createdOn: '2026-03-14',
    plan: 'consultorio',
    ownerEmail: 'andrea.paz@clinicapaz.bo',
    createdAt: new Date('2026-03-14T10:02:00.000Z'),
  };
}

function puerto(tenants: readonly TenantRow[]): ConsoleSearchPort {
  return { searchTenants: () => Promise.resolve(tenants) };
}

describe('readConsoleSearch · lo que se acepta de la query', () => {
  it('sin nada: 25 por página y ningún filtro', () => {
    expect(readConsoleSearch({})).toEqual({
      query: null,
      cursor: null,
      perPage: PAGE_DEFAULT,
    });
  });

  it('`q` de menos de dos caracteres no es una búsqueda, es un volcado', () => {
    // Con `%a%` devuelve casi todo el padrón y el filtro es decorativo.
    expect(() => readConsoleSearch({ q: 'a' })).toThrow(ContractError);
    expect(readConsoleSearch({ q: '  paz  ' }).query).toBe('paz');
  });

  it('`licencia` ya no es un filtro: lo que sobra se ignora, no se rechaza', () => {
    // Era `?licencia=en_revision|verificada|rechazada|sin_enviar`, y se fue con la revisión
    // manual. Un dashboard viejo que lo siga mandando recibe su búsqueda, no un `400`: un
    // parámetro que ya no existe no es una petición mal formada.
    expect(readConsoleSearch({ licencia: 'en_revision' })).toEqual({
      query: null,
      cursor: null,
      perPage: PAGE_DEFAULT,
    });
  });

  it('`por_pagina` fuera de 1-100 se rechaza', () => {
    expect(readConsoleSearch({ por_pagina: '50' }).perPage).toBe(50);
    expect(() => readConsoleSearch({ por_pagina: '0' })).toThrow(ContractError);
    expect(() => readConsoleSearch({ por_pagina: '101' })).toThrow(ContractError);
    expect(() => readConsoleSearch({ por_pagina: '12.5' })).toThrow(ContractError);
  });

  it('un cursor a medias es una petición mal formada, no media página', () => {
    const bueno = '2026-03-14T10:02:00.000Z|11111111-1111-4111-8111-111111111111';
    expect(readConsoleSearch({ cursor: bueno }).cursor?.id).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(() => readConsoleSearch({ cursor: '2026-03-14T10:02:00.000Z' })).toThrow(ContractError);
    expect(() => readConsoleSearch({ cursor: 'ayer|11111111-1111-4111-8111-111111111111' })).toThrow(
      ContractError,
    );
    expect(() => readConsoleSearch({ cursor: '2026-03-14T10:02:00.000Z|no-es-uuid' })).toThrow(
      ContractError,
    );
  });
});

describe('GET /v1/platform/tenants · la búsqueda', () => {
  it('sin resultados es un 200 con lista vacía, nunca un 404', async () => {
    // Un 404 diría «ese correo no está en MedSkin», que es el oráculo que el acceso cierra.
    const caso = new SearchTenants(puerto([]), 'Bolivia · bo-1');
    const salida = await caso.run(readConsoleSearch({ q: 'nadie' }), ACTOR);

    expect(salida.consultas).toEqual([]);
    expect(salida.cuantas).toBe(0);
    expect(salida.siguiente).toBeNull();
  });

  it('`siguiente` sale solo cuando hay más, y es `fecha|id`', async () => {
    // El puerto devuelve `perPage + 1`: la de más es cómo se sabe que hay página siguiente.
    const caso = new SearchTenants(puerto([consulta(1), consulta(2), consulta(3)]), 'bo-1');

    const conMas = await caso.run(readConsoleSearch({ por_pagina: '2' }), ACTOR);
    expect(conMas.consultas).toHaveLength(2);
    expect(conMas.cuantas).toBe(2);
    expect(conMas.siguiente).toBe(
      '2026-03-14T10:02:00.000Z|11111112-1111-4111-8111-111111111111',
    );

    const ultima = await caso.run(readConsoleSearch({ por_pagina: '5' }), ACTOR);
    expect(ultima.siguiente).toBeNull();
  });

  it('NO DEVUELVE NI UN CAMPO QUE LA FICHA NO TENGA · es lo que acota esta lectura', async () => {
    const caso = new SearchTenants(puerto([consulta(1)]), 'Bolivia · bo-1');
    const salida = await caso.run(readConsoleSearch({}), ACTOR);

    expect(Object.keys(salida.consultas[0] ?? {}).sort()).toEqual([
      'alta_en',
      'doctora',
      'id',
      'nombre',
      'plan',
      'region_etiqueta',
    ]);
    // Y de la doctora, SOLO EL CORREO: `app_platform` no tiene ni una columna de
    // `practitioner`, que es donde vive el nombre, y la ficha tampoco lo devuelve.
    expect(Object.keys(salida.consultas[0]?.doctora ?? {})).toEqual(['correo']);
  });
});
