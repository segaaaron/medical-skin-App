// Solo HTTP: lee la petición, llama al caso de uso, devuelve la salida. Los dos endpoints
// van sin `Authorization` y el guardia los marca anónimos, así que aquí no hay `caller`
// que leer ni autorización que comprobar: la hay, y es acertar el código.
//
// Y 202 en el primero, no 200: lo que pasó es que se encoló un correo, no que se hizo algo.

import { Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';

import type { RequestWithContext } from '../../shared/http/request-context';
import { CheckRecoveryCode } from './application/check-code';
import { RequestRecoveryCode } from './application/request-code';

function ipOf(req: RequestWithContext): string {
  const ctx = req.medskin;
  // Una petición sin pasar por el guardia es una ruta sin política (OWASP A01), y no se
  // atiende: sin su IP no hay límite de ritmo que contar.
  if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
  return ctx.ip;
}

@Controller('v1/recuperacion')
export class RecoveryController {
  // `@Inject` explícito y no inyección por tipo: esbuild no emite `emitDecoratorMetadata`,
  // así que sin esto el controlador se construye con los casos de uso en `undefined` bajo
  // `tsx` y funciona bajo `tsc`.
  constructor(
    @Inject(RequestRecoveryCode) private readonly requestCode: RequestRecoveryCode,
    @Inject(CheckRecoveryCode) private readonly checkCode: CheckRecoveryCode,
  ) {}

  @Post()
  @HttpCode(202)
  async ask(@Req() req: RequestWithContext) {
    return this.requestCode.run(req.body, ipOf(req));
  }

  @Post('codigo')
  @HttpCode(200)
  async check(@Req() req: RequestWithContext) {
    return this.checkCode.run(req.body, ipOf(req));
  }
}
