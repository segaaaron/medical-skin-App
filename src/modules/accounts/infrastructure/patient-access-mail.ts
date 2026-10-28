// El correo del acceso de la paciente · `cuentas.md` · `via: "correo"`.
//
// EL ASUNTO ES «Tu acceso a MedSkin» Y NADA MÁS: ni el nombre de la clínica, ni el de la
// doctora, ni una palabra de tratamiento. Es lo que se lee en la pantalla bloqueada del
// teléfono (§11.1), igual que el de recuperación. El cuerpo es el del dominio, texto plano,
// sin HTML y sin imagen de seguimiento: un correo con imagen le diría al remitente cuándo y
// desde dónde se abrió, y esto lo abre una paciente de una clínica de estética.
//
// Armado como el de recuperación —cuerpo en el dominio, envío aquí— para poder probar lo
// que dice sin levantar un SMTP.

import { MailMessage, type MailPort } from '../../../shared/mail/mailer';
import {
  accessMailBody,
  linkNoticeMailBody,
  type DeliveryFacts,
  type LinkNoticeFacts,
} from '../domain/access-delivery';
import type { PatientAccessMailPort, PatientLinkNoticeMailPort } from '../domain/ports';

export const ACCESS_SUBJECT = 'Tu acceso a MedSkin';

export class PatientAccessMail implements PatientAccessMailPort, PatientLinkNoticeMailPort {
  constructor(private readonly mail: MailPort) {}

  async sendAccess(facts: DeliveryFacts): Promise<void> {
    const message: MailMessage = {
      to: facts.patientEmail,
      subject: ACCESS_SUBJECT,
      text: accessMailBody(facts),
    };
    await this.mail.send(message);
  }

  /**
   * El aviso de quien ya tenía cuenta. MISMO ASUNTO, «Tu acceso a MedSkin» y nada más: lo
   * que cambia es el cuerpo, que no nombra ninguna contraseña porque no se acuñó ninguna.
   * Dos asuntos distintos dirían en la pantalla bloqueada del teléfono cuál de los dos
   * casos es, y eso es exactamente lo que el asunto no dice nunca.
   */
  async sendLinkNotice(facts: LinkNoticeFacts): Promise<void> {
    const message: MailMessage = {
      to: facts.patientEmail,
      subject: ACCESS_SUBJECT,
      text: linkNoticeMailBody(facts),
    };
    await this.mail.send(message);
  }
}
