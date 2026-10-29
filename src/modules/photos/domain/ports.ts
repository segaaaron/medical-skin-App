// Lo que las fotos necesitan de fuera. Sin NestJS, sin Fastify, sin `pg`.

import type { SignedUrl } from '../../../shared/storage/signed-url';
import type { UploadRequest } from './photos';

export type PhotoCaller = {
  accountId: string;
  practiceId: string | null;
  permissions: readonly string[];
  isPatient: boolean;
  /** La maestra la abre SOLO la doctora: ni la paciente, ni el asistente. */
  isDoctor: boolean;
};

export type PhotoRow = {
  id: string;
  practiceId: string;
  patientId: string;
  sessionId: string | null;
  view: string;
  status: string;
  uploadedBy: string;
  takenAt: Date | null;
  camera: string | null;
  iso: number | null;
  failedReason: string | null;
  derivativesReady: boolean;
  masterFormat: string | null;
};

export interface PhotoPort {
  uploadUrl(
    caller: PhotoCaller,
    p: { request: UploadRequest; patientId: string; practiceId: string; now: Date },
  ): Promise<{
    outcome: 'signed' | 'no_consent' | 'over_quota';
    photoId: string | null;
    upload: SignedUrl | null;
  }>;
  confirm(
    caller: PhotoCaller,
    photoId: string,
    now: Date,
  ): Promise<{ outcome: 'queued' | 'not_uploaded' | 'already' | 'no_photo'; row: PhotoRow | null }>;
  list(
    caller: PhotoCaller,
    p: { patientId: string; sessionId: string | null; view: string | null; now: Date },
  ): Promise<readonly (PhotoRow & { links: Record<string, SignedUrl> })[]>;
  one(caller: PhotoCaller, photoId: string): Promise<PhotoRow | null>;
  master(
    caller: PhotoCaller,
    photoId: string,
    now: Date,
  ): Promise<{ outcome: 'signed' | 'no_photo' | 'cold'; url: SignedUrl | null }>;
  compare(
    caller: PhotoCaller,
    photoId: string,
    withPhotoId: string | null,
    now: Date,
  ): Promise<
    | {
        outcome: 'paired';
        view: string;
        pair: readonly { id: string; takenAt: Date | null; full: SignedUrl }[];
      }
    | { outcome: 'no_photo' | 'different_views' | 'not_ready' }
  >;
  reprocess(caller: PhotoCaller, photoId: string): Promise<boolean>;
  remove(
    caller: PhotoCaller,
    photoId: string,
    reason: string | null,
    now: Date,
  ): Promise<{ outcome: 'deleted' | 'no_photo' | 'not_yours' | 'in_signed_session' }>;
  linkedPatient(
    accountId: string,
    practiceId: string,
  ): Promise<{ patientId: string } | 'invitada' | null>;
}
