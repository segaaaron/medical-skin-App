// Lo que se lee de cada petición, una vez y en un sitio. Las cabeceras son las de
// `_convenciones.md` · Cabeceras.

import { randomUUID } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import type { Caller } from '../../modules/access/application/caller';
import type { Device } from '../../modules/access/domain/ports';
import type { RoutePolicy } from './route-policy';

export type RequestContext = {
  requestId: string;
  traceId: string;
  ip: string;
  device: Device;
  policy: RoutePolicy;
  /** Nulo en las rutas sin `Authorization`. Lo pone el guardia, del token y de nada más. */
  caller: Caller | null;
};

/** El tipo que el guardia cuelga de la petición. No se escribe nada más en ella. */
export type RequestWithContext = FastifyRequest & { medskin?: RequestContext };

function singleHeader(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  const text = Array.isArray(value) ? value[0] : value;
  if (text === undefined) return null;
  const trimmed = text.trim();
  // Tope de largo: una cabecera es entrada del cliente y va a parar a una columna de
  // texto y a la bitácora (OWASP A03).
  return trimmed === '' ? null : trimmed.slice(0, 120);
}

/** `X-MedSkin-App: ios/2.4.1` → plataforma y versión. */
function readAppHeader(value: string | null): {
  platform: Device['platform'];
  appVersion: string | null;
} {
  if (value === null) return { platform: null, appVersion: null };
  const [system, version] = value.split('/', 2);
  const platform =
    system === 'ios' || system === 'android' || system === 'server' ? system : null;
  return { platform, appVersion: version ?? null };
}

export function readRequest(req: FastifyRequest): Omit<RequestContext, 'policy' | 'caller'> {
  const headers = req.headers;
  const { platform, appVersion } = readAppHeader(singleHeader(headers['x-medskin-app']));
  const id = randomUUID();

  return {
    requestId: id,
    traceId: singleHeader(headers['x-request-id']) ?? id,
    // `trustProxy` está puesto en el adaptador: el borde resuelve la región y reenvía, y
    // sin eso el límite por IP contaría todas las peticiones como una sola.
    ip: req.ip,
    device: {
      deviceId: singleHeader(headers['x-medskin-dispositivo']) ?? 'sin-dispositivo',
      // `_convenciones.md` no define cabecera para el modelo ni para el sistema, y
      // `GET /v1/acceso/sesiones` devuelve los dos («iPhone 15 Pro», «iOS 18.2»). Se leen
      // de estas dos, que es la extensión natural de la que sí está definida, y queda
      // anotado para `producto`: sin ellas la lista de sesiones sale con nulos.
      model: singleHeader(headers['x-medskin-modelo']),
      os: singleHeader(headers['x-medskin-sistema']),
      appVersion,
      platform,
      // `ciudad` se resuelve de la IP y aquí no hay resolvedor: el tramo no trae base
      // geográfica. Queda nula y la lista de sesiones la devuelve nula, que es verdad.
      city: null,
    },
  };
}

/** La ruta tal y como la registró Fastify, con sus parámetros: `/v1/acceso/sesiones/:id`. */
export function registeredRoute(req: FastifyRequest): string | undefined {
  const withRoute = req as FastifyRequest & {
    routeOptions?: { url?: string };
    routerPath?: string;
  };
  return withRoute.routeOptions?.url ?? withRoute.routerPath;
}
