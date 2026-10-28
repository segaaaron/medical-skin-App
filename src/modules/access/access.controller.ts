// Solo HTTP: lee la petición, llama al caso de uso, devuelve la salida. Ni una regla de
// negocio, ni una consulta, ni un `if` de autorización: la autorización la hizo el guardia
// y el `caller` sale del token (`caller.ts`).

import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import type { Caller } from './application/caller';
import { ChoosePassword } from './application/choose-password';
import {
  CloseOtherSessions,
  CloseSession,
  ListSessions,
  SignOut,
} from './application/sessions';
import { SignIn } from './application/sign-in';

/**
 * El contexto que puso el guardia. Si no está, el guardia no corrió, y eso no se atiende:
 * una petición sin pasar por el guardia es una ruta sin política (OWASP A01).
 */
function contextOf(req: RequestWithContext): NonNullable<RequestWithContext['medskin']> {
  const ctx = req.medskin;
  if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
  return ctx;
}

function callerOf(req: RequestWithContext): Caller {
  const { caller } = contextOf(req);
  if (caller === null) throw new ContractError('token_no_valido');
  return caller;
}

@Controller('v1/acceso')
export class AccessController {
  // `@Inject` explícito y no inyección por tipo: esbuild no emite `emitDecoratorMetadata`,
  // así que sin esto el controlador se construye con los casos de uso en `undefined` bajo
  // `tsx` y funciona bajo `tsc`. Dos comportamientos distintos del mismo código es peor que
  // seis decoradores.
  constructor(
    @Inject(SignIn) private readonly signIn: SignIn,
    @Inject(ChoosePassword) private readonly choosePassword: ChoosePassword,
    @Inject(SignOut) private readonly signOut: SignOut,
    @Inject(ListSessions) private readonly listSessions: ListSessions,
    @Inject(CloseSession) private readonly closeSession: CloseSession,
    @Inject(CloseOtherSessions) private readonly closeOtherSessions: CloseOtherSessions,
  ) {}

  @Post()
  @HttpCode(200)
  async enter(@Req() req: RequestWithContext) {
    const ctx = contextOf(req);
    return this.signIn.run({ body: req.body, ip: ctx.ip, device: ctx.device });
  }

  // Un flujo, dos entradas, y el `if` está aquí y no en el caso de uso porque la entrada
  // la decide el TOKEN, que es cosa del borde: con sesión restringida se asciende esa
  // sesión; con token de recuperación no hay sesión ni rol que leer y se abre una nueva.
  @Post('contrasena-nueva')
  @HttpCode(200)
  async newPassword(@Req() req: RequestWithContext) {
    const ctx = contextOf(req);
    if (ctx.recovery !== null) {
      return this.choosePassword.runFromRecovery(req.body, ctx.recovery, ctx.device);
    }
    return this.choosePassword.run(req.body, callerOf(req));
  }

  @Delete()
  @HttpCode(200)
  async leave(@Req() req: RequestWithContext) {
    return this.signOut.run(callerOf(req));
  }

  @Get('sesiones')
  async sessions(@Req() req: RequestWithContext) {
    return this.listSessions.run(callerOf(req));
  }

  @Delete('sesiones/:sesion_id')
  @HttpCode(200)
  async closeOne(@Req() req: RequestWithContext, @Param('sesion_id') sessionId: string) {
    return this.closeSession.run(sessionId, callerOf(req));
  }

  @Delete('sesiones')
  @HttpCode(200)
  async closeOthers(@Req() req: RequestWithContext) {
    return this.closeOtherSessions.run(callerOf(req));
  }
}
