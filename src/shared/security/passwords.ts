// Argon2id en Node y no en la base: no hay extensión de Argon2 y meterla sería una
// dependencia de C en el motor para hacer lo que el proceso ya hace.
//
// El parámetro que importa aquí no es el coste, es que sea EL MISMO en los dos caminos: el
// hash real y el del señuelo se verifican con la misma llamada y el mismo trabajo, porque
// si el señuelo tardara menos, el cronómetro sería el oráculo que el
// `401 acceso_no_coincide` existe para cerrar. Y el señuelo se siembra con estos mismos
// parámetros (`seed.ts`): si divergen, el oráculo vuelve por la puerta del reloj.

import argon2 from 'argon2';

/** OWASP Password Storage Cheat Sheet, perfil de 2024: 19 MiB, 2 pasadas, 1 hilo. */
export const ARGON2_COST = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
} as const;

export class Argon2Passwords {
  async hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_COST);
  }

  /**
   * `false` en vez de lanzar cuando el hash está corrupto o no es de Argon2id: para quien
   * llama es el mismo hecho —no coincide— y una excepción aquí sería un 500 que distingue
   * una cuenta con credencial rota de una contraseña equivocada.
   */
  async verify(hash: string, password: string): Promise<boolean> {
    try {
      // Sin opciones: los parámetros van DENTRO del hash codificado, y por eso el
      // verificado del señuelo cuesta lo mismo que el real mientras el señuelo se siembre
      // con `hash()` de aquí mismo. `seed.ts` lo hace, y es la mitad del «mismo tiempo».
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
}
