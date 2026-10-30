// Solo HTTP: valida la entrada, llama al caso de uso, mapea la salida. La autorización la
// hizo el guardia global por lista blanca de rutas y quién llama sale del token: ni un
// `practice_id` de la URL, porque la ruta es `/mio`.
//
// Los tres de `/v1/platform/tenants…` de este mismo contrato NO están aquí: necesitan
// la verificación del token de plataforma y son de otro encargo.
//
// LA CLAVE SE LEE AQUÍ —es una cabecera: transporte, no negocio— y se comprueba y se guarda
// DENTRO de la transacción del envío, en `idempotency_key`. «Un reenvío con la misma clave no
// abre un segundo caso», y ahora eso es verdad incluso si algo se cae entre las dos
// escrituras: antes la fila iba a Redis DESPUÉS del `COMMIT`, así que un parpadeo devolvía un
// 500 que decía «la licencia sigue en revisión: puedes volver a intentarlo» y el reintento
// recibía `409 licencia_en_revision`.
//
// Y la cabecera es OBLIGATORIA: sin ella, `400 clave_idempotencia_faltante` y no se ejecuta
// nada. Antes el mecanismo entero se apagaba en silencio.

import { Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import { readIdempotencyKey } from '../../shared/idempotency/idempotency-key';
import type { Caller } from '../access/application/caller';
import { ReadOwnPractice } from './application/read-own-practice';
import { SubmitLicense } from './application/submit-license';

@Controller('v1/tenants')
export class TenantsController {
  // `@Inject` explícito y no inyección por el tipo del constructor: esbuild —el que usan
  // `tsx` y vitest— no emite `emitDecoratorMetadata`, así que sin esto el controlador se
  // construye con sus dependencias en `undefined` bajo desarrollo y bien bajo `tsc`.
  constructor(
    @Inject(ReadOwnPractice) private readonly readPractice: ReadOwnPractice,
    @Inject(SubmitLicense) private readonly submitLicense: SubmitLicense,
  ) {}

  @Get('mine')
  @HttpCode(200)
  async mine(@Req() req: RequestWithContext) {
    return this.readPractice.run(callerOf(req));
  }

  @Post('mine/license')
  @HttpCode(202)
  async license(@Req() req: RequestWithContext): Promise<unknown> {
    const body: unknown = req.body;
    return this.submitLicense.run(body, callerOf(req), readIdempotencyKey(req, body));
  }
}

/**
 * Quién llama. Si el contexto no está, el guardia no corrió, y eso no se atiende: una
 * petición que no pasó por el guardia es una ruta sin política (OWASP A01).
 *
 * `caller` nulo es quien llega con un token de recuperación o de plataforma: ninguno de los
 * dos tiene sesión de la que sacar consulta, y no se les fabrica una.
 */
function callerOf(req: RequestWithContext): Caller {
  const ctx = req.medskin;
  if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
  if (ctx.caller === null) throw new ContractError('token_no_valido');
  return ctx.caller;
}

