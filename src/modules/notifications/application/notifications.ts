// LOS TRABAJOS DE AVISOS · los ocho que `cuidados.md` contrata, en cuatro pasadas.
//
//   · `send()`         — «Enviar push» y «Enviar correo», desde la bandeja de salida, en lotes.
//   · `remind()`       — «Recordatorio de cita» a 24 h y 2 h, y el consentimiento por firmar.
//   · `callBack()`     — «Aviso de que toca volver», al cumplirse el intervalo del tratamiento.
//   · `sweepTokens()`  — «Marcar tokens obsoletos», 90 días sin refrescar.
//
// Los otros dos —«Programar el plan de cuidados» y «Preparación previa»— no son pasadas: se
// encolan en la MISMA TRANSACCIÓN del hecho que los origina (firmar la nota, agendar la cita),
// y eso es la razón de ser de una bandeja de salida. Un aviso que se encola después del
// `COMMIT` es un aviso que se pierde cuando el proceso muere en medio; uno que se encola dentro
// se pierde solo si se pierde el hecho, y entonces no había nada que avisar.
//
// Y «limpiar tokens caídos» tampoco es una pasada: ocurre al LEER la respuesta del proveedor,
// que es el único momento en que se sabe que un token murió.

import type { Notification } from '../domain/notification';
import { dedupe, textOf } from '../domain/notification';
import type { OutboxPort, PushPort } from '../domain/ports';

export interface MailPort {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

export interface ClockPort {
  now(): Date;
}

/**
 * Tres intentos, y después la fila queda `fallido` con su motivo. El cuarto no cambiaría nada:
 * si APNs rechaza la credencial, rechazará la cuarta igual, y lo que hace falta es que se vea.
 */
export const MAX_ATTEMPTS = 3;

/** «Lotes de 500» (`cuidados.md`). Es el tope de una pasada, no de la cola. */
export const BATCH = 500;

export type SendResult = { sent: number; failed: number; dropped: number };

export class Notifications {
  /** Los remitentes de push por plataforma. Vacío en desarrollo: no hay credenciales. */
  private readonly push: ReadonlyMap<string, PushPort>;

  constructor(
    private readonly outbox: OutboxPort,
    senders: readonly PushPort[],
    private readonly mail: MailPort | null,
    private readonly clock: ClockPort,
  ) {
    this.push = new Map(senders.map((sender) => [sender.platform, sender]));
  }

  /**
   * UNA PASADA DE LA BANDEJA. Devuelve lo que hizo, para que quien la programe sepa si queda
   * trabajo.
   *
   * Lo que NO hace: tocar una fila cuyo canal no tiene remitente configurado. En desarrollo no
   * hay credenciales de APNs ni de FCM, y la fila se queda `pendiente` en vez de gastar sus
   * tres intentos contra un canal que no existe. Un aviso sin mandar es un aviso sin mandar;
   * marcarlo fallido porque el entorno no está configurado sería perderlo.
   */
  async send(limit = BATCH): Promise<SendResult> {
    const due = await this.outbox.due(limit, MAX_ATTEMPTS);
    const result: SendResult = { sent: 0, failed: 0, dropped: 0 };

    for (const notification of due) {
      if (notification.channel === 'correo') {
        if (this.mail === null) continue;
        await this.sendMail(notification, result);
        continue;
      }
      if (this.push.size === 0) continue;
      await this.sendPush(notification, result);
    }
    return result;
  }

  /**
   * «Recordatorio de cita 24 h y 2 h antes», y en el de 24 h viaja también el consentimiento
   * pendiente: es el momento en que todavía se puede firmar sin perder tiempo en la consulta.
   *
   * Push Y CORREO para el recordatorio, que es lo que el contrato decidió el 28 de octubre al
   * quitar el WhatsApp de MedSkin: «es el que genera la re-reserva, y por eso se le da a la
   * doctora la vía que de verdad se lee».
   */
  async remind(windowMinutes = 10): Promise<number> {
    let queued = 0;
    for (const hours of [24, 2] as const) {
      const pending = await this.outbox.appointmentsToRemind(hours, windowMinutes);
      for (const appointment of pending) {
        const data = { cita_id: appointment.appointmentId, empieza_en: appointment.startsAt.toISOString() };
        const subject = hours === 24 ? 'cita_24h' : 'cita_2h';

        if (await this.enqueue(appointment.practiceId, appointment.accountId, {
          kind: 'recordatorio_cita',
          channel: 'push',
          subjectKey: subject,
          data,
          dedupeKey: dedupe(['cita', appointment.appointmentId, hours, 'push']),
        })) queued += 1;

        if (hours === 24) {
          if (await this.enqueue(appointment.practiceId, appointment.accountId, {
            kind: 'recordatorio_cita',
            channel: 'correo',
            subjectKey: subject,
            data,
            dedupeKey: dedupe(['cita', appointment.appointmentId, hours, 'correo']),
          })) queued += 1;

          // El consentimiento que todavía no firmó, y solo si su tratamiento lo exige.
          if (appointment.requiresConsent && !appointment.hasConsent) {
            if (await this.enqueue(appointment.practiceId, appointment.accountId, {
              kind: 'consentimiento_por_firmar',
              channel: 'push',
              subjectKey: 'consentimiento',
              data,
              dedupeKey: dedupe(['consentimiento', appointment.appointmentId]),
            })) queued += 1;
          }
        }
      }
    }
    return queued;
  }

  /** «Aviso de que toca volver», con el tratamiento para que la app abra sus huecos. */
  async callBack(limit = 200): Promise<number> {
    const pending = await this.outbox.patientsToReturn(limit);
    let queued = 0;
    for (const patient of pending) {
      const data = { tratamiento_id: patient.treatmentId, desde: patient.dueOn };
      // La clave lleva la FECHA en que tocaba: si la paciente no vuelve en seis meses, el aviso
      // no se repite cada día, y si vuelve y hace otra sesión, el siguiente tiene otra fecha y
      // sí sale.
      const key = dedupe(['volver', patient.accountId, patient.treatmentId, patient.dueOn]);
      if (await this.enqueue(patient.practiceId, patient.accountId, {
        kind: 'toca_volver',
        channel: 'push',
        subjectKey: 'toca_volver',
        data,
        dedupeKey: `${key}:push`,
      })) queued += 1;
      if (await this.enqueue(patient.practiceId, patient.accountId, {
        kind: 'toca_volver',
        channel: 'correo',
        subjectKey: 'toca_volver',
        data,
        dedupeKey: `${key}:correo`,
      })) queued += 1;
    }
    return queued;
  }

  /** «Marcar tokens obsoletos», diario: 90 días sin refrescar. */
  async sweepTokens(days = 90): Promise<number> {
    return this.outbox.sweepStaleDevices(days, 1_000);
  }

  /**
   * LA RETENCIÓN DE LA BANDEJA, diaria. Una fila enviada se queda 90 días —lo que hace falta
   * para responder «esto se te mandó el día 3 a las 9:14»— y después se va. Sin esto la tabla
   * crece sin fin, y mil filas `incidencia` de una cuenta dicen demasiado aunque ninguna lleve
   * un dato clínico dentro.
   */
  async purgeSent(days = 90): Promise<number> {
    return this.outbox.purgeSent(days, 5_000);
  }

  // -----------------------------------------------------------------------------------

  private async enqueue(
    practiceId: string,
    accountId: string,
    draft: Omit<Parameters<OutboxPort['enqueueAsJob']>[0], 'practiceId' | 'accountId' | 'sendAfter'>,
  ): Promise<boolean> {
    return this.outbox.enqueueAsJob({
      ...draft,
      practiceId,
      accountId,
      sendAfter: this.clock.now(),
    });
  }

  private async sendPush(notification: Notification, result: SendResult): Promise<void> {
    const devices = await this.outbox.devicesOf(notification.accountId);
    if (devices.length === 0) {
      // DESCARTADO, no fallido: sin dispositivo con permiso no hay nada que reintentar, y
      // gastar tres intentos en eso ensucia la cola de fallidos, que es la que alguien mira.
      await this.outbox.dropped(notification.id, 'la cuenta no tiene dispositivo con permiso');
      result.dropped += 1;
      return;
    }

    const text = textOf(notification.subjectKey);
    let delivered = 0;
    let tried = 0;
    let lastReason = 'ningún dispositivo aceptó el aviso';

    for (const device of devices) {
      const sender = this.push.get(device.platform);
      // SIN REMITENTE PARA ESA PLATAFORMA NO SE INTENTÓ NADA, y eso no es un fallo: es que
      // falta una credencial. Contarlo como fallo gastaba los tres intentos de la fila y
      // mataba el aviso —si solo hay APNs configurado, todos los tokens de Android—.
      if (sender === undefined) continue;

      tried += 1;
      const sent = await sender.send(device, { ...text, data: notification.data });
      if (sent.outcome === 'ok') {
        delivered += 1;
        continue;
      }
      lastReason = sent.reason ?? sent.outcome;
      // La higiene de tokens, que es lo que el tramo 7 escribió en un comentario y nadie hacía.
      if (sent.outcome === 'gone') await this.outbox.deviceGone(device.id);
      else await this.outbox.deviceFailed(device.id);
    }

    if (delivered > 0) {
      await this.outbox.sent(notification.id);
      result.sent += 1;
      return;
    }
    // Ni un intento: la fila se queda pendiente tal cual, sin gastar nada. El arrendamiento de
    // `medskin_notifications_due` la devuelve en cinco minutos, y cuando la credencial exista
    // saldrá sola.
    if (tried === 0) return;

    await this.outbox.failed(notification.id, lastReason, MAX_ATTEMPTS);
    result.failed += 1;
  }

  private async sendMail(notification: Notification, result: SendResult): Promise<void> {
    const to = await this.outbox.emailOf(notification.accountId);
    if (to === null) {
      await this.outbox.dropped(notification.id, 'la cuenta no tiene correo activo');
      result.dropped += 1;
      return;
    }

    const text = textOf(notification.subjectKey);
    try {
      // El ASUNTO es la frase neutra del contrato: «el asunto es lo que se lee en la pantalla
      // bloqueada del teléfono» (§11.1), así que un correo no es menos público que un push.
      await this.mail!.send({ to, subject: text.title, text: `${text.body}\n` });
      await this.outbox.sent(notification.id);
      result.sent += 1;
    } catch (cause) {
      await this.outbox.failed(
        notification.id,
        cause instanceof Error ? cause.message : String(cause),
        MAX_ATTEMPTS,
      );
      result.failed += 1;
    }
  }
}
