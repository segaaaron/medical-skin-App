// El límite de ritmo del borde · lo que se fija aquí:
//
//   1. una `X-Forwarded-For` escrita por el cliente NO cambia la clave del cubo —es el
//      fallo del 2 de noviembre de 2026, y la prueba que lo reproduce con `trustProxy: true`
//      está debajo para que nadie vuelva a poner ese valor sin verlo fallar—;
//   2. con sesión la clave es el dispositivo y el número es el alto; sin ella, la IP real y
//      el número bajo;
//   3. el 429 llega con los segundos que hay que esperar, y no con cero.
//
// Va con Fastify a pelo y `inject`: no hace falta levantar Nest ni Postgres para fijar lo
// que decide una clave y un número.

import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { describe, expect, it } from 'vitest';

import {
  claveDeRitmo,
  errorDeRitmo,
  esperaDeRitmo,
  maximoDeRitmo,
  OPCIONES_DE_RITMO,
  RITMO_ANONIMO_POR_MINUTO,
  RITMO_CON_SESION_POR_MINUTO,
} from './rate-limit';

const REDES = ['127.0.0.1/8', '::1/128', '10.0.0.0/8'];
const DISPOSITIVO = '7f3c1e2a-0000-4000-8000-000000000001';

/** Lo que el proxy deja al reenviar: a la derecha, la IP que el cliente no puede escribir. */
const CADENA_FALSIFICADA = '1.2.3.4, 203.0.113.9';

async function servidor(trustProxy: boolean | string[]) {
  const app = Fastify({ trustProxy });
  app.get('/eco', (req, res) =>
    res.send({ ip: req.ip, clave: claveDeRitmo(req), maximo: maximoDeRitmo(req) }),
  );
  await app.ready();
  return app;
}

describe('la clave del cubo', () => {
  it('con las redes de confianza, la cabecera del cliente NO decide la IP', async () => {
    const app = await servidor(REDES);
    const r = await app.inject({
      method: 'GET',
      url: '/eco',
      headers: { 'x-forwarded-for': CADENA_FALSIFICADA },
    });

    // La de la derecha: la que añadió el proxy. `1.2.3.4` es lo que escribió el cliente y
    // queda a la izquierda, donde no se lee.
    expect(r.json()).toMatchObject({ ip: '203.0.113.9', clave: 'ip:203.0.113.9|GET /eco' });
    await app.close();
  });

  it('EL FALLO QUE SE ARREGLÓ: con `trustProxy: true` la cabecera sí decide', async () => {
    const app = await servidor(true);
    const r = await app.inject({
      method: 'GET',
      url: '/eco',
      headers: { 'x-forwarded-for': CADENA_FALSIFICADA },
    });

    // Esto es exactamente lo que había en producción: un cubo nuevo por cada valor que el
    // cliente quiera inventar. Si algún día esta expectativa falla, Fastify cambió el
    // comportamiento y el arreglo de `main.ts` se puede revisar; mientras pase, no.
    expect(r.json()).toMatchObject({ ip: '1.2.3.4' });
    await app.close();
  });

  it('con sesión cuenta por dispositivo y con el número alto', async () => {
    const app = await servidor(REDES);
    const r = await app.inject({
      method: 'GET',
      url: '/eco',
      headers: {
        authorization: 'Bearer eyJhbGciOi…',
        'x-medskin-dispositivo': DISPOSITIVO,
        'x-forwarded-for': CADENA_FALSIFICADA,
      },
    });

    expect(r.json()).toMatchObject({
      clave: `dev:${DISPOSITIVO}|GET /eco`,
      maximo: RITMO_CON_SESION_POR_MINUTO,
    });
    await app.close();
  });

  it('el dispositivo SIN `Authorization` no vale: cuenta por IP y con el número bajo', async () => {
    const app = await servidor(REDES);
    const r = await app.inject({
      method: 'GET',
      url: '/eco',
      headers: { 'x-medskin-dispositivo': DISPOSITIVO, 'x-forwarded-for': CADENA_FALSIFICADA },
    });

    // Si la cabecera del dispositivo bastara, las tres rutas anónimas —entrar, recuperar,
    // refrescar— tendrían cubo nuevo a voluntad, que es el agujero de antes con otro nombre.
    expect(r.json()).toMatchObject({
      clave: 'ip:203.0.113.9|GET /eco',
      maximo: RITMO_ANONIMO_POR_MINUTO,
    });
    await app.close();
  });

  it('dos dispositivos de la MISMA IP no comparten cuota', async () => {
    const app = await servidor(REDES);
    const comun = { authorization: 'Bearer x', 'x-forwarded-for': '203.0.113.9' };
    const uno = await app.inject({
      method: 'GET',
      url: '/eco',
      headers: { ...comun, 'x-medskin-dispositivo': 'aaa' },
    });
    const otro = await app.inject({
      method: 'GET',
      url: '/eco',
      headers: { ...comun, 'x-medskin-dispositivo': 'bbb' },
    });

    // Es la causa raíz del bloqueo injusto: la consulta entera salía por la IP del WiFi.
    const clave = (r: { json: () => unknown }): unknown => (r.json() as { clave: unknown }).clave;
    expect(clave(uno)).toBe('dev:aaa|GET /eco');
    expect(clave(otro)).toBe('dev:bbb|GET /eco');
    await app.close();
  });
});

describe('el cubo es por ruta', () => {
  it('agotar una ruta NO deja con 429 a la misma persona en las demás', async () => {
    const app = Fastify({ trustProxy: REDES });
    await app.register(rateLimit, { ...OPCIONES_DE_RITMO, max: 1 });
    app.get('/uno', (_req, res) => res.send({ ok: true }));
    app.get('/dos', (_req, res) => res.send({ ok: true }));

    const cabeceras = { 'x-forwarded-for': '203.0.113.9' };
    const ir = async (url: string) =>
      (await app.inject({ method: 'GET', url, headers: cabeceras })).statusCode;

    expect(await ir('/uno')).toBe(200);
    expect(await ir('/uno')).toBe(429);
    // Mismo cliente, otra ruta: su cuota está intacta.
    expect(await ir('/dos')).toBe(200);
    await app.close();
  });
});

describe('el 429', () => {
  it('dice cuántos segundos esperar, y nunca cero', () => {
    expect(esperaDeRitmo(errorDeRitmo({} as never, { statusCode: 429, ttl: 37_000 }))).toEqual({
      reintentar_en_segundos: 37,
    });
    // 200 ms de ventana restante son «espera un segundo», no «reintenta ya».
    expect(esperaDeRitmo(errorDeRitmo({} as never, { statusCode: 429, ttl: 200 }))).toEqual({
      reintentar_en_segundos: 1,
    });
    expect(errorDeRitmo({} as never, { statusCode: 429, ttl: 1_000 }).statusCode).toBe(429);
  });

  it('los demás errores del transporte no traen `datos`', () => {
    expect(esperaDeRitmo(new Error('otra cosa'))).toBeNull();
    expect(esperaDeRitmo({ statusCode: 404 })).toBeNull();
    expect(esperaDeRitmo(null)).toBeNull();
    expect(esperaDeRitmo({ segundos: 0 })).toBeNull();
  });

  it('llega de verdad al pasar el límite, con sus cabeceras y su cuerpo', async () => {
    const app = Fastify({ trustProxy: REDES });
    // El mismo objeto que `main.ts` registra, con el número bajado para no mandar 61
    // peticiones en una prueba.
    await app.register(rateLimit, { ...OPCIONES_DE_RITMO, max: 1 });
    app.get('/eco', (_req, res) => res.send({ ok: true }));

    const cabeceras = { 'x-forwarded-for': '203.0.113.9' };
    const primera = await app.inject({ method: 'GET', url: '/eco', headers: cabeceras });
    const segunda = await app.inject({ method: 'GET', url: '/eco', headers: cabeceras });

    expect(primera.statusCode).toBe(200);
    // Las tres cabeceras del borrador del IETF, en la respuesta BUENA: con esto la app
    // frena antes de chocar en vez de enterarse cuando ya la frenaron. El plugin 11.2.1
    // emite la forma sin prefijo `X-` —`ratelimit-limit`, `-remaining`, `-reset`— y NO el
    // `RateLimit-Policy` de los borradores nuevos; los nombres de aquí son los que hay que
    // declarar en `exposedHeaders` del CORS, así que si el plugin los cambia, esto falla.
    expect(primera.headers).toHaveProperty('ratelimit-limit');
    expect(primera.headers).toHaveProperty('ratelimit-remaining');
    expect(primera.headers).toHaveProperty('ratelimit-reset');
    expect(segunda.statusCode).toBe(429);
    expect(segunda.headers['retry-after']).toBeDefined();
    // El cuerpo lo arma el filtro de Nest, que aquí no corre; lo que se fija es que lo
    // lanzado lleve los segundos, que es lo que el filtro pasa a `datos`.
    expect(esperaDeRitmo(segunda.json())).toBeNull();
    await app.close();
  });
});
