// El filtro de errores, en lo único que no se puede probar con dobles: **a quién se le
// atribuye un 500 en `service_failure`**. La fila la escribe un rol de base bajo una política,
// así que esto va contra la base real.
//
// EL CASO QUE ESTE ARCHIVO EXISTE PARA FIJAR: un 500 de una ruta de CONSOLA deja la fila
// **con actor**. Una ruta de consola nunca tiene `caller` —la persona de plataforma no tiene
// cuenta en esta región ni sesión que leer—, así que antes de hoy sus fallos entraban por el
// camino anónimo y la fila quedaba sin `actor_id`. Y es soporte actuando sobre la cuenta de
// una paciente: la bitácora de fallos es lo único que hace revisable lo que soporte hace.

import type { ArgumentsHost } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FAILURE_PHRASES, ServiceFailure } from '../contract/error-catalog';
import { FailureLog } from '../failures/service-failure';
import type { PlatformCaller } from '../platform/platform-token';
import { ErrorFilter } from './error.filter';
import type { RequestContext } from './request-context';
import { ROUTE_POLICIES } from './route-policy';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl =
  process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 1 });
const filter = new ErrorFilter(new FailureLog(app), 'latam');

/** El `sub` del token de consola: un uuid, y sin fila en `account` detrás. */
const SUBJECT = 'aaaaaaaa-0000-4000-8000-00000000000f';

const PLATFORM: PlatformCaller = {
  via: 'plataforma',
  subject: SUBJECT,
  label: 'Soporte MedSkin',
  // La región del TOKEN es otra a propósito: la fila tiene que llevar la del despliegue.
  region: 'eu',
  permissions: ['plataforma:consultas:leer'],
};

type Row = {
  actor_id: string | null;
  practice_id: string | null;
  region: string | null;
  operation: string;
  error_code: string;
  error_message: string;
  trace_id: string;
};

/**
 * Lo mínimo que el filtro lee de la petición. No es una prueba de interfaz: no hay HTTP, no
 * hay Nest levantado y no se comprueba ninguna ruta — se comprueba a quién se atribuye el
 * fallo, que es lógica del filtro.
 */
function hostOf(route: string, context: Partial<RequestContext>): ArgumentsHost {
  const sent: { status: number; body: unknown }[] = [];
  const req = {
    method: 'GET',
    url: route,
    headers: {},
    routeOptions: { url: route },
    medskin: {
      requestId: 'peticion-1',
      traceId: 'traza-1',
      ip: '127.0.0.1',
      device: {
        deviceId: 'consola',
        model: null,
        os: null,
        appVersion: null,
        platform: null,
        city: null,
      },
      policy: ROUTE_POLICIES[`GET ${route}`] ?? { failurePhrase: FAILURE_PHRASES.fallback },
      caller: null,
      recovery: null,
      platform: null,
      ...context,
    },
  };
  // `header` existe porque el filtro devuelve `X-Request-Id` en toda respuesta, también en
  // los errores: es lo que convierte «me dio error» en una línea buscable en la bitácora.
  const cabeceras: Record<string, string> = {};
  const res = {
    header(nombre: string, valor: string) {
      cabeceras[nombre] = valor;
      return res;
    },
    status(status: number) {
      return {
        send(body: unknown) {
          sent.push({ status, body });
        },
      };
    },
  };

  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    sent,
    cabeceras,
  } as unknown as ArgumentsHost & { sent: typeof sent; cabeceras: Record<string, string> };
}

/** La fila que acabó de escribirse para esta traza. El dueño es superusuario y ve la tabla. */
async function rowOf(traceId: string): Promise<Row | undefined> {
  const { rows } = await owner.query<Row>(
    `select actor_id, practice_id, region, operation, error_code, error_message, trace_id
       from service_failure where trace_id = $1`,
    [traceId],
  );
  return rows[0];
}

async function clean() {
  await owner.query(`delete from service_failure where trace_id in ('traza-1', 'traza-2')`);
}

beforeAll(clean);
afterAll(async () => {
  await clean();
  await owner.end();
  await app.end();
});

describe('un 500 de una ruta de consola', () => {
  it('deja la fila CON actor, con la región del despliegue y sin consulta', async () => {
    const host = hostOf('/v1/platform/tenants/:id', { platform: PLATFORM });

    filter.catch(
      new ServiceFailure(FAILURE_PHRASES.readTenant, new Error('la base no contestó')),
      host,
    );

    // El registro es `void` dentro del filtro —un fallo al registrar no convierte un 500 en
    // dos—, así que se espera a que la fila exista.
    const row = await waitFor(() => rowOf('traza-1'));

    // LO QUE IMPORTA: quién lo pidió.
    expect(row?.actor_id).toBe(SUBJECT);
    // La del despliegue, no la del token: para una audiencia de otra región ya hay un 403.
    expect(row?.region).toBe('latam');
    // El fallo es de una petición de soporte, no de la consulta sobre la que miraba:
    // atribuírsela la haría aparecer en el panel de fallos de una consulta que no hizo nada.
    expect(row?.practice_id).toBeNull();
    expect(row?.operation).toBe('GET /v1/platform/tenants/:id');
    expect(row?.error_code).toBe('fallo_de_servicio');
    // La causa real del motor, que es para arreglarlo. La frase del contrato va al cliente y
    // no a la tabla.
    expect(row?.error_message).toBe('la base no contestó');
  });

  it('y la respuesta al cliente sigue siendo la frase del contrato, sin causa ni pila', () => {
    const host = hostOf('/v1/platform/tenants/:id', {
      platform: PLATFORM,
      traceId: 'traza-2',
      requestId: 'peticion-2',
    }) as ArgumentsHost & { sent: { status: number; body: unknown }[] };

    filter.catch(
      new ServiceFailure(FAILURE_PHRASES.readTenant, new Error('select … permission denied')),
      host,
    );

    // El cuerpo lleva `error` Y `meta`: el sobre acompaña a las dos mitades del contrato,
    // y `meta` es lo que permite cruzar esta respuesta con su fila de `service_failure`.
    expect(host.sent).toEqual([
      {
        status: 500,
        body: {
          error: {
            codigo: 'fallo_de_servicio',
            mensaje:
              'No pudimos cargar la consulta. El servidor no respondió: puedes volver a intentarlo.',
            campo: null,
          },
          meta: {
            peticion_id: 'peticion-2',
            traza_id: 'traza-2',
            servidor_en: expect.any(String) as unknown as string,
            region: 'latam',
          },
        },
      },
    ]);
  });
});

/** La escritura de la fila es asíncrona y deliberadamente no esperada por el filtro. */
async function waitFor(read: () => Promise<Row | undefined>): Promise<Row | undefined> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const row = await read();
    if (row !== undefined) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}
