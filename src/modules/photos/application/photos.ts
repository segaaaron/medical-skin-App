// Los siete endpoints de las fotos. Ninguno toca un byte de imagen.

import { ContractError } from '../../../shared/contract/error-catalog';
import type { SignedUrl } from '../../../shared/storage/signed-url';
import type { Caller } from '../../access/application/caller';
import { MAX_BYTES, readUploadRequest } from '../domain/photos';
import type { PhotoCaller, PhotoPort, PhotoRow } from '../domain/ports';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClockPort {
  now(): Date;
}

export class Photos {
  constructor(
    private readonly photos: PhotoPort,
    private readonly clock: ClockPort,
  ) {}

  async uploadUrl(input: unknown, caller: Caller): Promise<unknown> {
    const request = readUploadRequest(input);
    const { asking, practiceId, patientId } = await this.who(caller, {
      practiceId: request.practiceId,
      patientId: request.patientId,
      permission: 'sesiones:registrar',
    });

    const signed = await this.photos.uploadUrl(asking, {
      request,
      patientId,
      practiceId,
      now: this.clock.now(),
    });
    if (signed.outcome === 'no_consent') {
      throw new ContractError('sin_consentimiento_de_imagenes');
    }
    if (signed.outcome === 'over_quota') throw new ContractError('cuota_de_la_consulta');

    return {
      photo_id: signed.photoId,
      subida: {
        url: signed.upload!.url,
        metodo: 'PUT',
        cabeceras: { 'Content-Type': request.declaredType },
        caduca_en: signed.upload!.expiresAt.toISOString(),
        // Lo aplica el propio almacenamiento, no la API: «un límite que solo vive en nuestro
        // código es un límite que no existe para quien tiene la URL firmada».
        bytes_maximos: MAX_BYTES,
      },
      estado: 'esperando_subida',
    };
  }

  async confirm(photoId: string, caller: Caller): Promise<unknown> {
    const asking = this.reader(caller, 'sesiones:registrar');
    checkUuid(photoId);

    const confirmed = await this.photos.confirm(asking, photoId, this.clock.now());
    if (confirmed.outcome === 'no_photo') throw new ContractError('foto_no_existe');
    if (confirmed.outcome === 'not_uploaded') throw new ContractError('no_se_subio');
    if (confirmed.outcome === 'already') throw new ContractError('ya_confirmada');

    const row = confirmed.row!;
    return {
      photo_id: row.id,
      estado: row.status,
      derivadas: { thumb: null, view: null, full: null },
      // La metadata útil, leída del archivo y guardada en la base, con el GPS ya descartado. La
      // llena el trabajador: aquí viaja lo que haya.
      captura: { tomada_en: row.takenAt?.toISOString() ?? null, camara: row.camera, iso: row.iso },
    };
  }

  async list(query: Record<string, unknown>, caller: Caller): Promise<unknown> {
    const { asking, patientId } = await this.who(caller, {
      practiceId: text(query.practice_id),
      patientId: text(query.patient_id ?? query.paciente_id),
      permission: 'historia:leer',
    });

    const rows = await this.photos.list(asking, {
      patientId,
      sessionId: text(query.session_id ?? query.sesion_id),
      view: text(query.view ?? query.vista),
      now: this.clock.now(),
    });

    return {
      fotos: rows.map((row) => ({
        id: row.id,
        vista: row.view,
        tomada_en: row.takenAt?.toISOString() ?? null,
        session_id: row.sessionId,
        subida_por: row.uploadedBy,
        estado: row.status,
        // Una `fallida` dice el motivo real Y que la original está guardada.
        ...(row.failedReason === null ? {} : { motivo: row.failedReason }),
        enlaces: Object.fromEntries(
          Object.entries(row.links).map(([name, link]) => [
            name,
            { url: link.url, caduca_en: link.expiresAt.toISOString() },
          ]),
        ),
      })),
    };
  }

  /** La maestra: SOLO la doctora. Ni la paciente, ni el asistente. */
  async master(photoId: string, caller: Caller): Promise<unknown> {
    const asking = this.reader(caller, 'historia:leer');
    if (!asking.isDoctor) {
      throw new ContractError(
        'sin_permiso',
        undefined,
        'Solo la doctora puede abrir la foto original.',
      );
    }
    checkUuid(photoId);

    const signed = await this.photos.master(asking, photoId, this.clock.now());
    if (signed.outcome === 'no_photo') throw new ContractError('foto_no_existe');
    if (signed.outcome === 'cold') throw new ContractError('maestra_en_almacenamiento_frio');
    return linkView(signed.url!);
  }

  async compare(photoId: string, query: Record<string, unknown>, caller: Caller): Promise<unknown> {
    // La paciente SÍ entra: «es lo que vuelve adictivo el progreso» (§6.2 punto 2).
    const asking = this.reader(caller, 'historia:leer');
    checkUuid(photoId);

    const compared = await this.photos.compare(
      asking,
      photoId,
      text(query.con ?? query.with),
      this.clock.now(),
    );
    if (compared.outcome === 'no_photo') throw new ContractError('foto_no_existe');
    if (compared.outcome === 'different_views') throw new ContractError('vistas_distintas');
    if (compared.outcome !== 'paired') throw new ContractError('foto_no_lista');

    const [before, after] = compared.pair;
    const days =
      before?.takenAt && after?.takenAt
        ? Math.round((after.takenAt.getTime() - before.takenAt.getTime()) / 86_400_000)
        : null;

    return {
      vista: compared.view,
      par: compared.pair.map((photo) => ({
        id: photo.id,
        tomada_en: photo.takenAt?.toISOString().slice(0, 10) ?? null,
        full: linkView(photo.full),
      })),
      dias_entre: days,
    };
  }

  async reprocess(photoId: string, caller: Caller): Promise<unknown> {
    const asking = this.reader(caller, 'sesiones:registrar');
    checkUuid(photoId);
    const done = await this.photos.reprocess(asking, photoId);
    if (!done) throw new ContractError('foto_no_existe');
    return { estado: 'procesando' };
  }

  async remove(photoId: string, input: unknown, caller: Caller): Promise<unknown> {
    const asking = this.reader(caller, 'historia:leer');
    checkUuid(photoId);
    // Borrar del expediente lo pide la DUEÑA; la paciente solo las que subió ella, y eso lo
    // decide el repositorio con `uploaded_by`.
    if (!asking.isPatient && !asking.isDoctor) {
      throw new ContractError(
        'sin_permiso',
        undefined,
        'Solo la dueña de la consulta puede borrar fotos del expediente.',
      );
    }

    const body = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    const removed = await this.photos.remove(
      asking,
      photoId,
      text(body.motivo),
      this.clock.now(),
    );
    if (removed.outcome === 'no_photo') throw new ContractError('foto_no_existe');
    if (removed.outcome === 'not_yours') throw new ContractError('foto_de_la_doctora');
    if (removed.outcome === 'in_signed_session') throw new ContractError('en_una_sesion_firmada');
    return { borrada: true };
  }

  /**
   * Quién pregunta y sobre qué ficha. Para la paciente, la consulta y la ficha salen LOS DOS
   * de su `patient_link`: ningún identificador del cuerpo elige en qué ficha se escribe.
   */
  private async who(
    caller: Caller,
    p: { practiceId: string | null; patientId: string | null; permission: string },
  ): Promise<{ asking: PhotoCaller; practiceId: string; patientId: string }> {
    if (caller.accountRole === 'paciente') {
      if (p.practiceId === null) throw new ContractError('vinculo_no_existe');
      const link = await this.photos.linkedPatient(caller.accountId, p.practiceId);
      if (link === null) throw new ContractError('vinculo_no_existe');
      if (link === 'invitada') throw new ContractError('vinculo_sin_aceptar');
      return {
        asking: {
          accountId: caller.accountId,
          practiceId: null,
          permissions: [],
          isPatient: true,
          isDoctor: false,
        },
        practiceId: p.practiceId,
        patientId: link.patientId,
      };
    }

    const asking = this.reader(caller, p.permission);
    if (p.patientId === null || !UUID.test(p.patientId)) {
      throw new ContractError('paciente_no_existe');
    }
    return { asking, practiceId: asking.practiceId!, patientId: p.patientId };
  }

  private reader(caller: Caller, permission: string): PhotoCaller {
    if (caller.accountRole === 'paciente') {
      return {
        accountId: caller.accountId,
        practiceId: null,
        permissions: [],
        isPatient: true,
        isDoctor: false,
      };
    }
    if (caller.practiceId === null || !caller.permissions.includes(permission)) {
      throw new ContractError(
        'sin_permiso',
        undefined,
        'Recepción no puede ver las fotos de una paciente.',
      );
    }
    return {
      accountId: caller.accountId,
      practiceId: caller.practiceId,
      permissions: caller.permissions,
      isPatient: false,
      isDoctor: caller.role === 'doctora',
    };
  }
}

function linkView(link: SignedUrl) {
  return { url: link.url, caduca_en: link.expiresAt.toISOString() };
}

function checkUuid(id: string): void {
  if (!UUID.test(id)) throw new ContractError('foto_no_existe');
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export type { PhotoRow };
