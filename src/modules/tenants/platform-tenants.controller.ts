// Solo HTTP · los TRES endpoints de consola de `inquilinos.md`.
//
// LAS RUTAS SON EXACTAMENTE LAS CLAVES DE `route-policy.ts` —`POST /v1/plataforma/inquilinos`,
// `GET /v1/plataforma/inquilinos/:id`, `POST /v1/plataforma/inquilinos/:id/licencia/decision`—
// porque la clave de esa tabla es la ruta tal y como la registra Fastify: cambiar la forma de
// la ruta aquí es cambiar la clave, y una ruta sin política es un 500 que ninguna prueba de
// unidad ve.
//
// QUIEN LLAMA SALE DE LA PETICIÓN Y DE NINGÚN OTRO SITIO, y es un `PlatformCaller`, no un
// `Caller`: no tiene cuenta, ni sesión, ni inquilino. **Y el permiso NO se vuelve a
// comprobar**: si este controlador corre, el permiso de esta ruta ya estaba en el token
// firmado y lo verificó el guardia. Comprobarlo dos veces son dos autorizaciones que se
// pueden desacordar.

import { Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import type { PlatformCaller } from '../../shared/platform/platform-token';
import { CreateTenant } from './application/create-tenant';
import { DecideLicense } from './application/decide-license';
import { ReadTenant } from './application/read-tenant';
import { readIdempotencyKey } from '../../shared/idempotency/idempotency-key';
import type { PlatformActor } from './domain/platform-ports';

/**
 * Un identificador que no es un uuid no tiene fila en ninguna parte, así que responde lo
 * mismo que uno inventado y no se consulta nada. Y hace falta comprobarlo ANTES: con otra
 * forma, la base muere con «invalid input syntax for type uuid», y eso sería un 500 donde el
 * contrato promete un 404.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('v1/plataforma/inquilinos')
export class PlatformTenantsController {
  // `@Inject` explícito: esbuild no emite `emitDecoratorMetadata`.
  constructor(
    @Inject(CreateTenant) private readonly createTenant: CreateTenant,
    @Inject(ReadTenant) private readonly readTenant: ReadTenant,
    @Inject(DecideLicense) private readonly decideLicense: DecideLicense,
  ) {}

  /**
   * `201` cuando crea y `200` cuando repite: el reintento con la misma clave no creó nada, y
   * decirle `201` a quien ya tenía su consulta sería afirmar un alta que no ocurrió. El
   * cuerpo es el mismo la de la misma petición, contraseña temporal incluida.
   */
  @Post()
  async create(@Req() req: RequestWithContext, @Res() res: FastifyReply): Promise<void> {
    const body: unknown = req.body;
    const served = await this.createTenant.run(body, actorOf(req), keyOf(req, body), traceOf(req));
    // `void` y no `await`: `send()` de Fastify devuelve la propia respuesta, no una promesa.
    void res.status(served.replayed ? 200 : 201).send(served.response);
  }

  // El `id` de la RUTA no autoriza nada: entra como criterio de búsqueda bajo la política de
  // `app_platform` y sin fila la respuesta es `404 inquilino_no_existe`, la misma que daría un
  // identificador inventado.
  @Get(':id')
  @HttpCode(200)
  async file(@Req() req: RequestWithContext, @Param('id') id: string) {
    if (!UUID.test(id)) throw new ContractError('inquilino_no_existe');
    return this.readTenant.run(id, actorOf(req));
  }

  @Post(':id/licencia/decision')
  @HttpCode(200)
  async decide(@Req() req: RequestWithContext, @Param('id') id: string): Promise<unknown> {
    // Sin licencia que decidir: el mismo 404 que una consulta que no existe.
    if (!UUID.test(id)) throw new ContractError('licencia_no_existe');

    const body: unknown = req.body;
    const served = await this.decideLicense.run(body, id, actorOf(req), keyOf(req, body));
    return served.response;
  }
}

/**
 * Quien llama, del token de plataforma. Si el contexto no está, el guardia no corrió, y eso
 * no se atiende: una petición que no pasó por el guardia es una ruta sin política (OWASP A01).
 *
 * `platform` nulo aquí sería un token de sesión de la app en una ruta de consola, que el
 * guardia ya rechaza: si llegara, se deniega igual y no se le fabrica un actor.
 */
function actorOf(req: RequestWithContext): PlatformActor {
  const ctx = req.medskin;
  if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
  const platform: PlatformCaller | null = ctx.platform;
  if (platform === null) throw new ContractError('token_de_plataforma_no_valido');
  return { subject: platform.subject, label: platform.label, region: platform.region };
}

/**
 * La traza de la petición. La necesita UN camino y solo uno: el fallo del correo del alta, que
 * NO se lanza —el inquilino queda creado— y por eso no pasa por el filtro global, que es quien
 * normalmente la pone.
 */
function traceOf(req: RequestWithContext): { traceId: string; requestId: string } {
  const ctx = req.medskin;
  return {
    traceId: ctx?.traceId ?? 'sin-traza',
    requestId: ctx?.requestId ?? 'sin-peticion',
  };
}

/**
 * `(Idempotency-Key, cuenta que llama, cuerpo hasheado)` de `_convenciones.md`. La cuenta la
 * pone el repositorio desde el token; aquí solo se leen la cabecera y la huella del cuerpo.
 */
/**
 * La clave de la petición, con el MISMO lector que los tres de la app: estaba copiado en
 * cuatro controladores y las dos huellas del cuerpo no eran la misma —una ordenaba las claves
 * y la otra no—, así que el mismo cuerpo en otro orden era «otra petición» en un endpoint y
 * la misma en el otro.
 *
 * Y es OBLIGATORIA, como en los otros tres: sin cabecera, `400 clave_idempotencia_faltante`.
 * Antes devolvía `null` y la idempotencia se apagaba en silencio.
 */
function keyOf(req: RequestWithContext, body: unknown) {
  return readIdempotencyKey(req, body);
}
