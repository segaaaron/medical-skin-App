// El correo del reenvío de la consola · `cuentas.md` · «Va a su propio correo. Soporte no la
// ve.»
//
// EL MISMO ASUNTO que los otros dos, «Tu acceso a MedSkin» y nada más: lo que se lee en la
// pantalla bloqueada del teléfono no dice quién pidió el reenvío, ni de qué clínica es, ni
// que soporte estuvo en medio (§11.1). Lo que cambia es el cuerpo, que es el único de los
// cuatro que no se presenta en nombre de nadie: soporte no puede leer quién es su doctora.
//
// Texto plano, sin HTML y sin imagen de seguimiento, como el de la paciente y el de
// recuperación: un correo con imagen le diría al remitente cuándo y desde dónde se abrió.

import { MailMessage, type MailPort } from '../../../shared/mail/mailer';
import { platformAccessMailBody, type PlatformDeliveryFacts } from '../domain/access-delivery';
import type { PlatformAccessMailPort } from '../domain/ports';
import { ACCESS_SUBJECT } from './patient-access-mail';

export class PlatformAccessMail implements PlatformAccessMailPort {
  constructor(private readonly mail: MailPort) {}

  async sendAccess(facts: PlatformDeliveryFacts): Promise<void> {
    const message: MailMessage = {
      to: facts.email,
      subject: ACCESS_SUBJECT,
      text: platformAccessMailBody(facts),
    };
    await this.mail.send(message);
  }
}
