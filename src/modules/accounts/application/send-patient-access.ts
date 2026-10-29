// POST /v1/accounts/{account_id}/access · mandar —o volver a mandar— el acceso de una
// paciente, con contraseña temporal nueva.
//
// «Cada llamada acuña una contraseña nueva y mata la anterior», y por eso NO es idempotente
// y no lleva `Idempotency-Key`: dos llamadas son dos temporales, y la que vale es la última.
//
// El orden importa por una razón concreta: el `celular_necesario_para_whatsapp` se
// comprueba ANTES de acuñar. Si se acuñara primero, una doctora que elige WhatsApp sobre
// una ficha sin celular habría matado la temporal que su paciente ya tenía para recibir un
// 400.
//
// Y EL INVARIANTE QUE SOSTIENE EL ENDPOINT: para cada `via`, o se entregó un mensaje, o la
// contraseña viaja en la respuesta. Nunca ninguna de las dos. `via: "correo"` incumplía las
// dos mitades a la vez —`contrasena_temporal: null` y nadie mandando el correo—, y el
// resultado era una paciente que entraba y, tras un reenvío, se quedaba fuera para
// siempre: la temporal anterior muerta, `temp_first_used_at` de vuelta a nulo y
// «Olvidé mi contraseña» acuñando nada, porque exige una temporal estrenada.

import { z } from 'zod';

import {
  ContractError,
  FAILURE_PHRASES,
  ServiceFailure,
} from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import type { ClockPort, PasswordHasher } from '../../access/domain/ports';
import {
  isDeliveryChannel,
  temporaryTravelsTo,
  whatsappText,
  whatsappUrl,
  type DeliveryChannel,
  type DeliveryFacts,
} from '../domain/access-delivery';
import {
  TEMPORARY_PASSWORD_HOURS,
  mintTemporaryPassword,
  temporaryPasswordExpiry,
} from '../domain/temporary-password';
import type {
  AccountOwner,
  PatientAccessMailPort,
  PatientAccessPort,
  PatientForDelivery,
  ResendLimitPort,
} from '../domain/ports';

/** El permiso de este endpoint. `cuentas.md`: «Recepción **no**». */
export const PERMISSION = 'pacientes:acceso:enviar';

const bodySchema = z.object({ via: z.unknown() });

export type AccessBlock = {
  via: DeliveryChannel;
  /**
   * EL INVARIANTE DEL ENDPOINT: o se entregó un mensaje, o la contraseña viaja en la
   * respuesta. Nunca ninguna de las dos, porque acuñar mata la temporal que la paciente ya
   * tenía y «Olvidé mi contraseña» no sirve con una temporal sin estrenar.
   *
   * `correo`: lo manda MedSkin, aquí mismo, y `enviado` dice si salió de verdad.
   * `whatsapp` y `ninguna`: lo manda la doctora con el dedo, así que `false` y la
   * contraseña va en la respuesta, que es la concesión escrita del contrato.
   */
  enviado: boolean;
  contrasena_temporal: string | null;
  caduca_en: string;
  caduca_en_texto: string;
  whatsapp?: { numero: string; texto: string; url: string };
};

/** Lo mínimo del reloj, más la frase larga de `caduca_en_texto`. */
export interface DeliveryClock extends ClockPort {
  localLongWhen(moment: Date): string;
}

export class SendPatientAccess {
  constructor(
    private readonly patients: PatientAccessPort,
    private readonly passwords: PasswordHasher,
    private readonly limit: ResendLimitPort,
    private readonly clock: DeliveryClock,
    private readonly mail: PatientAccessMailPort,
  ) {}

  async run(input: unknown, accountId: string, caller: Caller): Promise<AccessBlock> {
    // --- Autorización por RECURSO y no solo por rol: el permiso sale de la lista resuelta
    // que viaja en el token, no de un `rol` que el cliente diga (OWASP A01).
    if (!caller.permissions.includes(PERMISSION)) throw new ContractError('sin_permiso');

    const parsed = bodySchema.safeParse(input ?? {});
    const via = parsed.success ? parsed.data.via : undefined;
    if (!isDeliveryChannel(via)) throw new ContractError('via_no_valida');

    const owner = ownerOf(caller);

    // --- La paciente de ESTA consulta. Un `cuenta_id` de otra no devuelve fila, y el 404
    // es el mismo que el de un `cuenta_id` inventado: no se distingue una cosa de la otra.
    const patient = await this.patients.forDelivery(owner, accountId);
    if (patient === null) throw new ContractError('paciente_no_existe');

    // --- Antes de acuñar: sin celular no hay WhatsApp que abrir, y matar la temporal que
    // ya tenía para después devolver un 400 sería cobrarle el error a la paciente.
    if (via === 'whatsapp' && (patient.phone === null || patient.phone.trim() === '')) {
      throw new ContractError('celular_necesario_para_whatsapp');
    }

    if ((await this.limit.count(accountId)).tooMany) {
      throw new ContractError('demasiados_reenvios');
    }

    const now = this.clock.now();
    const expiresAt = temporaryPasswordExpiry(now);
    const temporary = mintTemporaryPassword();

    const { outcome } = await this.patients.resend({
      owner,
      accountId,
      hash: await this.passwords.hash(temporary),
      expiresAt,
      via,
    });

    // «Una doctora no puede resetear la contraseña de su paciente una vez elegida. Si
    // pudiera, sería dueña del acceso al expediente de una persona adulta.»
    if (outcome === 'ya_eligio_su_contrasena') throw this.alreadyChosen(patient.firstName);
    if (outcome !== 'acceso_renovado') throw new ContractError('paciente_no_existe');

    const expiryText = `Caduca el ${this.clock.localLongWhen(expiresAt)}`;
    const facts: DeliveryFacts = {
      patientFirstName: patient.firstName,
      patientEmail: patient.email,
      practitionerName: patient.practitionerName,
      temporaryPassword: temporary,
      expiryText,
    };

    // EN LÍNEA Y NO POR COLA, y la razón es una: por aquí la temporal ya está acuñada, así
    // que encolar obliga a meter la contraseña EN CLARO en Redis para que el trabajador la
    // escriba. El trabajador de recuperación se libra de eso porque acuña él el código
    // («la cola recibe a quién escribirle, no qué escribirle»); aquí no se puede acuñar
    // dos veces, porque la segunda mataría la primera. Y en línea `enviado` puede decir la
    // verdad en la misma respuesta, que es lo que le da a la doctora su salida cuando el
    // relé está caído. No hay oráculo de tiempo que cerrar: quien llama ya está dentro.
    const sent = via === 'correo' ? await this.sendMail(owner, accountId, facts, patient) : false;

    return this.block(via, temporary, expiresAt, patient, facts, sent);
  }

  /** Un envío que falla es un 500 con la frase del contrato, nunca un 200 que miente. */
  private async sendMail(
    owner: AccountOwner,
    accountId: string,
    facts: DeliveryFacts,
    patient: PatientForDelivery,
  ): Promise<true> {
    try {
      await this.mail.sendAccess(facts);
      return true;
    } catch (cause) {
      // Ni el correo de la paciente ni la contraseña entran en la causa: solo la cuenta.
      // La causa real del relé viaja encadenada y acaba en `service_failure` (§10.3).
      await this.undoSentMark(owner, accountId, patient.accessSentAt);
      throw new ServiceFailure(
        FAILURE_PHRASES.sendPatientAccessMail,
        new Error(`no se pudo mandar el acceso de la cuenta ${accountId}`, { cause }),
      );
    }
  }

  /**
   * La función escribe `access_sent_at = now()` AL ACUÑAR, así que un envío fallido dejaba
   * en la base la afirmación «ya se le mandó» siendo falsa, y es la columna que la consola
   * lee para decidir si hay que reenviar. Se le devuelve SU VALOR ANTERIOR en la misma
   * llamada —la fecha del último envío que sí ocurrió, o nulo si no hubo ninguno—: esa
   * columna solo puede afirmar un envío que ocurrió, y compensar es deshacer lo que esta
   * llamada escribió, no borrar la historia. El intento vive en `access_audit`.
   */
  private async undoSentMark(
    owner: AccountOwner,
    accountId: string,
    previous: Date | null,
  ): Promise<void> {
    try {
      await this.patients.restoreAccessSentAt(owner, accountId, previous);
    } catch (whileUndoing) {
      // Lo mismo para quien lo lee —el acceso no salió y su temporal anterior murió—, pero
      // la fila de `service_failure` dice que ADEMÁS la marca quedó puesta, que es lo que
      // alguien tiene que ir a corregir. Un fallo que no se puede compensar se registra.
      throw new ServiceFailure(
        FAILURE_PHRASES.sendPatientAccessMail,
        new Error(
          `el acceso de la cuenta ${accountId} no se mandó y la marca de envío quedó puesta`,
          { cause: whileUndoing },
        ),
      );
    }
  }

  private block(
    via: DeliveryChannel,
    temporary: string,
    expiresAt: Date,
    patient: PatientForDelivery,
    facts: DeliveryFacts,
    sent: boolean,
  ): AccessBlock {
    const travels = temporaryTravelsTo(via);

    const block: AccessBlock = {
      via,
      enviado: sent,
      contrasena_temporal: travels ? temporary : null,
      caduca_en: expiresAt.toISOString(),
      caduca_en_texto: facts.expiryText,
    };

    if (via !== 'whatsapp' || patient.phone === null) return block;

    const texto = whatsappText(facts);
    // `texto` Y `url` a propósito: `url` para abrir el chat, `texto` para que la app pueda
    // ofrecer «copiar el mensaje» cuando WhatsApp no esté instalado, sin desescaparlo.
    return {
      ...block,
      whatsapp: { numero: patient.phone, texto, url: whatsappUrl(patient.phone, texto) },
    };
  }

  /** La frase lleva el nombre, que es lo que hace útil el aviso en la pantalla. */
  private alreadyChosen(firstName: string): ContractError {
    return new ContractError(
      'ya_eligio_su_contrasena',
      { horas: TEMPORARY_PASSWORD_HOURS },
      `${firstName} ya eligió su contraseña. Si no puede entrar, dile que use «Olvidé mi contraseña».`,
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
