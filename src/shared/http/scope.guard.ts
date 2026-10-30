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
import {
  ContractError,
  FAILURE_PHRASES,
  ServiceFailure,
  type ErrorCode,
} from '../contract/error-catalog';
import type { AccountRole, Scope } from '../contract/session';
import {
  PLATFORM_FORBIDDEN_MESSAGE,
  type PlatformCaller,
  type PlatformTokens,
} from '../platform/platform-token';
import { readRequest, registeredRoute, type RequestWithContext } from './request-context';
import { policyFor, type RoutePolicy } from './route-policy';
import type { Tokens, VerifiedClaims } from '../security/tokens';

/**
 * El relleno para la ruta registrada SIN política, que es un error de programación y falla
 * cerrada en la línea siguiente. Existe solo para que el contexto —y con él el identificador
 * de la petición— esté puesto cuando el filtro conteste ese 500.
 */
const NO_POLICY: RoutePolicy = { failurePhrase: FAILURE_PHRASES.fallback };

@Injectable()
export class ScopeGuard implements CanActivate {
  /**
   * Dos verificadores porque hay DOS llaves: la de las sesiones de la app, que este servicio
   * firma, y la pública del servicio de plataforma, que solo verifica. Ninguna de las dos
   * sirve para lo de la otra, y eso es lo que separa la consola de la app.
   */
  constructor(
    private readonly tokens: Tokens,
    private readonly platformTokens: PlatformTokens,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithContext>();
    const route = registeredRoute(req);
    const policy = policyFor(req.method, route);

    // EL CONTEXTO SE CUELGA LO PRIMERO, aunque esta petición vaya a ser rechazada tres
    // líneas más abajo. Antes se colgaba solo en los caminos que pasaban, así que un
    // `401 token_no_valido` salía con `peticion_id: "sin-peticion"` — es decir, el
    // identificador para buscar en la bitácora faltaba justo en las respuestas que alguien
    // querría buscar. Lo que sigue solo lo ENRIQUECE con quién llama.
    const base = readRequest(req);
    req.medskin = { ...base, policy: policy ?? NO_POLICY, caller: null, recovery: null, platform: null };

    if (policy === null) {
      // Una ruta registrada sin política es un error de programación, y falla cerrada.
      throw new ServiceFailure(
        FAILURE_PHRASES.fallback,
        new Error(`ruta sin política de alcance: ${req.method} ${route ?? '?'}`),
      );
    }

    if (policy.anonymous === true) {
      req.medskin = { ...base, policy, caller: null, recovery: null, platform: null };
      return true;
    }

    // LA CONSOLA, antes que nada: su token es de otra llave y de otro servicio, así que no
    // pasa por `this.tokens` ni por la comprobación de alcance. Un token de sesión en una
    // ruta de plataforma no verifica —otra llave— y sale `401 token_de_plataforma_no_valido`;
    // un token de plataforma en una ruta de la app, al revés, `401 token_no_valido`.
    if (policy.platformPermission !== undefined) {
      req.medskin = {
        ...base,
        policy,
        caller: null,
        recovery: null,
        platform: await this.platformFrom(req, policy.platformPermission),
      };
      return true;
    }

    const claims = await this.tokens.verify(
      this.readBearer(req.headers.authorization, 'token_no_valido'),
    );
    this.checkScope(policy.scopes ?? [], claims.alcance);

    // Dos formas de token y dos formas de quien llama. El de recuperación no trae rol ni
    // sesión a propósito, así que no se le fabrica un `Caller` con nulos: tiene el suyo.
    if (claims.alcance === 'recuperacion') {
      req.medskin = {
        ...base,
        policy,
        caller: null,
        recovery: this.recoveryFrom(claims),
        platform: null,
      };
      return true;
    }

    req.medskin = {
      ...base,
      policy,
      caller: this.callerFrom(claims),
      recovery: null,
      platform: null,
    };
    return true;
  }

  /**
   * El permiso se comprueba contra el que la RUTA pide, y el que la ruta pide está en la
   * tabla: ninguno viene del cliente. Los del token tampoco son del cliente —vienen firmados
   * y validados contra la lista cerrada del contrato—, así que esto es lo último que queda:
   * que el que trae sea el que hace falta. Si no, `403 sin_permiso` con la frase de la
   * consola, que es otra que la de la doctora.
   */
  private async platformFrom(
    req: RequestWithContext,
    required: NonNullable<RoutePolicy['platformPermission']>,
  ): Promise<PlatformCaller> {
    const caller = await this.platformTokens.verify(
      this.readBearer(req.headers.authorization, 'token_de_plataforma_no_valido'),
    );
    if (!caller.permissions.includes(required)) {
      throw new ContractError('sin_permiso', undefined, PLATFORM_FORBIDDEN_MESSAGE);
    }
    return caller;
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
    const accountRole: AccountRole = claims.rol === 'patient' ? 'patient' : 'doctor';
    const practiceId = claims.practice ?? null;

    // Un token de doctora o de equipo SIN `practice` no se puede atender: su contexto de
    // base exige la consulta, y sin él las políticas no leen nada. No se improvisa uno.
    if (accountRole === 'doctor' && practiceId === null) {
      throw new ContractError('token_no_valido');
    }
    if (accountRole === 'patient' && practiceId !== null) {
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

  /**
   * El código va como parámetro porque la cabecera que falta significa lo mismo y se llama
   * distinto según la puerta: `token_no_valido` en la app, `token_de_plataforma_no_valido` en
   * la consola. Las dos frases están escritas en contratos distintos.
   */
  private readBearer(authorization: string | undefined, missing: ErrorCode): string {
    if (authorization === undefined) throw new ContractError(missing);
    const [scheme, value] = authorization.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || value === undefined || value.trim() === '') {
      throw new ContractError(missing);
    }
    return value.trim();
  }
}
