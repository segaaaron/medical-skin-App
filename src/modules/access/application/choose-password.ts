// POST /v1/acceso/contrasena-nueva · la contraseña nueva obligatoria. Un flujo, dos
// entradas: la primera vez y el olvido. El MISMO endpoint, porque si fueran dos, un día
// divergirían las reglas de la contraseña.
//
// Devuelve un token de alcance COMPLETO y el refresco que la sesión restringida no tenía:
// es lo que convierte «Guardar y entrar» en entrar de verdad. Que la paciente tuviera que
// volver a escribir la contraseña que acaba de inventar sería absurdo.

import { z } from 'zod';

import { ContractError } from '../../../shared/contract/error-catalog';
import type { NextStep } from '../../../shared/contract/session';
import { resolveNextStep } from '../domain/next-step';
import { checkNewPassword } from '../domain/password-rules';
import type {
  ClockPort,
  CredentialPort,
  PasswordHasher,
  SessionPort,
  TokenPort,
} from '../domain/ports';
import { resolvePermissions } from '../domain/role';
import { REFRESH_LIFETIME_MS } from './sign-in';
import type { Caller } from './caller';

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

  async run(input: unknown, caller: Caller): Promise<ChoosePasswordResponse> {
    const parsed = bodySchema.safeParse(input ?? {});
    const candidate = checkNewPassword(parsed.success ? parsed.data.nueva : undefined);

    const via = caller.scope === 'recuperacion' ? 'recuperacion' : 'temporal';

    // «Esa es la temporal que te mandamos. Elige una tuya.» Se compara contra el hash que
    // `credential` no deja leer a ningún rol de aplicación: la comparación es Argon2id en
    // Node contra lo que devuelve `medskin_current_credential()`.
    if (via === 'temporal') {
      const current = await this.credentials.readMine(caller.accountId, caller.practiceId);
      if (current !== null && current.isTemporary) {
        if (await this.passwords.verify(current.hash, candidate)) {
          throw new ContractError('contrasena_igual_a_la_temporal');
        }
      }
    }

    const now = this.clock.now();
    const refresh = this.tokens.mintRefresh();
    const lifetime =
      caller.role === 'paciente' ? REFRESH_LIFETIME_MS.patient : REFRESH_LIFETIME_MS.practitioner;
    const refreshExpiresAt = new Date(now.getTime() + lifetime);

    const hash = await this.passwords.hash(candidate);
    const saved = await this.credentials.saveFinalPassword({
      accountId: caller.accountId,
      practiceId: caller.practiceId,
      accountRole: caller.accountRole,
      hash,
      via,
      currentSessionId: caller.sessionId,
      refreshDigest: refresh.digest,
      refreshExpiresAt,
    });

    // `already_chosen` es la temporal que ya dejó de serlo; `no_code`, el código de
    // recuperación que ya se gastó. Para quien lo lee son el mismo hecho: ya eligió.
    if (saved.verdict !== 'saved') throw new ContractError('contrasena_ya_elegida');

    const { token, expiresAt } = await this.tokens.sign({
      sub: caller.accountId,
      sid: caller.sessionId,
      rol: caller.role,
      alcance: 'completo',
      region: caller.region,
      ...(caller.practiceId ? { practice: caller.practiceId } : {}),
      permisos: resolvePermissions(caller.role, saved.permissions ?? null),
    });

    const facts = await this.sessions.nextStepFacts({
      accountId: caller.accountId,
      practiceId: caller.practiceId,
      accountRole: caller.accountRole,
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
}
