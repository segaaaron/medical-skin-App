// POST /v1/sesion/refresco · «Token nuevo sin volver a escribir la contraseña».
//
// No lleva `Authorization` y no es idempotente: cada llamada rota el refresco. CUATRO cosas
// que NO se escriben aquí porque ya están escritas en la base (migraciones 0018 y 0020), y
// repetirlas en TypeScript sería tener la misma regla en dos sitios:
//
//   · la rotación de un solo uso;
//   · la detección de REUSO, que revoca la fila —«la familia ES la fila», porque cada
//     entrada crea una `session` y la rotación la actualiza en su sitio—;
//   · la ventana de gracia de 20 s, que **no** guarda el par en caché: si el refresco que
//     llega es el inmediatamente anterior y la rotación fue hace menos de 20 s, se rota
//     otra vez y sale un par nuevo. Guardar el par significaría el refresco EN CLARO en
//     Redis, una credencial viva fuera de la base;
//   · la CADUCIDAD del refresco nuevo, que depende del rol —paciente 30 días, doctora y
//     equipo 12 h— y por eso la elige quien conoce el rol antes de escribir. Desde aquí
//     viajan las dos vidas en segundos; la que vuelve es la buena, y no se recalcula.
//
// Lo que sí es de aquí: validar el cuerpo, traducir el veredicto al error del contrato,
// acuñar el token con las reclamaciones que manda `sesion.md` y resolver `siguiente_paso`
// con la MISMA función que `POST /v1/acceso`.

import { z } from 'zod';

import {
  ContractError,
  FAILURE_PHRASES,
  ServiceFailure,
  type ErrorCode,
} from '../../../shared/contract/error-catalog';
import type { NextStep, Region, Role, Scope } from '../../../shared/contract/session';
import { REFRESH_LIFETIME_MS } from '../../access/application/sign-in';
import { resolveNextStep } from '../../access/domain/next-step';
import { resolvePermissions } from '../../access/domain/role';
import type {
  RefreshLimitsPort,
  RefreshPort,
  RefreshTokenPort,
  RefreshVerdict,
  RotatedRefresh,
} from '../domain/ports';

const bodySchema = z.object({ refresco: z.string().optional() });

/** Los cuatro veredictos que no son una rotación, y su 401. Uno a uno, sin `default`. */
const ERROR_BY_VERDICT: Readonly<Record<Exclude<RefreshVerdict, 'rotated'>, ErrorCode>> = {
  reused: 'refresco_reutilizado',
  revoked: 'sesion_revocada',
  expired: 'refresco_caducado',
  invalid: 'refresco_no_valido',
};

export type RefreshResponse = {
  token: string;
  token_caduca_en: string;
  refresco: string;
  /** Siempre presente, con nulo cuando no hay refresco (`sesion.md`, 28 de octubre). */
  refresco_caduca_en: string | null;
  siguiente_paso: NextStep;
};

export class RefreshSession {
  constructor(
    private readonly sessions: RefreshPort,
    private readonly limits: RefreshLimitsPort,
    private readonly tokens: RefreshTokenPort,
    /**
     * La región del DESPLIEGUE, no la de la fila. Un despliegue sirve una sola región
     * (§7.4) y por eso el único correo de la región es el único de la base: la `region` de
     * la cuenta y la del proceso son la misma por construcción. El filtro de errores ya
     * resuelve así la suya, y la función del refresco no la devuelve.
     */
    private readonly region: Region,
  ) {}

  async run(body: unknown): Promise<RefreshResponse> {
    const refresh = this.readBody(body);
    const minted = this.tokens.mintRefresh();

    const rotated = await this.sessions.rotate({
      digest: this.tokens.digestRefresh(refresh),
      newDigest: minted.digest,
      // Las dos vidas del contrato, en segundos y en su orden. Las elige la función con el
      // rol delante, que es lo único que sabe cuál toca: `sesion.md` da 30 días a la
      // paciente y 12 h a la doctora y al equipo.
      patientSeconds: REFRESH_LIFETIME_MS.patient / 1000,
      practitionerSeconds: REFRESH_LIFETIME_MS.practitioner / 1000,
      // Dentro de la transacción: si el límite se pasó, el `ROLLBACK` devuelve el refresco
      // que llegó a su sitio y el `429` no le cuesta la sesión a nadie.
      withinTransaction: (verdict) =>
        verdict.verdict === 'rotated' && verdict.sessionId !== null
          ? this.limits.countRefresh(verdict.sessionId, verdict.graced)
          : Promise.resolve(),
    });

    if (rotated.verdict !== 'rotated') {
      throw new ContractError(ERROR_BY_VERDICT[rotated.verdict]);
    }

    const session = this.checked(rotated);

    // El refresco YA se rotó cuando se descubre la suspensión, y se deja así: lo que la
    // rotación hizo fue matar la credencial de una cuenta suspendida, que es el lado
    // seguro. No se le devuelve el par nuevo.
    if (session.accountStatus !== 'activa') throw new ContractError('cuenta_suspendida');

    const role = this.roleOf(session);

    const { token, expiresAt } = await this.tokens.sign({
      sub: session.accountId,
      sid: session.sessionId,
      rol: role,
      alcance: session.scope,
      region: this.region,
      ...(session.practiceId ? { practice: session.practiceId } : {}),
      permisos: resolvePermissions(role, session.permissions ?? null),
    });

    return {
      token,
      token_caduca_en: expiresAt.toISOString(),
      refresco: minted.refresh,
      // La que calculó la función con el rol en la mano: aquí no se recalcula ninguna
      // caducidad, porque tenerla en dos sitios es tenerla mal en uno de los dos.
      refresco_caduca_en: session.refreshExpiresAt?.toISOString() ?? null,
      // El mismo campo y la misma función que en el acceso y en `GET /v1/sesion`: los tres
      // hechos que decide vienen de la base ya resueltos (0018), y la regla sigue siendo
      // una sola. Si se escribiera otra vez aquí, se desincronizaría en la primera adición.
      siguiente_paso: resolveNextStep(role, {
        passwordIsTemporary: session.passwordIsTemporary,
        licenseStatus: session.licenseStatus,
        firstDayDone: session.firstDayDone,
      }),
    };
  }

  /** `400 refresco_vacio` · «Falta el campo». Un cuerpo que no es objeto cae en lo mismo. */
  private readBody(input: unknown): string {
    const parsed = bodySchema.safeParse(input ?? {});
    const refresh = (parsed.success ? parsed.data.refresco : undefined) ?? '';
    if (refresh.trim() === '') throw new ContractError('refresco_vacio');
    // No se comprueba la forma: una cadena que no es un refresco no coincide con ningún
    // resumen y cae en `401 refresco_no_valido`, que es su respuesta. Comprobar el prefijo
    // aquí sería decirle a quien prueba cadenas cuál tiene la forma buena.
    return refresh.trim();
  }

  /**
   * Un `rotated` al que le falte la sesión, la cuenta o el alcance es una inconsistencia
   * del servidor y no una sesión inválida: 500 con su frase y la causa real. No se
   * completa con nulos, porque cada uno de esos tres va dentro del token.
   */
  private checked(
    rotated: RotatedRefresh,
  ): RotatedRefresh & { sessionId: string; accountId: string; scope: Scope } {
    const { sessionId, accountId, scope } = rotated;
    if (sessionId === null || accountId === null || scope === null) {
      throw new ServiceFailure(
        FAILURE_PHRASES.refreshSession,
        new Error('medskin_session_refresh rotó sin devolver sesión, cuenta o alcance'),
      );
    }
    return { ...rotated, sessionId, accountId, scope };
  }

  /**
   * El `rol` que viaja al cliente: `paciente` cuando la cuenta es de paciente, y el
   * `practitioner.role` de esa consulta en cualquier otro caso. `practitioner` NUNCA sale
   * al cliente: es valor de base y no dice nada que una app pueda usar.
   */
  private roleOf(session: RotatedRefresh & { accountId: string }): Role {
    if (session.accountRole === 'paciente') return 'paciente';
    if (session.practitionerRole !== null) return session.practitionerRole;
    // Una cuenta de consulta sin fila activa no tiene rol que devolver, y no se inventa
    // uno: es la misma inconsistencia que para en `POST /v1/acceso`.
    throw new ServiceFailure(
      FAILURE_PHRASES.refreshSession,
      new Error(`cuenta ${session.accountId} sin rol de consulta que devolver`),
    );
  }
}
