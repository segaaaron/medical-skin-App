// Solo HTTP · las dos acciones de consola de `cuentas.md` y la búsqueda que las hace
// alcanzables.
//
// LA BÚSQUEDA SE DECLARA ANTES QUE LAS RUTAS CON `:account_id`: Fastify casa por especificidad
// y una ruta estática gana a un parámetro, pero el orden del archivo es lo que se lee para
// entender cuál es cuál. `GET /v1/platform/accounts` sin nada detrás es la búsqueda.
//
// POR QUÉ EXISTE: las dos acciones piden un `account_id` y **soporte nunca tiene un uuid** —
// tiene el correo con el que alguien escribió. Sin la búsqueda las dos estaban implementadas y
// eran inalcanzables.
//
// LAS RUTAS SON EXACTAMENTE LAS CLAVES DE `route-policy.ts`
// —`POST /v1/platform/accounts/:account_id/access/resend` y
// `DELETE /v1/platform/accounts/:account_id/lock`— porque la clave de esa tabla es la ruta
// tal y como la registra Fastify: cambiar la forma aquí es cambiar la clave, y una ruta sin
// política es un 500 que ninguna prueba de unidad ve.
//
// QUIEN LLAMA SALE DE LA PETICIÓN Y DE NINGÚN OTRO SITIO, y es un `PlatformCaller`: no tiene
// cuenta, ni sesión, ni consulta. **El permiso NO se vuelve a comprobar**: si este
// controlador corre, el permiso de esta ruta ya estaba en el token firmado y lo verificó el
// guardia. Comprobarlo dos veces son dos autorizaciones que se pueden desacordar.
//
// NINGUNA DE LAS DOS LLEVA `Idempotency-Key`: el reenvío porque cada llamada acuña una
// contraseña nueva y mata la anterior —repetir la primera respuesta diría que vale una
// contraseña muerta—, y la pausa porque es idempotente por naturaleza.

import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import type { PlatformCaller } from '../../shared/platform/platform-token';
import { LiftAccessPause } from './application/lift-access-pause';
import { ResendPlatformAccess } from './application/resend-platform-access';
import { SearchAccounts } from './application/search-accounts';
import { readAccountLookup } from './domain/account-lookup';
import type { ConsoleActor } from './domain/ports';
import { UUID } from './accounts.controller';

@Controller('v1/platform/accounts')
export class PlatformAccountsController {
  // `@Inject` explícito: esbuild no emite `emitDecoratorMetadata`.
  constructor(
    @Inject(ResendPlatformAccess) private readonly resend: ResendPlatformAccess,
    @Inject(LiftAccessPause) private readonly liftPause: LiftAccessPause,
    @Inject(SearchAccounts) private readonly searchAccounts: SearchAccounts,
  ) {}

  @Get()
  @HttpCode(200)
  async search(@Req() req: RequestWithContext) {
    const query = (req as { query?: unknown }).query;
    const params = typeof query === 'object' && query !== null ? (query as Record<string, unknown>) : {};
    return this.searchAccounts.run(readAccountLookup(params), actorOf(req));
  }

  /**
   * El `cuenta_id` de la ruta NO autoriza: entra como criterio de búsqueda y, si no hay fila,
   * el 404 es el mismo que el de una cuenta inventada, una borrada o una de otra región.
   */
  @Post(':account_id/access/resend')
  @HttpCode(200)
  async resendAccess(@Req() req: RequestWithContext, @Param('account_id') accountId: string) {
    if (!UUID.test(accountId)) throw new ContractError('cuenta_no_existe');
    return this.resend.run(accountId, actorOf(req));
  }

  @Delete(':account_id/lock')
  @HttpCode(200)
  async lift(@Req() req: RequestWithContext, @Param('account_id') accountId: string) {
    if (!UUID.test(accountId)) throw new ContractError('cuenta_no_existe');
    return this.liftPause.run(accountId, actorOf(req));
  }
}

/**
 * Quién ejecuta. Si el contexto no está, el guardia no corrió, y eso no se atiende: una
 * petición que no pasó por el guardia es una ruta sin política (OWASP A01).
 *
 * `platform` nulo es quien llega con una sesión de la app o con un token de recuperación:
 * ninguno de los dos es la consola, y no se les fabrica un actor.
 */
function actorOf(req: RequestWithContext): ConsoleActor {
  const ctx = req.medskin;
  if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
  const platform: PlatformCaller | null = ctx.platform;
  if (platform === null) throw new ContractError('token_de_plataforma_no_valido');
  return { subject: platform.subject, label: platform.label, region: platform.region };
}
