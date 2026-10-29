// POST /v1/recovery · pedir el código de seis dígitos.
//
// LA REGLA DE ESTE CASO DE USO ES QUE NO TOCA LA BASE, y no es una optimización: es la
// única forma de cumplir «esta respuesta es idéntica exista o no el correo, mismo 202,
// mismo cuerpo, mismo `caduca_en` calculado, mismo tiempo de respuesta».
//
// Lo que hace es contar, encolar y responder, y hace exactamente eso en los dos casos. Si
// acuñara aquí, el camino del correo con cuenta haría un `UPDATE` y un `INSERT` más que el
// del correo sin cuenta, y el cronómetro distinguiría los dos: eso es dato de salud.
// Quien acuña es el trabajador de la cola, que ya no tiene a nadie mirándole el reloj.
//
// Por eso también la cola recibe A QUIÉN escribirle y no QUÉ escribirle: el código todavía
// no existe cuando se encola el trabajo.

import { z } from 'zod';

import { FAILURE_PHRASES, ServiceFailure } from '../../../shared/contract/error-catalog';
import { ContractError } from '../../../shared/contract/error-catalog';
import type { ClockPort } from '../../access/domain/ports';
import {
  ATTEMPTS_PER_CODE,
  CODE_LIFETIME_MINUTES,
  RESEND_AFTER_SECONDS,
  readEmail,
} from '../domain/code';
import type { RecoveryLimitsPort, RecoveryQueuePort } from '../domain/ports';

const bodySchema = z.object({ correo: z.unknown() });

export type RequestCodeResponse = {
  mensaje: string;
  caduca_en: string;
  puede_reenviar_en: string;
  intentos_restantes: number;
};

export class RequestRecoveryCode {
  constructor(
    private readonly limits: RecoveryLimitsPort,
    private readonly queue: RecoveryQueuePort,
    private readonly clock: ClockPort,
  ) {}

  async run(input: unknown, ip: string): Promise<RequestCodeResponse> {
    const parsed = bodySchema.safeParse(input ?? {});
    const email = readEmail(parsed.success ? parsed.data.correo : undefined);

    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + CODE_LIFETIME_MINUTES * 60_000);

    // El contador se incrementa exista o no la cuenta, y la frase del 429 es la misma en
    // los dos casos (`_convenciones.md` · «Los contadores», regla 1).
    const room = await this.limits.countRequest({ email, ip, expiresAt });
    if (room.tooMany) throw new ContractError('demasiados_codigos');

    await this.enqueue(email, expiresAt);

    return {
      // La frase la manda el servidor interpolada «para que la app no tenga que decidir
      // cómo se escribe». El correo que se interpola ya pasó la comprobación de forma de
      // `readEmail()`: lo que vuelve es una cadena que tiene forma de correo y nada más.
      mensaje: `Si ${email} tiene cuenta en MedSkin, el código ya está en su bandeja.`,
      caduca_en: expiresAt.toISOString(),
      puede_reenviar_en: new Date(now.getTime() + RESEND_AFTER_SECONDS * 1000).toISOString(),
      // Un código recién pedido tiene sus cinco intentos, y el número es el mismo para un
      // correo sin cuenta: es un dato del código, no de la cuenta.
      intentos_restantes: ATTEMPTS_PER_CODE,
    };
  }

  /**
   * «Que el correo llegue o no es asunto del trabajador, y su fallo va a
   * `service_failure`.» Lo que NO puede fallar en silencio es el encolado: si no se encoló
   * nada, nadie va a escribir ese correo nunca, y el 202 estaría mintiendo. De ahí el 500
   * con su frase del contrato, «No se pudo enviar el código.»
   */
  private async enqueue(email: string, expiresAt: Date): Promise<void> {
    try {
      await this.queue.enqueue({ email, expiresAt });
    } catch (cause) {
      throw new ServiceFailure(FAILURE_PHRASES.requestRecoveryCode, cause);
    }
  }
}
