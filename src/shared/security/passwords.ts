// Argon2id en Node y no en la base: no hay extensión de Argon2 y meterla sería una
// dependencia de C en el motor para hacer lo que el proceso ya hace.
//
// El parámetro que importa aquí no es el coste, es que sea EL MISMO en los dos caminos: el
// hash real y el del señuelo se verifican con la misma llamada y el mismo trabajo, porque
// si el señuelo tardara menos, el cronómetro sería el oráculo que el
// `401 acceso_no_coincide` existe para cerrar. Y el señuelo se siembra con estos mismos
// parámetros (`seed.ts`): si divergen, el oráculo vuelve por la puerta del reloj.

import argon2 from 'argon2';

import type { FailureContext, FailureLog } from '../failures/service-failure';

/** OWASP Password Storage Cheat Sheet, perfil de 2024: 19 MiB, 2 pasadas, 1 hilo. */
export const ARGON2_COST = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Lo mínimo del registro de fallos. `FailureLog` lo cumple y es quien se inyecta. */
export type FailureSink = Pick<FailureLog, 'record'>;

export class Argon2Passwords {
  /**
   * El registro es OPCIONAL para que las pruebas del dominio no tengan que levantar nada;
   * en la aplicación va siempre puesto (`shared.module.ts`).
   */
  constructor(private readonly failures?: FailureSink) {}

  async hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_COST);
  }

  /**
   * `false` en vez de lanzar cuando el hash está corrupto o no es de Argon2id: para quien
   * llama es el mismo hecho —no coincide— y una excepción aquí sería un 500 que distingue
   * una cuenta con credencial rota de una contraseña equivocada.
   *
   * PERO LA CAUSA NO SE TIRA. Devolver `false` y callar deja una credencial con el hash
   * roto dando `acceso_no_coincide` para siempre sin que nadie se entere: la persona no
   * puede entrar, no puede recuperar si su temporal nunca se estrenó, y en la base no hay
   * una línea que lo diga. Va una fila de aviso a `service_failure` con la cuenta y SIN EL
   * HASH, que es un secreto y además es lo que no hace falta para arreglarlo. La respuesta
   * de quien llama no cambia en nada.
   */
  async verify(hash: string, password: string, who?: FailureContext): Promise<boolean> {
    try {
      // Sin opciones: los parámetros van DENTRO del hash codificado, y por eso el
      // verificado del señuelo cuesta lo mismo que el real mientras el señuelo se siembre
      // con `hash()` de aquí mismo. `seed.ts` lo hace, y es la mitad del «mismo tiempo».
      return await argon2.verify(hash, password);
    } catch (cause) {
      this.reportUnreadable(cause, who);
      return false;
    }
  }

  /**
   * Sin `await` a propósito: el registro no puede cambiar lo que tarda el camino del 401.
   * `FailureLog.record()` nunca lanza (§10.3, regla 6).
   *
   * Y solo con cuenta conocida: sin ella el hash es el del SEÑUELO, que no tiene dueño y
   * cuya forma ya la garantiza `access_decoy_hash_ck`. Registrarlo escribiría una fila por
   * cada intento fallido de cualquiera, que es inundar el registro gratis.
   */
  private reportUnreadable(cause: unknown, who: FailureContext | undefined): void {
    if (this.failures === undefined || who === undefined) return;
    void this.failures.record({
      service: 'api',
      operation: 'argon2.verify',
      severity: 'warning',
      errorCode: 'credencial_ilegible',
      // El hash NO entra: ni como argumento ni dentro del mensaje. Lo que la librería dice
      // («Output is too short», «pchstr must contain a $ as first char») viaja encadenado,
      // que es la causa real y no lleva nada del secreto.
      cause: new Error('hash de credencial ilegible', { cause }),
      traceId: 'sin-traza',
      requestId: 'sin-peticion',
      appVersion: null,
      platform: null,
      region: null,
      context: who,
    });
  }
}
