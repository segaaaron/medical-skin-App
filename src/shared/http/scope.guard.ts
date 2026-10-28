// El guardia global de alcance. Antes de cualquier módulo y POR LISTA BLANCA DE RUTAS
// (`sesion.md`): una ruta que no está en la tabla se DENIEGA. Denegar por defecto es el
// punto 1 de OWASP y es lo único que hace cumplible la contraseña temporal.
//
// No toca la base. Y es deliberado: `sesion.md` decide que «el token de acceso que ya esté
// emitido muere en 15 min como máximo, y es el motivo de que vivan 15 min y no una hora».
// Comprobar la fila de `session` en cada petición sería un viaje a la base por llamada
// para adelantar como mucho quince minutos una revocación que el contrato ya acotó.

import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

import type { Caller } from '../../modules/access/application/caller';
import { ContractError, FAILURE_PHRASES, ServiceFailure } from '../contract/error-catalog';
import type { AccountRole } from '../contract/session';
import { readRequest, registeredRoute, type RequestWithContext } from './request-context';
import { policyFor } from './route-policy';
import type { Tokens } from '../security/tokens';

@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(private readonly tokens: Tokens) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithContext>();
    const route = registeredRoute(req);
    const policy = policyFor(req.method, route);

    if (policy === null) {
      // Una ruta registrada sin política es un error de programación, y falla cerrada.
      throw new ServiceFailure(
        FAILURE_PHRASES.fallback,
        new Error(`ruta sin política de alcance: ${req.method} ${route ?? '?'}`),
      );
    }

    const base = readRequest(req);

    if (policy.anonymous === true) {
      req.medskin = { ...base, policy, caller: null };
      return true;
    }

    const caller = await this.callerFrom(req.headers.authorization);

    if (!(policy.scopes ?? []).includes(caller.scope)) {
      // La sesión restringida tiene su propia respuesta y su propia navegación: la app no
      // muestra nada, va a «Crea tu contraseña».
      if (caller.scope === 'contrasena_temporal') {
        throw new ContractError('contrasena_temporal_pendiente');
      }
      throw new ContractError('token_sin_alcance');
    }

    req.medskin = { ...base, policy, caller };
    return true;
  }

  private async callerFrom(authorization: string | undefined): Promise<Caller> {
    const claims = await this.tokens.verify(this.readBearer(authorization));

    // `practitioner` no es un valor de `rol` que viaje al cliente, así que el rol de cuenta
    // se deriva del que sí viaja: `paciente` o cualquiera de los tres de la consulta.
    const accountRole: AccountRole = claims.rol === 'paciente' ? 'paciente' : 'practitioner';
    const practiceId = claims.practice ?? null;

    // Un token de doctora o de equipo SIN `practice` no se puede atender: su contexto de
    // base exige el inquilino, y sin él las políticas no leen nada. No se improvisa uno.
    if (accountRole === 'practitioner' && practiceId === null) {
      throw new ContractError('token_no_valido');
    }
    if (accountRole === 'paciente' && practiceId !== null) {
      throw new ContractError('token_no_valido');
    }

    return {
      accountId: claims.sub,
      sessionId: claims.sid,
      role: claims.rol,
      accountRole,
      scope: claims.alcance,
      region: claims.region,
      practiceId,
      permissions: claims.permisos,
    };
  }

  private readBearer(authorization: string | undefined): string {
    if (authorization === undefined) throw new ContractError('token_no_valido');
    const [scheme, value] = authorization.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || value === undefined || value.trim() === '') {
      throw new ContractError('token_no_valido');
    }
    return value.trim();
  }
}
