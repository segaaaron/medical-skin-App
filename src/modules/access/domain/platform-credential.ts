// LA CREDENCIAL DE CONSOLA · `plataforma-acceso.md` · «La entrada de la consola».
//
// Puerto propio y no un campo más en `CredentialPort`, por la misma razón por la que la
// tabla es propia: lo que devuelve `medskin_platform_credential` no tiene cuenta, ni rol de
// autenticación, ni consulta, ni contraseña temporal. Meterlo en `AccessCredential` sería
// un tipo con ocho campos nulos cuyo significado depende de por dónde se entró, y el día que
// alguien lea el campo equivocado no habría tipo que lo impidiera.

import type { PlatformPermission } from '../../../shared/platform/platform-token';

/**
 * Lo que la función de la base devuelve, y lo mínimo para decidir.
 *
 * `platformAccountId` NULO significa **señuelo**: el correo no existe y `hash` es el de
 * `access_decoy`. Eso lo sabe el proceso y no la respuesta HTTP, que es un solo
 * `401 acceso_no_coincide` en los dos casos.
 *
 * `hash` nunca es nulo. Si lo fuera no habría «mismo tiempo», y sin «mismo tiempo» el 401
 * miente: la función de la base lanza antes que devolver una fila sin él.
 */
export type PlatformCredential = {
  platformAccountId: string | null;
  label: string | null;
  permissions: readonly string[] | null;
  status: string | null;
  hash: string;
  lockedUntil: Date | null;
  attemptsLeft: number;
};

export interface PlatformCredentialPort {
  /** `medskin_platform_credential()` con `app_anonymous`. */
  read(email: string): Promise<PlatformCredential>;
  /**
   * `medskin_platform_attempt()`: mueve `failed_attempts`, la pausa de la fila **y escribe
   * la línea de `access_audit`**. Un correo sin fila no deja rastro: no se le inventa una
   * cuenta donde contar, y `access_audit` no guarda correos.
   */
  recordAttempt(email: string, matched: boolean): Promise<void>;
}

/** Lo que firma el token, ya validado contra la lista cerrada. */
export type PlatformSignInResponse = {
  token: string;
  caduca_en: string;
  etiqueta: string;
  region: string;
  region_etiqueta: string;
  /**
   * Los permisos viajan **además** de ir dentro del token, y no es redundante: es lo que la
   * consola usa para no dibujar un botón que va a responder `403 sin_permiso`. La consola no
   * decodifica el token —no tiene la llave y no debe tenerla—, así que sin esto tendría que
   * deducirlo del primer 403, que es dibujar primero y descubrir después.
   */
  permisos: readonly PlatformPermission[];
};
