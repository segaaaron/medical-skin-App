// LA LISTA BLANCA DE RUTAS. `sesion.md`: «El alcance se comprueba en un guardia global,
// antes de cualquier módulo, y POR LISTA BLANCA DE RUTAS. No por lista negra: una ruta
// nueva nace CERRADA para los alcances restringidos, no abierta».
//
// Es lo que hace cumplible la regla de la contraseña temporal: con un `siguiente_paso`
// solo, una app con un error de navegación —o un cliente escrito a mano— se la salta.
//
// Y la tabla lleva además la frase del 500 de cada endpoint, porque es obligatoria y
// cambia por endpoint (`_convenciones.md` · «El 500, en todas partes»). Dos usos, una
// tabla: quien añada una ruta tiene que decidir las dos cosas en el mismo sitio.

import { FAILURE_PHRASES } from '../contract/error-catalog';
import type { Scope } from '../contract/session';

export type RoutePolicy = {
  /** `true` solo para los tres endpoints sin `Authorization` del tramo. */
  anonymous?: true;
  /** Los alcances que esta ruta autoriza. Cualquier otro se deniega. */
  scopes?: readonly Scope[];
  /** La frase completa del `500 fallo_de_servicio` de este endpoint, literal. */
  failurePhrase: string;
};

const ALL_SCOPES: readonly Scope[] = [
  'contrasena_temporal',
  'recuperacion',
  'segundo_factor',
  'completo',
];

/**
 * La clave es `MÉTODO ruta` con la ruta tal y como la registra Fastify, parámetros
 * incluidos (`:sesion_id`). Una ruta que no está aquí se deniega: no hay «por defecto».
 */
export const ROUTE_POLICIES: Readonly<Record<string, RoutePolicy>> = {
  'POST /v1/acceso': { anonymous: true, failurePhrase: FAILURE_PHRASES.signIn },

  // Los dos de recuperación, sin `Authorization` como el acceso: cuando llegan no hay
  // sesión que leer y por eso corren con `app_anonymous` (`recuperacion.md`).
  'POST /v1/recuperacion': {
    anonymous: true,
    failurePhrase: FAILURE_PHRASES.requestRecoveryCode,
  },
  'POST /v1/recuperacion/codigo': {
    anonymous: true,
    failurePhrase: FAILURE_PHRASES.checkRecoveryCode,
  },

  // Los dos alcances que existen para llegar a esta pantalla, y ningún otro: un token
  // `completo` aquí es `401 token_sin_alcance`, «Esta pantalla ya no corresponde».
  'POST /v1/acceso/contrasena-nueva': {
    scopes: ['contrasena_temporal', 'recuperacion'],
    failurePhrase: FAILURE_PHRASES.savePassword,
  },

  // «cualquiera con sesión, de cualquier alcance»: nadie se queda dentro contra su
  // voluntad porque su token sea restringido.
  'DELETE /v1/acceso': { scopes: ALL_SCOPES, failurePhrase: FAILURE_PHRASES.signOut },

  'GET /v1/acceso/sesiones': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.listSessions,
  },
  'DELETE /v1/acceso/sesiones': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.closeSession,
  },
  'DELETE /v1/acceso/sesiones/:sesion_id': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.closeSession,
  },

  // `cuentas.md`. Solo `completo`: cambiar la contraseña sabiendo la actual no es una
  // pantalla a la que se llegue con un alcance restringido, y la que sí lo es
  // —`contrasena-nueva`— es otra ruta.
  'PATCH /v1/cuentas/mia/contrasena': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.changePassword,
  },
  'POST /v1/cuentas/:cuenta_id/acceso': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.sendPatientAccess,
  },
};

export function policyFor(method: string, route: string | undefined): RoutePolicy | null {
  if (route === undefined) return null;
  return ROUTE_POLICIES[`${method.toUpperCase()} ${route}`] ?? null;
}
