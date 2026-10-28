// Solo HTTP. La autorización la hizo el guardia por lista blanca de rutas, y quién llama
// sale del token (`caller.ts`): ni un `cuenta_id` de la URL, porque la ruta es `/mia`.

import { Controller, HttpCode, Inject, Patch, Req } from '@nestjs/common';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import type { Caller } from '../access/application/caller';
import { ChangeOwnPassword } from './application/change-password';

function callerOf(req: RequestWithContext): Caller {
  const ctx = req.medskin;
  if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
  if (ctx.caller === null) throw new ContractError('token_no_valido');
  return ctx.caller;
}

@Controller('v1/cuentas')
export class AccountsController {
  // `@Inject` explícito: esbuild no emite `emitDecoratorMetadata`.
  constructor(@Inject(ChangeOwnPassword) private readonly changePassword: ChangeOwnPassword) {}

  @Patch('mia/contrasena')
  @HttpCode(200)
  async newPassword(@Req() req: RequestWithContext) {
    return this.changePassword.run(req.body, callerOf(req));
  }
}
