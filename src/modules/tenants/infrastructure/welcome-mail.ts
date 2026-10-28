// El correo del alta de una consulta · `Correo.dc.html` · 1, nombrado por `inquilinos.md`:
// «El correo del alta sale en el mismo acto».
//
// MISMO MECANISMO que los otros tres correos del tramo —el `MailPort` de siempre, texto
// plano, sin HTML y sin imagen de seguimiento—. Lo único propio es la plantilla, que vive en
// el dominio para poder probar lo que dice sin levantar un SMTP.

import { MailMessage, type MailPort } from '../../../shared/mail/mailer';
import { ownerWelcomeMailBody } from '../domain/admission';
import type { WelcomeMailPort } from '../domain/platform-ports';

/**
 * El mismo asunto literal que el acceso de una paciente y el del equipo: es lo que se lee en
 * la pantalla bloqueada del teléfono (§11.1) y no dice nada clínico. Se escribe aquí y no se
 * importa del módulo de cuentas a propósito: son dos contratos distintos y el día que uno
 * cambie su asunto no tiene que arrastrar al otro.
 */
export const WELCOME_SUBJECT = 'Tu acceso a MedSkin';

export class WelcomeMail implements WelcomeMailPort {
  constructor(private readonly mail: MailPort) {}

  async sendOwnerWelcome(facts: {
    firstName: string;
    email: string;
    practiceName: string;
    temporaryPassword: string;
    expiryText: string;
  }): Promise<void> {
    const message: MailMessage = {
      to: facts.email,
      subject: WELCOME_SUBJECT,
      text: ownerWelcomeMailBody(facts),
    };
    await this.mail.send(message);
  }
}
