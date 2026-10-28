// DELETE /v1/plataforma/cuentas/{cuenta_id}/pausa · «Levantar la pausa por intentos · Vuelve
// a poder entrar. No cambia su contraseña.» (`Consola.dc.html` · 2).
//
// LA RESPUESTA SON DOS LITERALES, `{ pausa_hasta: null, intentos: 0 }`, y es a propósito: es
// lo que la operación DEJA, no una lectura de lo que había. Leer `failed_attempts` después de
// ponerlo a cero solo puede devolver cero, así que la lectura sería un viaje para confirmar
// lo que la sentencia ya garantizó.
//
// IDEMPOTENTE POR NATURALEZA: levantar una pausa levantada deja lo mismo y responde lo mismo.
// Por eso no lleva `Idempotency-Key` ni la necesita.
//
// Y NO TOCA LA CONTRASEÑA. No es una promesa del código: `app_platform` no tiene ni política
// ni grant sobre `credential`, así que soporte no puede tocarla ni queriendo.

import { ContractError } from '../../../shared/contract/error-catalog';
import type { ConsoleActor, PlatformAccessPort } from '../domain/ports';

export type LiftedPauseResponse = {
  pausa_hasta: null;
  intentos: number;
};

export class LiftAccessPause {
  constructor(private readonly accounts: PlatformAccessPort) {}

  async run(accountId: string, actor: ConsoleActor): Promise<LiftedPauseResponse> {
    // El `cuenta_id` viene de la ruta y no autoriza nada: es criterio de búsqueda bajo la
    // política de `app_platform`, y sin fila la respuesta es el mismo 404 que daría una
    // cuenta inventada, una borrada o una de otra región (OWASP A01).
    const lifted = await this.accounts.liftPause(actor, accountId);
    if (!lifted) throw new ContractError('cuenta_no_existe');

    return { pausa_hasta: null, intentos: 0 };
  }
}
