// El trabajador de la cola: acuña el código y manda el correo. NO es un endpoint.
//
// Está aquí y no en el ciclo de la petición por la razón del contrato: el 202 tiene que
// tardar lo mismo exista o no el correo, y acuñar escribe dos filas cuando la cuenta
// existe y ninguna cuando no. Movido aquí, el camino de la petición es idéntico y el
// trabajo asimétrico pasa donde nadie puede cronometrarlo.
//
// Y de ahí sale lo otro que el contrato pide: «el código en claro no viaja en el trabajo
// de la cola». No viaja porque cuando el trabajo se encola el código TODAVÍA NO EXISTE.

import { mintCode } from '../domain/code';
import type { RecoveryCodePort, RecoveryMailJob, RecoveryMailPort } from '../domain/ports';

/** Lo mínimo del hasher: el código se guarda hasheado, igual que una contraseña. */
export interface CodeWriter {
  hash(code: string): Promise<string>;
}

export class SendRecoveryCode {
  constructor(
    private readonly codes: RecoveryCodePort,
    private readonly hasher: CodeWriter,
    private readonly mail: RecoveryMailPort,
  ) {}

  /**
   * Un reintento de este trabajo ACUÑA OTRO CÓDIGO, y es correcto: acuñar anula el
   * anterior, así que sigue habiendo uno vivo por cuenta y es el último. Lo que un
   * reintento puede producir es un segundo correo cuando el primero sí se mandó y el
   * acuse se perdió; de los dos, el que vale es el del segundo, que es el que ella acaba
   * de recibir. La alternativa —guardar el código en claro en algún sitio para reintentar
   * el mismo— es guardar una credencial viva fuera del correo, y eso no se hace.
   */
  async run(job: RecoveryMailJob): Promise<void> {
    const code = mintCode();
    const codeHash = await this.hasher.hash(code);

    // El booleano no sale nunca del servidor. Aquí decide si hay correo que escribir: una
    // cuenta que no existe, que está suspendida o que NUNCA ESTRENÓ su temporal no recibe
    // nada, y la paciente de ese último caso tiene su camino —la temporal que ya tiene, o
    // que la doctora le reenvíe el acceso—.
    const minted = await this.codes.mint({
      email: job.email,
      codeHash,
      expiresAt: job.expiresAt,
    });
    if (!minted) return;

    await this.mail.sendCode({ email: job.email, code, expiresAt: job.expiresAt });
  }
}
