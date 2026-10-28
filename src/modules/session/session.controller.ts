// Solo HTTP: lee la petición, llama al caso de uso, devuelve la salida. Ni una regla de
// negocio, ni una consulta, ni un `if` de autorización: la autorización la hizo el guardia
// global por lista blanca de rutas y el `caller` sale del token.

import { Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import { Tokens } from '../../shared/security/tokens';
import type { Caller } from '../access/application/caller';
import { ReadSession } from './application/read-session';
import { RefreshSession } from './application/refresh-session';

/**
 * Quién llama. Si el contexto no está, el guardia no corrió, y eso no se atiende: una
 * petición que no pasó por el guardia es una ruta sin política (OWASP A01).
 *
 * `caller` nulo aquí es quien llega con un token de RECUPERACIÓN, que no lleva `sid`
 * porque todavía no hay sesión. No debería llegar —la política de la ruta no admite ese
 * alcance— y si llega no se le inventa una: `GET /v1/sesion` es «cualquiera con sesión».
 */
function callerOf(req: RequestWithContext): Caller {
  const ctx = req.medskin;
  if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
  if (ctx.caller === null) throw new ContractError('token_no_valido');
  return ctx.caller;
}

@Controller('v1/sesion')
export class SessionController {
  // `@Inject` explícito y no inyección por tipo del constructor: esbuild —el que usan
  // `tsx` y vitest— no emite `emitDecoratorMetadata`, así que sin esto el controlador se
  // construye con sus dependencias en `undefined` bajo desarrollo y bien bajo `tsc`.
  constructor(
    @Inject(ReadSession) private readonly readSession: ReadSession,
    @Inject(RefreshSession) private readonly refreshSession: RefreshSession,
    @Inject(Tokens) private readonly tokens: Tokens,
  ) {}

  @Get()
  async mine(@Req() req: RequestWithContext) {
    const caller = callerOf(req);
    // El `exp` del token que llegó, que es lo que `token_caduca_en` promete. Se vuelve a
    // verificar la firma en vez de leer la reclamación a pelo: el guardia ya la verificó
    // —así que esto no decide nada de seguridad— y el `exp` no viaja en `Caller`.
    // Ponerlo ahí sería un campo opcional en un tipo que treinta sitios leen como
    // completo; una verificación Ed25519 son microsegundos contra el viaje a la base que
    // esta misma petición hace de todas formas.
    const { exp } = await this.tokens.verify(bearerOf(req));
    return this.readSession.run(caller, new Date(exp * 1000));
  }

  /**
   * Sin `Authorization` y sin `caller`: la ruta es anónima en la lista blanca porque «quien
   * tenga un refresco vivo» no tiene token que presentar —justo acaba de caducársele—. La
   * autorización ES el refresco, y la hace la base.
   *
   * `200` y no `201`: no crea un recurso nuevo, rota el que había.
   */
  @Post('refresco')
  @HttpCode(200)
  async refresh(@Req() req: RequestWithContext) {
    return this.refreshSession.run(req.body);
  }
}

/** El mismo `Bearer` que ya leyó el guardia. Sin cabecera no se llega hasta aquí. */
function bearerOf(req: RequestWithContext): string {
  const [scheme, value] = (req.headers.authorization ?? '').split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || value === undefined || value.trim() === '') {
    throw new ContractError('token_no_valido');
  }
  return value.trim();
}
