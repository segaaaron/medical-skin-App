// El correo. En desarrollo lo atrapa el Mailpit nativo de la máquina (SMTP 1025, panel en
// 8025); en producción el relé que diga el despliegue.
//
// La regla del producto, y no es negociable: NINGÚN dato clínico sale en una notificación,
// en el asunto de un correo, en una URL ni en un mensaje de error. El asunto es lo que se
// lee en la pantalla bloqueada del teléfono (§11.1), así que el asunto se escribe en el
// contrato y aquí solo se manda.
//
// Puerto pequeño a propósito: añadir un canal —APNs, FCM, WhatsApp— es otra implementación
// de un puerto como este, no un `switch` nuevo en el caso de uso.

import nodemailer, { type Transporter } from 'nodemailer';

import { config, type Config } from '../config/config';

export type MailMessage = {
  to: string;
  /** El asunto literal del contrato. Nada clínico, nunca. */
  subject: string;
  text: string;
};

export interface MailPort {
  send(message: MailMessage): Promise<void>;
}

export class SmtpMail implements MailPort {
  private readonly transport: Transporter;

  constructor(private readonly cfg: Config = config()) {
    this.transport = nodemailer.createTransport({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT,
      secure: cfg.SMTP_SECURE,
      // Los tres topes, porque hay un envío que pasa DENTRO del ciclo de la petición —el
      // acceso de una paciente por correo— y los valores por omisión de nodemailer son de
      // un trabajador: 2 min para conectar y 10 para el socket. Un relé que acepta la
      // conexión y se queda callado dejaría a la doctora esperando diez minutos en vez de
      // darle el 500 con su salida. Para el trabajador de recuperación es igual de bueno:
      // falla antes y BullMQ reintenta.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      ...(cfg.SMTP_USER ? { auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASSWORD ?? '' } } : {}),
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.cfg.CORREO_REMITENTE,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}
