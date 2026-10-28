// POST /v1/equipo · solo HTTP. La autorización la hizo el guardia por lista blanca de rutas,
// el permiso lo mira el caso de uso y que quien llama sea LA DUEÑA lo comprueba la base.
//
// AQUÍ VIVE LA IDEMPOTENCIA, y vive aquí porque es una cabecera: `Idempotency-Key` es
// transporte, no negocio. `_convenciones.md`: `(Idempotency-Key, cuenta que llama, cuerpo
// hasheado)` durante 24 h, la repetición devuelve la respuesta original y la misma clave con
// otro cuerpo es `409 clave_idempotencia_reutilizada`.
//
// La clave lleva la cuenta que llama, así que una clave de otra consulta no repite nada de
// esta. Y sin cabecera el alta sigue siendo segura ante un reintento: el segundo intento con
// el mismo correo encuentra la cuenta y devuelve `409 correo_no_disponible` en vez de crear
// una segunda.

import { Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import { IdempotencyStore } from '../../shared/idempotency/idempotency-store';
import { UUID, callerOf } from './accounts.controller';
import { CreateTeamMember, type TeamMemberResponse } from './application/create-team-member';
import { ResendTeamAccess } from './application/resend-team-access';

/** Una cabecera es entrada del cliente: se acota antes de convertirla en clave (OWASP A03). */
const KEY_MAX_LENGTH = 120;

@Controller('v1/equipo')
export class TeamController {
  // `@Inject` explícito: esbuild no emite `emitDecoratorMetadata`.
  constructor(
    @Inject(CreateTeamMember) private readonly createMember: CreateTeamMember,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
    @Inject(ResendTeamAccess) private readonly resendAccess: ResendTeamAccess,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Req() req: RequestWithContext): Promise<unknown> {
    const caller = callerOf(req);
    const key = readKey(req);
    const body: unknown = req.body;

    if (key !== null) {
      const replay = await this.idempotency.replay({ key, accountId: caller.accountId, body });
      // La respuesta original, byte a byte. No se vuelve a crear nada y no se manda un
      // segundo correo: el alta ya ocurrió y el acceso ya salió.
      if (replay !== null) return replay.response;
    }

    const response: TeamMemberResponse = await this.createMember.run(body, caller);

    // Solo se recuerda lo que salió bien: un `409` o un `500` no son una respuesta que
    // repetir, y el reintento tiene que poder volver a intentarlo de verdad.
    if (key !== null) {
      await this.idempotency.remember({
        key,
        accountId: caller.accountId,
        body,
        status: 201,
        response,
      });
    }
    return response;
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
  @Post(':miembro_id/acceso')
  @HttpCode(202)
  async resend(
    @Req() req: RequestWithContext,
    @Param('miembro_id') memberId: string,
  ): Promise<unknown> {
    if (!UUID.test(memberId)) throw new ContractError('miembro_no_existe');
    return this.resendAccess.run(memberId, callerOf(req));
  }
}

function readKey(req: RequestWithContext): string | null {
  const header = req.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return null;
  const key = value.trim().slice(0, KEY_MAX_LENGTH);
  return key === '' ? null : key;
}
