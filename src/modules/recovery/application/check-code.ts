// POST /v1/recovery/code · validar el código y abrir la pantalla de contraseña nueva.
//
// EL ORDEN ES PARTE DEL CONTRATO, igual que en el acceso:
//
//   1. forma del cuerpo: los seis dígitos y la forma del correo
//   2. el límite por IP
//   3. el código vigente —el real o el señuelo— y el veredicto
//   4. el verificado de Argon2id SIEMPRE, contra el hash real o contra el del señuelo
//   5. si no coincide → se gasta el intento y 401 `codigo_no_coincide`
//   6. solo si coincide → el token de alcance `recuperacion`
//
// El intento se gasta en el paso 5 y en ningún otro, porque el 500 de este endpoint
// promete que «el código sigue valiendo: puedes volver a intentarlo». Solo cuentan los
// códigos que de verdad se compararon.

import { z } from 'zod';

import { ContractError } from '../../../shared/contract/error-catalog';
import type { Region } from '../../../shared/contract/session';
import {
  ATTEMPTS_PER_CODE,
  readCode,
  readEmail,
  verdictForUnknownAccount,
  type CodeVerdict,
} from '../domain/code';
import type { RecoveryCodePort, RecoveryLimitsPort } from '../domain/ports';

const bodySchema = z.object({ correo: z.unknown(), codigo: z.unknown() });

export type CheckCodeResponse = {
  token: string;
  token_caduca_en: string;
  alcance: 'recuperacion';
};

/** Lo mínimo del firmador: acuñar el token de recuperación, que no lleva rol ni sesión. */
export interface RecoveryTokenPort {
  signRecovery(claims: {
    sub: string;
    alcance: 'recuperacion';
    region: Region;
  }): Promise<{ token: string; expiresAt: Date }>;
}

/** Lo mínimo del comparador: el mismo coste para el hash real y para el del señuelo. */
export interface CodeHasher {
  verify(hash: string, code: string): Promise<boolean>;
}

export class CheckRecoveryCode {
  constructor(
    private readonly codes: RecoveryCodePort,
    private readonly limits: RecoveryLimitsPort,
    private readonly hasher: CodeHasher,
    private readonly tokens: RecoveryTokenPort,
    /** §7.4: un despliegue por región, y la etiqueta sale de la configuración. */
    private readonly region: Region,
  ) {}

  async run(input: unknown, ip: string): Promise<CheckCodeResponse> {
    // --- 1 · la forma. El código primero porque es el campo que la persona escribió.
    const parsed = bodySchema.safeParse(input ?? {});
    const code = readCode(parsed.success ? parsed.data.codigo : undefined);
    const email = readEmail(parsed.success ? parsed.data.correo : undefined);

    // --- 2 · el límite por IP, antes de comparar nada.
    const room = await this.limits.countAttemptByIp(ip);
    if (room.tooMany) throw new ContractError('demasiados_intentos');

    // --- 3 · el código vigente y el veredicto. Para un correo sin cuenta la base no tiene
    // fila que caducar ni anular, así que el veredicto se reconstruye con los contadores
    // —ver `verdictForUnknownAccount()`—: si no, el código de estado diría si el correo
    // existe.
    const live = await this.codes.live(email);
    const history = await this.limits.historyOf(email);
    const verdict: CodeVerdict =
      live.accountId === null ? verdictForUnknownAccount(history) : live.verdict;

    if (verdict === 'expired') throw new ContractError('codigo_caducado');
    if (verdict === 'voided') throw this.voidedError(live.voidedReason, history.attemptsSpent);

    // --- 4 · el verificado, siempre. El hash es el real o el del señuelo.
    const matched = await this.hasher.verify(live.codeHash, code);

    // --- 5 · si no coincide, aquí termina. El intento se gasta en los dos sitios que
    // cuentan: la fila del código —que se anula al quinto— y el contador por correo, que
    // es el que puede contar cuando no hay fila.
    if (!matched || live.accountId === null) {
      if (live.accountId !== null) await this.codes.miss(email);
      const left = await this.limits.recordMiss(email);
      if (left <= 0) throw this.voidedError('intentos', ATTEMPTS_PER_CODE);
      throw this.mismatchError(left);
    }

    // --- 6 · solo si coincide. El token NO lleva rol: «el código va antes de saber el
    // rol», y una reclamación `rol` aquí sería un oráculo mejor que el del acceso, porque
    // diría QUÉ es la persona y no solo que existe.
    await this.limits.clearAttempts(email);
    const { token, expiresAt } = await this.tokens.signRecovery({
      sub: live.accountId,
      alcance: 'recuperacion',
      region: this.region,
    });

    // Validar el código no cambia la contraseña ni cierra sesiones: eso es el paso
    // siguiente, `POST /v1/access/new-password`. Y el código se anula allí, en la
    // misma transacción que guarda la contraseña.
    return {
      token,
      token_caduca_en: expiresAt.toISOString(),
      alcance: 'recuperacion',
    };
  }

  /**
   * Los dos 410 son dos frases distintas a propósito: «caducó» y «se anuló por tantos
   * intentos» llevan a la misma acción, pero la segunda tiene que decir además que la
   * cuenta sigue bien, porque es justo lo que la paciente va a temer.
   */
  private voidedError(reason: string | null, attemptsSpent: number): ContractError {
    // `usado` no es uno de los dos motivos del contrato, y es el código que ya se gastó
    // para elegir una contraseña: para quien lo lee es el mismo hecho que «se pidió otro».
    const motivo =
      reason === 'intentos' || attemptsSpent >= ATTEMPTS_PER_CODE ? 'intentos' : 'codigo_nuevo';
    return new ContractError('codigo_anulado', { motivo });
  }

  private mismatchError(attemptsLeft: number): ContractError {
    // «Te quedan 1 intentos» no se le escribe a nadie: concordar el singular es
    // interpolar bien, no cambiar la frase.
    const intentos = attemptsLeft === 1 ? 'Te queda 1 intento' : `Te quedan ${attemptsLeft} intentos`;
    return new ContractError(
      'codigo_no_coincide',
      { intentos_restantes: attemptsLeft },
      `Ese código no es. ${intentos}.`,
    );
  }
}
