// El correo del acceso del equipo · `POST /v1/team`. «El acceso del equipo sale solo por
// correo: no hay `wa.me` aquí.»
//
// MISMO MECANISMO Y MISMO ASUNTO que el de la paciente: el `MailPort` de siempre y «Tu
// acceso a MedSkin», que es lo que se lee en la pantalla bloqueada del teléfono (§11.1). Lo
// único propio es la plantilla, que vive en el dominio para poder probar lo que dice sin
// levantar un SMTP. Texto plano, sin HTML y sin imagen de seguimiento.

import { MailMessage, type MailPort } from '../../../shared/mail/mailer';
import { teamAccessMailBody, type TeamDeliveryFacts } from '../domain/access-delivery';
import type { TeamAccessMailPort } from '../domain/ports';
import { ACCESS_SUBJECT } from './patient-access-mail';

export class TeamAccessMail implements TeamAccessMailPort {
  constructor(private readonly mail: MailPort) {}

  async sendTeamAccess(facts: TeamDeliveryFacts): Promise<void> {
    const message: MailMessage = {
      to: facts.email,
      subject: ACCESS_SUBJECT,
      text: teamAccessMailBody(facts),
    };
    await this.mail.send(message);
  }
}
