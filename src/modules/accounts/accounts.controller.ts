// Solo HTTP. La autorización la hizo el guardia por lista blanca de rutas, y quién llama
// sale del token (`caller.ts`): ni un `cuenta_id` de la URL, porque la ruta es `/mia`.

import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import type { Caller } from '../access/application/caller';
import { ChangeOwnPassword } from './application/change-password';
import { DeleteOwnAccount } from './application/delete-own-account';
import { ReadOwnAccount } from './application/read-own-account';
import { SendPatientAccess } from './application/send-patient-access';

/** Lo comparte `team.controller.ts`: quien llama sale del token y de ningún otro sitio. */
export function callerOf(req: RequestWithContext): Caller {
  const ctx = req.medskin;
  if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
  if (ctx.caller === null) throw new ContractError('token_no_valido');
  return ctx.caller;
}

@Controller('v1/accounts')
export class AccountsController {
  // `@Inject` explícito: esbuild no emite `emitDecoratorMetadata`.
  constructor(
    @Inject(ChangeOwnPassword) private readonly changePassword: ChangeOwnPassword,
    @Inject(SendPatientAccess) private readonly sendAccess: SendPatientAccess,
    @Inject(ReadOwnAccount) private readonly readOwn: ReadOwnAccount,
    @Inject(DeleteOwnAccount) private readonly deleteOwn: DeleteOwnAccount,
  ) {}

  // Sin cuerpo y sin parámetros: la ruta es `/mia` y quien pregunta sale del token.
  @Get('mine')
  @HttpCode(200)
  async mine(@Req() req: RequestWithContext) {
    return this.readOwn.run(callerOf(req));
  }

  @Delete('mine')
  @HttpCode(200)
  async deleteMine(@Req() req: RequestWithContext) {
    return this.deleteOwn.run(req.body, callerOf(req));
  }

  @Patch('mine/password')
  @HttpCode(200)
  async newPassword(@Req() req: RequestWithContext) {
    return this.changePassword.run(req.body, callerOf(req));
  }

  // El `cuenta_id` de la URL NO autoriza: entra como criterio de búsqueda dentro del
  // consulta del token, y si no hay vínculo en esa consulta, el 404 es el mismo que el de
  // una cuenta inventada.
  @Post(':account_id/access')
  @HttpCode(200)
  async access(@Req() req: RequestWithContext, @Param('account_id') accountId: string) {
    if (!UUID.test(accountId)) throw new ContractError('paciente_no_existe');
    return this.sendAccess.run(req.body, accountId, callerOf(req));
  }
}

// Un identificador que no es un uuid no tiene fila en ninguna consulta, así que responde lo
// mismo que uno inventado y no se consulta nada. Y hace falta comprobarlo antes: con un
// `miembro_id` así, la base muere con «invalid input syntax for type uuid» y eso sería un
// 500 donde el contrato promete un 404. Lo comparte `team.controller.ts`.
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
