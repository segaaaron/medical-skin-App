// Solo HTTP. La autorización la hizo el guardia por lista blanca de rutas, y quién llama
// sale del token (`caller.ts`): ni un `cuenta_id` de la URL, porque la ruta es `/mia`.

import { Controller, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import type { Caller } from '../access/application/caller';
import { ChangeOwnPassword } from './application/change-password';
import { SendPatientAccess } from './application/send-patient-access';

function callerOf(req: RequestWithContext): Caller {
  const ctx = req.medskin;
  if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
  if (ctx.caller === null) throw new ContractError('token_no_valido');
  return ctx.caller;
}

@Controller('v1/cuentas')
export class AccountsController {
  // `@Inject` explícito: esbuild no emite `emitDecoratorMetadata`.
  constructor(
    @Inject(ChangeOwnPassword) private readonly changePassword: ChangeOwnPassword,
    @Inject(SendPatientAccess) private readonly sendAccess: SendPatientAccess,
  ) {}

  @Patch('mia/contrasena')
  @HttpCode(200)
  async newPassword(@Req() req: RequestWithContext) {
    return this.changePassword.run(req.body, callerOf(req));
  }

  // El `cuenta_id` de la URL NO autoriza: entra como criterio de búsqueda dentro del
  // inquilino del token, y si no hay vínculo en esa consulta, el 404 es el mismo que el de
  // una cuenta inventada.
  @Post(':cuenta_id/acceso')
  @HttpCode(200)
  async access(@Req() req: RequestWithContext, @Param('cuenta_id') accountId: string) {
    if (!UUID.test(accountId)) throw new ContractError('paciente_no_existe');
    return this.sendAccess.run(req.body, accountId, callerOf(req));
  }
}

// Un `cuenta_id` que no es un uuid no tiene vínculo en ninguna consulta, así que responde
// lo mismo que uno inventado y no se consulta nada.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
