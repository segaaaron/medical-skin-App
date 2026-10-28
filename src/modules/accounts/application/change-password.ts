// PATCH /v1/cuentas/mia/contrasena · cambiar la contraseña sabiendo la actual.
//
// No confundir con `POST /v1/acceso/contrasena-nueva`, que es la pantalla obligatoria y no
// pide la actual porque la actual es la temporal o no existe.
//
// Aquí SÍ se nombra el campo que falló, al contrario que en `POST /v1/acceso`: quien llama
// ya está dentro, así que no hay oráculo que cerrar. `cuentas.md`, literal.
//
// Y no hay interruptor de «cerrar las otras sesiones»: cambiar la contraseña revoca
// SIEMPRE las demás y deja viva solo la que lo hizo. El interruptor existió y se quitó el
// 27 de octubre, porque ofrecía dejar abiertas sesiones que siguen dentro con la contraseña
// vieja, que es justo lo que alguien intenta cortar cuando cambia la suya.

import { z } from 'zod';

import { ContractError } from '../../../shared/contract/error-catalog';
import type { ClockPort, PasswordHasher } from '../../access/domain/ports';
import { checkNewPassword } from '../../access/domain/password-rules';
import type { Caller } from '../../access/application/caller';
import type { AccountOwner, OwnCredentialPort, PasswordAttemptsPort } from '../domain/ports';

/** «5 fallos de `actual` en 15 min» (`cuentas.md`). */
export const ATTEMPTS_PER_WINDOW = 5;
export const WINDOW_MINUTES = 15;

const bodySchema = z.object({ actual: z.unknown(), nueva: z.unknown() });

export type ChangePasswordResponse = {
  cambiada_en: string;
  sesiones_cerradas: number;
};

export class ChangeOwnPassword {
  constructor(
    private readonly credentials: OwnCredentialPort,
    private readonly passwords: PasswordHasher,
    private readonly attempts: PasswordAttemptsPort,
    private readonly clock: ClockPort,
  ) {}

  async run(input: unknown, caller: Caller): Promise<ChangePasswordResponse> {
    const parsed = bodySchema.safeParse(input ?? {});
    const current = typeof parsed.data?.actual === 'string' ? parsed.data.actual : '';

    // Las reglas de la nueva son LAS MISMAS que las de `contrasena-nueva`, y por eso es la
    // misma función: si fueran dos, un día divergirían.
    const candidate = checkNewPassword(parsed.success ? parsed.data.nueva : undefined);

    // Antes de comparar: una contraseña nueva igual a la actual no es un fallo de
    // autenticación y no gasta intento.
    if (candidate === current) throw new ContractError('contrasena_igual_a_la_actual');

    const owner = ownerOf(caller);
    if ((await this.attempts.spent(owner.accountId)) >= ATTEMPTS_PER_WINDOW) {
      throw this.tooManyError();
    }

    const credential = await this.credentials.readMine(owner);
    const matched =
      credential !== null && (await this.passwords.verify(credential.hash, current));
    if (!matched) {
      await this.attempts.recordFailure(owner.accountId);
      throw new ContractError('contrasena_actual_no_coincide');
    }

    const hash = await this.passwords.hash(candidate);
    const { sessionsRevoked } = await this.credentials.replace({ owner, hash });
    await this.attempts.clear(owner.accountId);

    return {
      cambiada_en: this.clock.now().toISOString(),
      // No es un parámetro: es el resultado, y alimenta el snackbar.
      sesiones_cerradas: sessionsRevoked,
    };
  }

  /**
   * La frase es la de `cuentas.md` y no la del catálogo, que es la de `recuperacion.md`
   * para el mismo `codigo`. Dos contratos escriben dos frases para `demasiados_intentos`;
   * el catálogo lleva una y el otro endpoint pasa la suya. Anotado para `producto`.
   */
  private tooManyError(): ContractError {
    return new ContractError(
      'demasiados_intentos',
      { pausa_minutos: WINDOW_MINUTES },
      `Demasiados intentos. Prueba de nuevo en ${WINDOW_MINUTES} minutos.`,
    );
  }
}

function ownerOf(caller: Caller): AccountOwner {
  return {
    accountId: caller.accountId,
    practiceId: caller.practiceId,
    accountRole: caller.accountRole,
    sessionId: caller.sessionId,
  };
}
