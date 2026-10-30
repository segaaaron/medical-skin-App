// Solo HTTP: lee la petición, llama al caso de uso, devuelve la salida. Controlador aparte
// del de `/v1/access` porque son dos rutas distintas con dos prefijos distintos, no porque
// hagan cosas distintas: el caso de uso de dentro reusa las mismas cuatro piezas.
//
// No hay `caller` que leer: esta ruta es anónima, como `POST /v1/access` y los dos de
// recuperación. Lo único que necesita del contexto es la IP, para el contador por IP.

import { Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';

import type { RequestWithContext } from '../../shared/http/request-context';
import { PlatformSignIn } from './application/platform-sign-in';

@Controller('v1/platform/access')
export class PlatformAccessController {
  // `@Inject` explícito y no inyección por tipo, igual que en `AccessController`: esbuild no
  // emite `emitDecoratorMetadata`, y sin esto el controlador se construye con el caso de uso
  // en `undefined` bajo `tsx` y funciona bajo `tsc`.
  constructor(@Inject(PlatformSignIn) private readonly signIn: PlatformSignIn) {}

  @Post()
  @HttpCode(200)
  async enter(@Req() req: RequestWithContext) {
    const ctx = req.medskin;
    // Sin contexto no corrió el guardia, y una petición que no pasó por el guardia no se
    // atiende: es una ruta sin política (OWASP A01).
    if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
    return this.signIn.run({ body: req.body, ip: ctx.ip });
  }
}
