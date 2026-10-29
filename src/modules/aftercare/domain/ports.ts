// Lo que los cuidados necesitan de fuera. Sin NestJS, sin Fastify, sin `pg`.

export type AftercareCaller = {
  accountId: string;
  practiceId: string | null;
  permissions: readonly string[];
  isPatient: boolean;
};

export type CareStepRow = { id: string; appearsAt: Date; text: string; doneAt: Date | null };

export type CarePlanRow = {
  id: string;
  practiceName: string;
  treatmentName: string;
  sessionAt: Date;
  steps: readonly CareStepRow[];
};

export type ThreadRow = { id: string; closedAt: Date | null };

export type MessageRow = {
  id: string;
  author: string;
  body: string;
  createdAt: Date;
  readAt: Date | null;
};

export type Preferences = {
  appointments: boolean;
  care: boolean;
  promotions: boolean;
  quietFrom: string | null;
  quietTo: string | null;
};

export interface AftercarePort {
  plans(caller: AftercareCaller, patientId: string | null): Promise<readonly CarePlanRow[]>;
  markStep(
    caller: AftercareCaller,
    stepId: string,
    p: { doneAt: Date; now: Date },
  ): Promise<{ outcome: 'done' | 'no_step' | 'future' }>;
  trafficLight(
    caller: AftercareCaller,
    sessionId: string,
  ): Promise<readonly { day: number; normal: string; callIf: string }[] | null>;
  reportIncident(
    caller: AftercareCaller,
    p: {
      sessionId: string;
      what: string;
      since: string | null;
      perceived: string;
      photoIds: readonly string[];
    },
  ): Promise<{
    outcome: 'received' | 'no_session';
    id: string | null;
    practitioner: string | null;
    phone: string | null;
  }>;
  thread(
    caller: AftercareCaller,
    p: { patientId: string; practiceId: string },
  ): Promise<ThreadRow | 'revoked'>;
  messages(
    caller: AftercareCaller,
    threadId: string,
    before: Date | null,
  ): Promise<readonly MessageRow[]>;
  send(
    caller: AftercareCaller,
    threadId: string,
    body: string,
  ): Promise<{ outcome: 'sent' | 'too_many'; id: string | null }>;
  registerDevice(
    caller: AftercareCaller,
    p: {
      deviceId: string;
      token: string;
      platform: string;
      appVersion: string | null;
      permission: string;
    },
  ): Promise<void>;
  forgetDevice(caller: AftercareCaller, deviceId: string): Promise<boolean>;
  preferences(caller: AftercareCaller): Promise<Preferences>;
  savePreferences(
    caller: AftercareCaller,
    p: {
      appointments?: boolean;
      care?: boolean;
      promotions?: boolean;
      quietFrom?: string | null;
      quietTo?: string | null;
    },
  ): Promise<Preferences>;
  linkedPatient(
    accountId: string,
    practiceId: string,
  ): Promise<{ patientId: string } | 'invitada' | 'revocada' | null>;
}
