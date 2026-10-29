// POST /v1/team · solo HTTP. La autorización la hizo el guardia por lista blanca de rutas,
// el permiso lo mira el caso de uso y que quien llama sea LA DUEÑA lo comprueba la base.
//
// LA CLAVE SE LEE AQUÍ —es una cabecera: transporte, no negocio— y se comprueba y se reserva
// DENTRO de la transacción que crea, en `idempotency_key`. Antes vivía en Redis y se escribía
// después del `COMMIT`: un parpadeo entre las dos dejaba un alta que ningún reintento podía
// recuperar, porque el segundo intento recibe `409 correo_no_disponible`.
//
// La cabecera es OBLIGATORIA (`_convenciones.md` · «todo `POST` que crea algo»): sin ella,
// `400 clave_idempotencia_faltante` y no se ejecuta nada. Antes se apagaba en silencio.

import { Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import { readIdempotencyKey } from '../../shared/idempotency/idempotency-key';
import { UUID, callerOf } from './accounts.controller';
import { CreateTeamMember } from './application/create-team-member';
import { ResendTeamAccess } from './application/resend-team-access';

@Controller('v1/team')
export class TeamController {
  // `@Inject` explícito: esbuild no emite `emitDecoratorMetadata`.
  constructor(
    @Inject(CreateTeamMember) private readonly createMember: CreateTeamMember,
    @Inject(ResendTeamAccess) private readonly resendAccess: ResendTeamAccess,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Req() req: RequestWithContext): Promise<unknown> {
    const body: unknown = req.body;
    return this.createMember.run(body, callerOf(req), readIdempotencyKey(req, body));
  }

  /**
   * SIN `Idempotency-Key`, y no es un olvido: «cada llamada acuña una contraseña nueva y
   * mata la anterior», así que dos llamadas son dos temporales y la que vale es la última.
   * Repetir la respuesta de la primera diría que vale una contraseña ya muerta. Es la misma
   * decisión que en el reenvío de pacientes.
   *
   * El `miembro_id` de la URL NO autoriza: entra como criterio de búsqueda dentro del
   * inquilino del token, y si no hay fila en esta consulta el 404 es el mismo que el de un
   * identificador inventado.
   */
  @Post(':member_id/access')
  @HttpCode(202)
  async resend(
    @Req() req: RequestWithContext,
    @Param('member_id') memberId: string,
  ): Promise<unknown> {
    if (!UUID.test(memberId)) throw new ContractError('miembro_no_existe');
    return this.resendAccess.run(memberId, callerOf(req));
  }
}

