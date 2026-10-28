// El guardia global de alcance. Antes de cualquier módulo y POR LISTA BLANCA DE RUTAS
// (`sesion.md`): una ruta que no está en la tabla se DENIEGA. Denegar por defecto es el
// punto 1 de OWASP y es lo único que hace cumplible la contraseña temporal.
//
// No toca la base. Y es deliberado: `sesion.md` decide que «el token de acceso que ya esté
// emitido muere en 15 min como máximo, y es el motivo de que vivan 15 min y no una hora».
// Comprobar la fila de `session` en cada petición sería un viaje a la base por llamada
// para adelantar como mucho quince minutos una revocación que el contrato ya acotó.

import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

import type { Caller, RecoveryCaller } from '../../modules/access/application/caller';
import { ContractError, FAILURE_PHRASES, ServiceFailure } from '../contract/error-catalog';
import type { AccountRole, Scope } from '../contract/session';
import { readRequest, registeredRoute, type RequestWithContext } from './request-context';
import { policyFor } from './route-policy';
import type { Tokens, VerifiedClaims } from '../security/tokens';

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
      req.medskin = { ...base, policy, caller: null, recovery: null };
      return true;
    }

    const claims = await this.tokens.verify(this.readBearer(req.headers.authorization));
    this.checkScope(policy.scopes ?? [], claims.alcance);

    // Dos formas de token y dos formas de quien llama. El de recuperación no trae rol ni
    // sesión a propósito, así que no se le fabrica un `Caller` con nulos: tiene el suyo.
    if (claims.alcance === 'recuperacion') {
      req.medskin = { ...base, policy, caller: null, recovery: this.recoveryFrom(claims) };
      return true;
    }

    req.medskin = { ...base, policy, caller: this.callerFrom(claims), recovery: null };
    return true;
  }

  private checkScope(allowed: readonly Scope[], scope: Scope): void {
    if (allowed.includes(scope)) return;
    // La sesión restringida tiene su propia respuesta y su propia navegación: la app no
    // muestra nada, va a «Crea tu contraseña».
    if (scope === 'contrasena_temporal') throw new ContractError('contrasena_temporal_pendiente');
    throw new ContractError('token_sin_alcance');
  }

  /**
   * Las tres reclamaciones que el token de recuperación NO puede traer se rechazan en vez
   * de ignorarse: un token de recuperación con `rol` es un token que alguien firmó de otra
   * manera, y atenderlo sería atender una forma que el contrato no admite.
   */
  private recoveryFrom(claims: VerifiedClaims): RecoveryCaller {
    if (claims.rol !== undefined || claims.sid !== undefined || claims.practice !== undefined) {
      throw new ContractError('token_no_valido');
    }
    return { via: 'recuperacion', accountId: claims.sub, region: claims.region };
  }

  private callerFrom(claims: VerifiedClaims): Caller {
    // Un token de sesión SIN `sid` ni `rol` no se puede atender: la fila de sesión y el
    // rol son lo que la autorización de todos los demás endpoints lee.
    if (claims.sid === undefined || claims.rol === undefined) {
      throw new ContractError('token_no_valido');
    }

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
