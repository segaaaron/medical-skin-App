// LAS DOS LECTURAS DE LISTA DE LA CONSOLA.
//
// La prueba que justifica este archivo es la última: **la búsqueda no devuelve ni un campo
// que la ficha no tenga**. Es la primera lectura de consola que devuelve más de una consulta,
// así que es la primera que puede filtrar el padrón por accidente, y lo que lo acota es el
// subconjunto de campos. Si alguien añade uno aquí sin añadirlo a la ficha, esto falla.
//
// Sin base y sin NestJS: los casos de uso reciben sus puertos.

import { describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import type { StorageConfig } from '../../../shared/storage/signed-url';
import type { ClockPort } from '../../access/domain/ports';
import {
  readConsoleSearch,
  readLicenseInbox,
  PAGE_DEFAULT,
} from '../domain/console-search';
import type { ConsoleSearchPort, LicenseRow, TenantRow } from '../domain/platform-ports';
import { ListLicenses, SearchTenants } from './console-reads';

const AHORA = new Date('2026-10-30T18:00:00.000Z');
const reloj: ClockPort = { now: () => AHORA, localTime: () => '14:00' };

const ACTOR = { subject: '55555555-5555-4555-8555-555555555555', label: 'Soporte', region: 'latam' as const };

const ALMACEN: StorageConfig = {
  endpoint: 'https://objetos.local',
  region: 'us-east-1',
  bucket: 'medskin',
  accessKey: 'test',
  secretKey: 'test',
  forcePathStyle: true,
};

function consulta(n: number): TenantRow {
  return {
    id: `1111111${n}-1111-4111-8111-111111111111`,
    name: `Consultorio ${n}`,
    region: 'latam',
    createdOn: '2026-03-14',
    plan: 'consultorio',
    licenseStatus: 'verificada',
    ownerEmail: 'andrea.paz@clinicapaz.bo',
    createdAt: new Date('2026-03-14T10:02:00.000Z'),
  };
}

function licencia(n: number, credentialKey: string | null): LicenseRow {
  return {
    practiceId: `2222222${n}-2222-4222-8222-222222222222`,
    practiceName: `Consultorio ${n}`,
    ownerEmail: 'andrea.paz@clinicapaz.bo',
    status: 'en_revision',
    submittedAt: new Date('2026-10-26T22:24:00.000Z'),
    responseEstimatedAt: new Date('2026-10-28T22:24:00.000Z'),
    specialty: 'dermatologia',
    licenseNumber: 'MP-48921',
    practiceCountry: 'BO',
    credentialKey,
    cursorAt: new Date('2026-10-26T22:24:00.000Z'),
  };
}

function puerto(tenants: readonly TenantRow[], licenses: readonly LicenseRow[]): ConsoleSearchPort {
  return {
    searchTenants: () => Promise.resolve(tenants),
    listLicenses: () => Promise.resolve(licenses),
  };
}

describe('readConsoleSearch · lo que se acepta de la query', () => {
  it('sin nada: 25 por página y ningún filtro', () => {
    expect(readConsoleSearch({})).toEqual({
      query: null,
      license: null,
      cursor: null,
      perPage: PAGE_DEFAULT,
    });
  });

  it('`q` de menos de dos caracteres no es una búsqueda, es un volcado', () => {
    // Con `%a%` devuelve casi todo el padrón y el filtro es decorativo.
    expect(() => readConsoleSearch({ q: 'a' })).toThrow(ContractError);
    expect(readConsoleSearch({ q: '  paz  ' }).query).toBe('paz');
  });

  it('un estado de licencia que no está en la lista cerrada no se filtra', () => {
    expect(readConsoleSearch({ licencia: 'en_revision' }).license).toBe('en_revision');
    expect(() => readConsoleSearch({ licencia: 'pendiente' })).toThrow(ContractError);
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

describe('readLicenseInbox', () => {
  it('sin `estado` es la BANDEJA: `en_revision`', () => {
    expect(readLicenseInbox({}).state).toBe('en_revision');
  });

  it('los otros tres estados se piden a propósito', () => {
    expect(readLicenseInbox({ estado: 'rechazada' }).state).toBe('rechazada');
    expect(() => readLicenseInbox({ estado: 'todas' })).toThrow(ContractError);
  });
});

describe('GET /v1/platform/tenants · la búsqueda', () => {
  it('sin resultados es un 200 con lista vacía, nunca un 404', async () => {
    // Un 404 diría «ese correo no está en MedSkin», que es el oráculo que el acceso cierra.
    const caso = new SearchTenants(puerto([], []), 'Bolivia · bo-1');
    const salida = await caso.run(readConsoleSearch({ q: 'nadie' }), ACTOR);

    expect(salida.consultas).toEqual([]);
    expect(salida.cuantas).toBe(0);
    expect(salida.siguiente).toBeNull();
  });

  it('`siguiente` sale solo cuando hay más, y es `fecha|id`', async () => {
    // El puerto devuelve `perPage + 1`: la de más es cómo se sabe que hay página siguiente.
    const caso = new SearchTenants(puerto([consulta(1), consulta(2), consulta(3)], []), 'bo-1');

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
    const caso = new SearchTenants(puerto([consulta(1)], []), 'Bolivia · bo-1');
    const salida = await caso.run(readConsoleSearch({}), ACTOR);

    expect(Object.keys(salida.consultas[0] ?? {}).sort()).toEqual([
      'alta_en',
      'doctora',
      'id',
      'licencia',
      'nombre',
      'plan',
      'region_etiqueta',
    ]);
    // Y de la doctora, SOLO EL CORREO: `app_platform` no tiene ni una columna de
    // `practitioner`, que es donde vive el nombre, y la ficha tampoco lo devuelve.
    expect(Object.keys(salida.consultas[0]?.doctora ?? {})).toEqual(['correo']);
  });
});

describe('GET /v1/platform/licenses · la bandeja', () => {
  it('firma un enlace de cinco minutos a la credencial', async () => {
    const caso = new ListLicenses(
      puerto([], [licencia(1, 'lic/22222221-2222-4222-8222-222222222222/credencial.pdf')]),
      ALMACEN,
      reloj,
    );
    const salida = await caso.run(readLicenseInbox({}), ACTOR);
    const fila = salida.licencias[0];

    expect(fila?.credencial_url).toContain('X-Amz-Signature=');
    expect(fila?.credencial_url).toContain('credencial.pdf');
    expect(fila?.credencial_caduca_en).toBe(
      new Date(AHORA.getTime() + 5 * 60_000).toISOString(),
    );
  });

  it('sin credencial subida el enlace es NULO, no uno roto', async () => {
    // Todo lo que esté en `sin_enviar`, incluidas las consultas cuya matrícula puso la
    // consola en el alta. Una bandeja con un enlace roto es peor que una sin enlace.
    const caso = new ListLicenses(puerto([], [licencia(1, null)]), ALMACEN, reloj);
    const salida = await caso.run(readLicenseInbox({}), ACTOR);

    expect(salida.licencias[0]?.credencial_url).toBeNull();
    expect(salida.licencias[0]?.credencial_caduca_en).toBeNull();
  });

  it('trae lo que hace falta para decidir, y ni un dato de paciente', async () => {
    const caso = new ListLicenses(puerto([], [licencia(1, 'lic/x/c.pdf')]), ALMACEN, reloj);
    const salida = await caso.run(readLicenseInbox({}), ACTOR);

    expect(Object.keys(salida.licencias[0] ?? {}).sort()).toEqual([
      'consulta',
      'credencial_caduca_en',
      'credencial_url',
      'doctora',
      'enviada_en',
      'especialidad',
      'estado',
      'matricula',
      'pais_ejercicio',
      'practice_id',
      'respuesta_estimada_en',
    ]);
  });
});
