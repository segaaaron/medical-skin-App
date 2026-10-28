// POST /v1/acceso/contrasena-nueva · la contraseña nueva obligatoria. Un flujo, dos
// entradas: la primera vez y el olvido. El MISMO endpoint, porque si fueran dos, un día
// divergirían las reglas de la contraseña.
//
// Devuelve un token de alcance COMPLETO y el refresco que la sesión restringida no tenía:
// es lo que convierte «Guardar y entrar» en entrar de verdad. Que la paciente tuviera que
// volver a escribir la contraseña que acaba de inventar sería absurdo.
//
// Las dos entradas se parecen en la regla de la contraseña y no en nada más:
//
//   · por TEMPORAL quien llama tiene sesión restringida, rol e inquilino, y la sesión se
//     ASCIENDE en la misma transacción que guarda la contraseña;
//   · por RECUPERACIÓN no hay sesión, no hay rol y no hay inquilino, porque el token de
//     recuperación no los lleva (`recuperacion.md`: «el token no lleva rol»). El rol y el
//     inquilino los devuelve la base al guardar, y la sesión se ABRE después, que es el
//     mismo acto que una entrada por `POST /v1/acceso`.

import { z } from 'zod';

import {
  ContractError,
  FAILURE_PHRASES,
  ServiceFailure,
} from '../../../shared/contract/error-catalog';
import type { NextStep } from '../../../shared/contract/session';
import { resolveNextStep } from '../domain/next-step';
import { checkNewPassword } from '../domain/password-rules';
import type {
  ClockPort,
  CredentialPort,
  Device,
  PasswordHasher,
  SessionPort,
  TokenPort,
} from '../domain/ports';
import { resolvePermissions, resolveRole } from '../domain/role';
import { REFRESH_LIFETIME_MS } from './sign-in';
import type { Caller, RecoveryCaller } from './caller';

const bodySchema = z.object({ nueva: z.unknown() });

export type ChoosePasswordResponse = {
  token: string;
  token_caduca_en: string;
  refresco: string;
  refresco_caduca_en: string;
  siguiente_paso: NextStep;
  sesion_id: string;
};

export class ChoosePassword {
  constructor(
    private readonly credentials: CredentialPort,
    private readonly passwords: PasswordHasher,
    private readonly sessions: SessionPort,
    private readonly tokens: TokenPort,
    private readonly clock: ClockPort,
  ) {}

  /** La entrada por la contraseña temporal: hay sesión restringida, rol e inquilino. */
  async run(input: unknown, caller: Caller): Promise<ChoosePasswordResponse> {
    const candidate = checkNewPassword(this.readBody(input));

    // «Esa es la temporal que te mandamos. Elige una tuya.» Se compara contra el hash que
    // `credential` no deja leer a ningún rol de aplicación: la comparación es Argon2id en
    // Node contra lo que devuelve `medskin_current_credential()`.
    const current = await this.credentials.readMine(caller.accountId, caller.practiceId);
    if (current !== null && current.isTemporary) {
      if (await this.passwords.verify(current.hash, candidate)) {
        throw new ContractError('contrasena_igual_a_la_temporal');
      }
    }

    const now = this.clock.now();
    const refresh = this.tokens.mintRefresh();
    const refreshExpiresAt = new Date(now.getTime() + lifetimeFor(caller.role));

    const hash = await this.passwords.hash(candidate);
    const saved = await this.credentials.saveFinalPassword({
      accountId: caller.accountId,
      practiceId: caller.practiceId,
      accountRole: caller.accountRole,
      hash,
      via: 'temporal',
      currentSessionId: caller.sessionId,
      refreshDigest: refresh.digest,
      refreshExpiresAt,
    });

    // `already_chosen` es la temporal que ya dejó de serlo; `no_code`, el código de
    // recuperación que ya se gastó. Para quien lo lee son el mismo hecho: ya eligió.
    if (saved.verdict !== 'saved') throw new ContractError('contrasena_ya_elegida');

    const facts = await this.sessions.nextStepFacts({
      accountId: caller.accountId,
      practiceId: caller.practiceId,
      accountRole: caller.accountRole,
    });

    const { token, expiresAt } = await this.tokens.sign({
      sub: caller.accountId,
      sid: caller.sessionId,
      rol: caller.role,
      alcance: 'completo',
      region: caller.region,
      ...(caller.practiceId ? { practice: caller.practiceId } : {}),
      permisos: resolvePermissions(caller.role, saved.permissions ?? facts.permissions),
    });

    return {
      token,
      token_caduca_en: expiresAt.toISOString(),
      refresco: refresh.refresh,
      refresco_caduca_en: refreshExpiresAt.toISOString(),
      siguiente_paso: resolveNextStep(caller.role, {
        passwordIsTemporary: false,
        licenseStatus: facts.licenseStatus,
        firstDayDone: facts.firstDayDone,
      }),
      sesion_id: caller.sessionId,
    };
  }

  /**
   * La entrada por recuperación. Lo que cambia no es la regla de la contraseña: es que no
   * hay sesión que ascender ni rol que leer del token, así que se guarda primero —y ahí la
   * base dice qué es la cuenta— y se abre la sesión después.
   *
   * No comprueba `contrasena_igual_a_la_temporal`, y no por omisión: por aquí no se llega
   * con una temporal. `acceso.md` lo dice en la propia petición: «sin `actual`: la actual
   * es la temporal, que ya se gastó para llegar aquí, o NO EXISTE porque se llegó por
   * recuperación».
   */
  async runFromRecovery(
    input: unknown,
    who: RecoveryCaller,
    device: Device,
  ): Promise<ChoosePasswordResponse> {
    const candidate = checkNewPassword(this.readBody(input));
    const hash = await this.passwords.hash(candidate);

    const saved = await this.credentials.saveFinalPassword({
      accountId: who.accountId,
      practiceId: null,
      accountRole: null,
      hash,
      via: 'recuperacion',
      currentSessionId: null,
      refreshDigest: null,
      refreshExpiresAt: null,
    });
    if (saved.verdict !== 'saved' || saved.accountRole === null) {
      throw new ContractError('contrasena_ya_elegida');
    }

    const now = this.clock.now();
    const refresh = this.tokens.mintRefresh();
    const refreshExpiresAt = new Date(
      now.getTime() +
        (saved.accountRole === 'paciente'
          ? REFRESH_LIFETIME_MS.patient
          : REFRESH_LIFETIME_MS.practitioner),
    );

    const opened = await this.sessions.open({
      accountId: who.accountId,
      accountRole: saved.accountRole,
      practiceId: saved.practiceId,
      scope: 'completo',
      refreshDigest: refresh.digest,
      refreshExpiresAt,
      device,
      region: who.region,
      actorLabel: null,
    });

    const role = resolveRole(saved.accountRole, opened.practitionerRole);
    if (role === null) {
      // Una cuenta `practitioner` sin fila de consulta activa no tiene `rol` que devolver,
      // y no se inventa uno: va a `service_failure` con su causa real.
      throw new ServiceFailure(
        FAILURE_PHRASES.savePassword,
        new Error(`cuenta ${who.accountId} sin rol de consulta que devolver tras recuperar`),
      );
    }

    const { token, expiresAt } = await this.tokens.sign({
      sub: who.accountId,
      sid: opened.sessionId,
      rol: role,
      alcance: 'completo',
      region: who.region,
      ...(saved.practiceId ? { practice: saved.practiceId } : {}),
      permisos: resolvePermissions(role, saved.permissions ?? opened.permissions),
    });

    return {
      token,
      token_caduca_en: expiresAt.toISOString(),
      refresco: refresh.refresh,
      refresco_caduca_en: refreshExpiresAt.toISOString(),
      siguiente_paso: resolveNextStep(role, {
        passwordIsTemporary: false,
        licenseStatus: opened.licenseStatus,
        firstDayDone: opened.firstDayDone,
      }),
      sesion_id: opened.sessionId,
    };
  }

  private readBody(input: unknown): unknown {
    const parsed = bodySchema.safeParse(input ?? {});
    return parsed.success ? parsed.data.nueva : undefined;
  }
}

/** `sesion.md`: paciente 30 días · doctora y equipo 12 h. */
function lifetimeFor(role: string): number {
  return role === 'paciente' ? REFRESH_LIFETIME_MS.patient : REFRESH_LIFETIME_MS.practitioner;
}
