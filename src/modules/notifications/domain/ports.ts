// Lo que los avisos necesitan de fuera. Sin NestJS, sin Fastify, sin `pg`, sin `http2`.

import type { Channel, Kind, Notification } from './notification';

export type DeviceRow = { id: string; token: string; platform: 'ios' | 'android' };

/**
 * Qué dijo el proveedor de un token. Las tres son tres caminos distintos y por eso no es un
 * booleano:
 *   · `ok` → entregado al proveedor;
 *   · `gone` → ese token ya no existe (`410 Unregistered` de APNs, `UNREGISTERED` de FCM) y se
 *     BORRA en el acto, que es la higiene que evita el estrangulamiento;
 *   · `failed` → otra cosa (red, 5xx, credencial): se cuenta y se reintenta.
 */
export type PushResult = { outcome: 'ok' | 'gone' | 'failed'; reason?: string };

export interface PushPort {
  /** La plataforma que este remitente atiende. */
  readonly platform: 'ios' | 'android';
  send(
    device: DeviceRow,
    message: { title: string; body: string; data: Record<string, unknown> },
  ): Promise<PushResult>;
}

export type EnqueueDraft = {
  practiceId: string;
  accountId: string;
  kind: Kind;
  channel: Channel;
  subjectKey: string;
  data: Record<string, unknown>;
  dedupeKey: string;
  sendAfter: Date | null;
};

export type AppointmentToRemind = {
  appointmentId: string;
  practiceId: string;
  accountId: string;
  email: string;
  startsAt: Date;
  requiresConsent: boolean;
  hasConsent: boolean;
};

export type PatientToReturn = {
  practiceId: string;
  accountId: string;
  email: string;
  treatmentId: string;
  dueOn: string;
};

export interface OutboxPort {
  /** Encola desde un TRABAJO: sin contexto de inquilino. Devuelve `false` si ya estaba. */
  enqueueAsJob(draft: EnqueueDraft): Promise<boolean>;
  due(limit: number, maxAttempts: number): Promise<readonly Notification[]>;
  devicesOf(accountId: string): Promise<readonly DeviceRow[]>;
  emailOf(accountId: string): Promise<string | null>;
  sent(id: string): Promise<void>;
  failed(id: string, reason: string, maxAttempts: number): Promise<number>;
  dropped(id: string, reason: string): Promise<void>;
  deviceFailed(deviceId: string): Promise<void>;
  deviceGone(deviceId: string): Promise<void>;
  sweepStaleDevices(days: number, limit: number): Promise<number>;
  /** La retención de la propia bandeja: lo cerrado y viejo se va. */
  purgeSent(days: number, limit: number): Promise<number>;
  appointmentsToRemind(hours: number, windowMinutes: number): Promise<readonly AppointmentToRemind[]>;
  patientsToReturn(limit: number): Promise<readonly PatientToReturn[]>;
}
