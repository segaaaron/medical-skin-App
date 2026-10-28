// El correo del código · `recuperacion.md` y `Correo.dc.html` · 2.
//
// EL ASUNTO ES «Tu código de MedSkin» Y NADA MÁS. Ni el nombre de la doctora, ni el del
// tratamiento, ni el de la clínica: es lo que se lee en la pantalla bloqueada del teléfono
// (§11.1). Por la misma razón el cuerpo tampoco lleva el nombre de nadie, ni el de la
// consulta, ni una palabra de para qué se usa MedSkin. Lo único que dice es el código, su
// hora, que nadie lo va a pedir, y qué hacer si no se pidió.
//
// Y las dos frases largas son LITERALES del contrato. No se reescriben «mejor»: son el
// mensaje que un estafador copiaría, y están medidas.

import { MailMessage, type MailPort } from '../../../shared/mail/mailer';
import { CODE_LIFETIME_MINUTES } from '../domain/code';
import type { RecoveryMailPort } from '../domain/ports';

/** Lo mínimo del reloj: la hora local del despliegue para «Caduca a las 09:28». */
export interface LocalClock {
  localTime(moment: Date): string;
}

export const RECOVERY_SUBJECT = 'Tu código de MedSkin';

export const ANTI_SCAM =
  'Nadie de MedSkin ni de tu clínica te va a pedir este código por teléfono, por WhatsApp ni por correo. Si alguien te lo pide, no se lo des.';

export const NOT_YOU =
  'Si no pediste el código, ignóralo: tu contraseña de ahora sigue valiendo y nadie ha entrado.';

/**
 * El cuerpo, armado aparte de quien lo manda para poder probarlo sin SMTP. Es texto plano
 * a propósito: un correo con HTML y una imagen de seguimiento le diría al remitente cuándo
 * y desde dónde se abrió, y esto lo abre una paciente de una clínica de estética.
 */
export function recoveryMailBody(p: { code: string; expiresAt: Date; clock: LocalClock }): string {
  return [
    `Tu código es ${p.code}.`,
    '',
    `Caduca a las ${p.clock.localTime(p.expiresAt)}, ${CODE_LIFETIME_MINUTES} minutos después de que lo pediste, y vale una sola vez.`,
    '',
    ANTI_SCAM,
    '',
    NOT_YOU,
  ].join('\n');
}

export class RecoveryMail implements RecoveryMailPort {
  constructor(
    private readonly mail: MailPort,
    private readonly clock: LocalClock,
  ) {}

  async sendCode(p: { email: string; code: string; expiresAt: Date }): Promise<void> {
    const message: MailMessage = {
      to: p.email,
      subject: RECOVERY_SUBJECT,
      text: recoveryMailBody({ code: p.code, expiresAt: p.expiresAt, clock: this.clock }),
    };
    await this.mail.send(message);
  }
}
