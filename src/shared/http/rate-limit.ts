// El límite de ritmo del borde · decidido el 2 de noviembre de 2026.
//
// LO QUE HABÍA: `rateLimit({ max: 120, timeWindow: '1 minute' })` con la clave por omisión,
// que es `req.ip`, y `trustProxy: true` en el adaptador. Esa pareja fallaba por los dos
// lados a la vez, y las dos mitades están medidas:
//
//   1. `trustProxy: true` hace que `req.ip` sea el valor que el CLIENTE escribió en
//      `X-Forwarded-For`. Comprobado contra Fastify 5.12.7 con `inject`: con la cabecera
//      `1.2.3.4, 10.0.0.9` el servidor lee `1.2.3.4`. O sea que una cabecera distinta en
//      cada petición daba un cubo nuevo cada vez, y con ella se saltaban este límite Y los
//      20 fallos de acceso por IP de `access-pause.ts`. Lo que quedaba en pie era el
//      contador por correo —5 en 15 minutos—, que frena el ataque contra UNA cuenta; un
//      barrido sobre muchos correos pasaba. El arreglo no está aquí sino en `main.ts`:
//      `trustProxy` con la red del proxy, nunca `true`.
//
//   2. Y a la vez castigaba a quien no había hecho nada: cuando nadie manda la cabecera,
//      una consulta entera —el doctor, su asistente y las pacientes en la sala— sale por la
//      IP del WiFi, y un celular detrás del CGNAT de una operadora la comparte con
//      desconocidos. Un cubo de 120 por minuto para todos ellos, contando TAMBIÉN las
//      peticiones que el servidor contestó con un 500: durante una incidencia, los
//      reintentos de la app gastaban la cuota y el usuario pasaba de «el servidor falló» a
//      «te bloqueamos». Eso es lo que no puede volver a pasar.
//
// LO QUE HAY AHORA: dos cubos distintos, porque son dos riesgos distintos.
//
//   · SIN sesión, la clave es la IP real y el número es BAJO. Ahí vive el abuso —entrar a
//     ciegas, pedir códigos, probar refrescos— y ahí es donde un límite estrecho es
//     correcto. Además de este, esas tres rutas tienen sus contadores por correo y por IP
//     en Postgres, que sobreviven a un cambio de IP y son el límite de verdad.
//
//   · CON sesión, la clave es el DISPOSITIVO y el número es alto. Deja de importar cuánta
//     gente comparte la IP, que es la causa raíz del bloqueo injusto, y lo que el límite
//     frena pasa a ser lo único que tiene que frenar en una ruta autenticada: un bucle de
//     reintentos de la app. Diez peticiones por segundo sostenidas no las hace una persona.
//
// ponytail: la clave del dispositivo la pone el cliente, así que REPARTE CARGA LEGÍTIMA y
// no frena a un atacante con token válido, que puede rotar la cabecera y pedir cubo nuevo.
// Es deliberado: lo que acota a quien ya entró son los límites de negocio por cuenta y por
// consulta (altas, reenvíos, refrescos) y las políticas de la base, no el ritmo del borde.
// El techo volumétrico —una IP tirando a toda la API— le toca al proxy de delante, que es
// quien puede cortar antes de que la petición cueste una conexión de Postgres.

import type { FastifyRequest } from 'fastify';

/**
 * Sin sesión: 60 por minuto y por IP real. Es la mitad de lo que había, y se puede bajar:
 * entrar, recuperar y refrescar son acciones que una persona hace de una en una.
 */
export const RITMO_ANONIMO_POR_MINUTO = 60;

/**
 * Con sesión: 600 por minuto y por dispositivo, que son diez por segundo. Una pantalla del
 * dashboard que abre veinte peticiones en paralelo gasta veinte; lo que se come 600 es un
 * reintento en bucle, que es justo lo que hay que cortar.
 */
export const RITMO_CON_SESION_POR_MINUTO = 600;

/** La cabecera estable que ya manda cada app (`_convenciones.md`). */
const CABECERA_DISPOSITIVO = 'x-medskin-dispositivo';

/** Lo que entra en una clave se recorta, igual que en `request-context.ts`. */
const LARGO_MAXIMO = 120;

function dispositivoDe(req: FastifyRequest): string | null {
  // La sesión primero: sin `Authorization` la petición es anónima y cuenta por IP aunque
  // traiga la cabecera del dispositivo, que es entrada del cliente y no una credencial.
  if (typeof req.headers.authorization !== 'string' || req.headers.authorization === '') {
    return null;
  }
  const bruto = req.headers[CABECERA_DISPOSITIVO];
  const valor = Array.isArray(bruto) ? bruto[0] : bruto;
  if (typeof valor !== 'string' || valor.trim() === '') return null;
  return valor.trim().slice(0, LARGO_MAXIMO);
}

/**
 * La clave del cubo. `dev:` y `ip:` llevan prefijo para que un dispositivo que se llame
 * como una dirección no caiga en el cubo de esa dirección.
 */
export function claveDeRitmo(req: FastifyRequest): string {
  const dispositivo = dispositivoDe(req);
  return dispositivo === null ? `ip:${req.ip}` : `dev:${dispositivo}`;
}

/** El número que le toca a esa clave. */
export function maximoDeRitmo(req: FastifyRequest): number {
  return dispositivoDe(req) === null ? RITMO_ANONIMO_POR_MINUTO : RITMO_CON_SESION_POR_MINUTO;
}

type ErrorDeRitmo = Error & { statusCode: number; segundos: number };

/**
 * EL 429 DICE CUÁNTOS SEGUNDOS, y es el cambio que convierte un bloqueo en una espera.
 *
 * Antes salía `{ codigo: "demasiadas_peticiones", mensaje: "Vas muy rápido. Espera unos
 * segundos." }` y nada más: la app no tenía un número, así que adivinaba o reintentaba ya y
 * volvía a chocar. El plugin pone además `retry-after` y las cabeceras `RateLimit` del
 * borrador del IETF —`enableDraftSpec`—, pero una cabecera no es el contrato de esta API y
 * un cliente de navegador no la lee si no está en `exposedHeaders`. Por eso el número viaja
 * también en `datos`, que es donde el contrato dice que va «solo lo que la frase necesita».
 */
export function errorDeRitmo(
  _req: FastifyRequest,
  ctx: { statusCode: number; ttl: number },
): ErrorDeRitmo {
  const error = new Error('limite de ritmo') as ErrorDeRitmo;
  error.statusCode = ctx.statusCode;
  // `ttl` llega en milisegundos. Nunca 0: «reintenta en 0 segundos» es un reintento
  // inmediato, que es otro choque.
  error.segundos = Math.max(1, Math.ceil(ctx.ttl / 1000));
  return error;
}

/** Los `datos` del 429, para el filtro. `null` cuando lo lanzado no es de este límite. */
export function esperaDeRitmo(lanzado: unknown): { reintentar_en_segundos: number } | null {
  if (typeof lanzado !== 'object' || lanzado === null) return null;
  const { segundos } = lanzado as { segundos?: unknown };
  if (typeof segundos !== 'number' || !Number.isFinite(segundos) || segundos <= 0) return null;
  return { reintentar_en_segundos: Math.ceil(segundos) };
}

/**
 * Lo que se le pasa al plugin. `continueExceeding` se queda en su valor por omisión a
 * propósito: en `true` la ventana se renueva en cada golpe y una pausa de un minuto se
 * vuelve perpetua, que es la misma trampa que `Counters.increment()` documenta y evita.
 */
export const OPCIONES_DE_RITMO = {
  max: maximoDeRitmo,
  timeWindow: '1 minute',
  keyGenerator: claveDeRitmo,
  errorResponseBuilder: errorDeRitmo,
  // Las cabeceras del borrador del IETF en TODA respuesta, no solo en la que falla: así la
  // app sabe cuánta cuota le queda ANTES de agotarla y puede frenar sola. Es la diferencia
  // entre un cliente que se porta bien y uno que no puede. Esta versión del plugin emite
  // `ratelimit-limit`, `ratelimit-remaining` y `ratelimit-reset` (y `retry-after` en el 429);
  // los mismos nombres están en `exposedHeaders` del CORS y los fija la prueba.
  enableDraftSpec: true,
  // Un 429 no deja fila en `service_failure` —a propósito: un cliente sin sesión inundaría
  // el registro gratis— así que sin esto nadie sabría si el límite está molestando a gente
  // real. Una línea, con la CLASE de clave y nunca la clave: un `dev:` repetido sería un
  // identificador de dispositivo en la salida del proceso.
  onExceeded: (_req: FastifyRequest, key: string) =>
    process.stdout.write(`429 ritmo ${key.startsWith('dev:') ? 'dev' : 'ip'}\n`),
} as const;
