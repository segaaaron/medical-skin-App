// POST /v1/cuentas/{cuenta_id}/acceso · mandar —o volver a mandar— el acceso de una
// paciente, con contraseña temporal nueva.
//
// «Cada llamada acuña una contraseña nueva y mata la anterior», y por eso NO es idempotente
// y no lleva `Idempotency-Key`: dos llamadas son dos temporales, y la que vale es la última.
//
// El orden importa por una razón concreta: el `celular_necesario_para_whatsapp` se
// comprueba ANTES de acuñar. Si se acuñara primero, una doctora que elige WhatsApp sobre
// una ficha sin celular habría matado la temporal que su paciente ya tenía para recibir un
// 400.

import { z } from 'zod';

import { ContractError } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import type { ClockPort, PasswordHasher } from '../../access/domain/ports';
import {
  isDeliveryChannel,
  temporaryTravelsTo,
  whatsappText,
  whatsappUrl,
  type DeliveryChannel,
} from '../domain/access-delivery';
import {
  TEMPORARY_PASSWORD_HOURS,
  mintTemporaryPassword,
  temporaryPasswordExpiry,
} from '../domain/temporary-password';
import type {
  AccountOwner,
  PatientAccessPort,
  PatientForDelivery,
  ResendLimitPort,
} from '../domain/ports';

/** El permiso de este endpoint. `cuentas.md`: «Recepción **no**». */
export const PERMISSION = 'pacientes:acceso:enviar';

const bodySchema = z.object({ via: z.unknown() });

export type AccessBlock = {
  via: DeliveryChannel;
  /** «Que el correo llegue o no es asunto del trabajador»: aquí todavía no se mandó. */
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

    return this.block(via, temporary, expiresAt, patient);
  }

  private block(
    via: DeliveryChannel,
    temporary: string,
    expiresAt: Date,
    patient: PatientForDelivery,
  ): AccessBlock {
    const expiryText = `Caduca el ${this.clock.localLongWhen(expiresAt)}`;
    const travels = temporaryTravelsTo(via);

    const block: AccessBlock = {
      via,
      // El envío por correo lo hace el trabajador, así que cuando esta respuesta se
      // escribe todavía no se mandó nada. Por WhatsApp lo manda la doctora desde su propio
      // teléfono, y por `ninguna` no se manda nunca: en los tres casos, `false`.
      enviado: false,
      contrasena_temporal: travels ? temporary : null,
      caduca_en: expiresAt.toISOString(),
      caduca_en_texto: expiryText,
    };

    if (via !== 'whatsapp' || patient.phone === null) return block;

    const texto = whatsappText({
      patientFirstName: patient.firstName,
      patientEmail: patient.email,
      practitionerName: patient.practitionerName,
      temporaryPassword: temporary,
      expiryText,
    });
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
