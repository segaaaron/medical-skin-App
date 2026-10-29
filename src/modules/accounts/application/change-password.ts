// PATCH /v1/accounts/mine/password · cambiar la contraseña sabiendo la actual.
//
// No confundir con `POST /v1/access/new-password`, que es la pantalla obligatoria y no
// pide la actual porque la actual es la temporal o no existe.
//
// Aquí SÍ se nombra el campo que falló, al contrario que en `POST /v1/access`: quien llama
// ya está dentro, así que no hay oráculo que cerrar. `cuentas.md`, literal.
//
// Y no hay interruptor de «cerrar las otras sesiones»: cambiar la contraseña revoca
// SIEMPRE las demás y deja viva solo la que lo hizo. El interruptor existió y se quitó el
// 27 de octubre, porque ofrecía dejar abiertas sesiones que siguen dentro con la contraseña
// vieja, que es justo lo que alguien intenta cortar cuando cambia la suya.

import { z } from 'zod';

import { ContractError, type ErrorCode } from '../../../shared/contract/error-catalog';
import type { ClockPort, PasswordHasher } from '../../access/domain/ports';
import { checkNewPassword } from '../../access/domain/password-rules';
import type { Caller } from '../../access/application/caller';
import type { AccountOwner, OwnCredentialPort, PasswordAttemptsPort } from '../domain/ports';

/** «5 fallos de `actual` en 15 min» (`cuentas.md`). */
export const ATTEMPTS_PER_WINDOW = 5;
export const WINDOW_MINUTES = 15;

const bodySchema = z.object({ actual: z.unknown(), nueva: z.unknown() });

/**
 * LAS FRASES DE `cuentas.md`, que no son las del catálogo, y la razón es que un ítem de
 * checklist no es un mensaje. El catálogo lleva el de `acceso.md` —«8 caracteres o más»,
 * «No es una de las contraseñas más usadas»— porque allí son requisitos que se dibujan
 * antes de escribir y se marcan al cumplirse, no errores que saltan al enviar.
 *
 * Leídos como mensaje, esos dos AFIRMAN LO CONTRARIO DE LO QUE PASÓ: la usuaria escribe
 * `password1` y el servidor le contesta «No es una de las contraseñas más usadas».
 * `_convenciones.md` prohíbe exactamente eso, y la regla que lo resuelve es la misma que ya
 * usa `demasiados_intentos`: el catálogo guarda la frase que la app muestra sin red, y el
 * mensaje específico pertenece al ENDPOINT, que lo manda en `mensaje`.
 */
const PHRASES: Partial<Record<ErrorCode, string>> = {
  contrasena_corta: 'Tiene que tener 8 caracteres o más.',
  contrasena_muy_usada: 'Esa es una de las contraseñas más usadas. Elige otra.',
};

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
    // misma función: si fueran dos, un día divergirían. Lo que cambia es la FRASE, porque
    // aquí es un error que salta al enviar y allí un requisito que se marca al cumplirse.
    const candidate = withOwnPhrase(() =>
      checkNewPassword(parsed.success ? parsed.data.nueva : undefined),
    );

    // Antes de comparar: una contraseña nueva igual a la actual no es un fallo de
    // autenticación y no gasta intento.
    if (candidate === current) throw new ContractError('contrasena_igual_a_la_actual');

    const owner = ownerOf(caller);
    if ((await this.attempts.spent(owner.accountId)) >= ATTEMPTS_PER_WINDOW) {
      throw this.tooManyError();
    }

    const credential = await this.credentials.readMine(owner);
    const matched =
      credential !== null && (await this.passwords.verify(credential.hash, current, owner));
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

/** Cambia la frase del catálogo por la de este endpoint. El `codigo` NO se toca. */
function withOwnPhrase(work: () => string): string {
  try {
    return work();
  } catch (failure) {
    if (!(failure instanceof ContractError)) throw failure;
    const phrase = PHRASES[failure.code];
    if (phrase === undefined) throw failure;
    throw new ContractError(failure.code, failure.data, phrase);
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
