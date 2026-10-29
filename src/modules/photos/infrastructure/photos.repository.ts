// Las fotos contra la base y contra el almacenamiento.
//
// LA API NO TOCA UN SOLO BYTE DE IMAGEN. Lo que hace es firmar enlaces, guardar estado y mirar
// si el objeto llegó. Validar, quitar el GPS y derivar son trabajos de cola, y ninguno ocurre
// dentro del ciclo de la petición.

import type { Pool, PoolClient } from 'pg';

import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import { EXPIRY, KEYS, signUrl, type SignedUrl, type StorageConfig } from '../../../shared/storage/signed-url';
import type { PhotoCaller, PhotoPort, PhotoRow } from '../domain/ports';
import type { UploadRequest } from '../domain/photos';

function contextOf(caller: PhotoCaller): TenantContext {
  if (caller.isPatient) return { role: 'app_patient', accountId: caller.accountId };
  return { role: 'app_practitioner', practiceId: caller.practiceId, accountId: caller.accountId };
}

const PHOTO_SELECT = `
  select p.id, p.practice_id, p.patient_id, p.session_id, p.view, p.status, p.uploaded_by,
         p.taken_at, p.camera, p.iso, p.failed_reason, p.derivatives_ready, p.master_format,
         p.deleted_at
    from photo p`;

export class PhotosRepository implements PhotoPort {
  constructor(
    private readonly pool: Pool,
    private readonly storage: StorageConfig,
  ) {}

  async uploadUrl(
    caller: PhotoCaller,
    p: { request: UploadRequest; patientId: string; practiceId: string; now: Date },
  ): Promise<{ outcome: 'signed' | 'no_consent' | 'over_quota'; photoId: string | null; upload: SignedUrl | null }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // «Bloquea la firma, no la captura»: la app ya tiene la foto cifrada en el teléfono, y lo
      // que se frena es que SALGA de ahí. Es la única forma de que el consentimiento signifique
      // algo.
      const { rows: consents } = await c.query(
        `select 1 from consent
          where patient_id = $1 and purpose = 'imagenes' and revoked_at is null`,
        [p.patientId],
      );
      if (consents.length === 0) {
        return { outcome: 'no_consent', photoId: null, upload: null };
      }

      const { rows: quota } = await c.query<{ used: string; limit: number }>(
        `select medskin_practice_photo_bytes($1)::text as used,
                (select patient_limit from practice where id = $1) as limit`,
        [p.practiceId],
      );
      // El cupo de disco por plan: 300 fichas × 35 GB es el presupuesto de `servicios.md`, y el
      // número por plan sale de la fila de la consulta. Mientras no exista esa columna, el
      // tope es el del plan de 1000 y se anota.
      const used = Number(quota[0]?.used ?? 0);
      const cap = (quota[0]?.limit ?? 300) * 120 * 1_600_000;
      if (used >= cap) return { outcome: 'over_quota', photoId: null, upload: null };

      const { rows } = await c.query<{ id: string }>(
        `insert into photo (practice_id, patient_id, session_id, view, uploaded_by,
                            declared_type, declared_bytes, taken_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [
          p.practiceId,
          p.patientId,
          p.request.sessionId,
          p.request.view,
          // Lo pone el SERVIDOR y se ignora si viene: decide quién puede borrarla después.
          caller.isPatient ? 'paciente' : 'doctora',
          p.request.declaredType,
          p.request.declaredBytes,
          p.request.takenAt,
        ],
      );
      const photoId = rows[0]!.id;

      return {
        outcome: 'signed',
        photoId,
        upload: signUrl(this.storage, {
          method: 'PUT',
          key: KEYS.upload(photoId),
          expiresInSeconds: EXPIRY.upload,
          now: p.now,
          contentType: p.request.declaredType,
        }),
      };
    });
  }

  async confirm(
    caller: PhotoCaller,
    photoId: string,
    now: Date,
  ): Promise<{ outcome: 'queued' | 'not_uploaded' | 'already' | 'no_photo'; row: PhotoRow | null }> {
    const found = await withTenantContext(this.pool, contextOf(caller), async (c) =>
      this.readOne(c, photoId),
    );
    if (found === null) return { outcome: 'no_photo', row: null };
    // Ya confirmada: «nada, la app sigue».
    if (found.status !== 'esperando_subida') return { outcome: 'already', row: found };

    // ¿Llegó el objeto? Se pregunta al almacenamiento con un `GET` firmado de un segundo: la
    // API no lo descarga, solo mira que esté.
    const head = signUrl(this.storage, {
      method: 'GET',
      key: KEYS.upload(photoId),
      expiresInSeconds: 60,
      now,
    });
    const response = await fetch(head.url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
    if (!response.ok && response.status !== 206) {
      return { outcome: 'not_uploaded', row: found };
    }
    void (await response.arrayBuffer());

    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // `procesando`: el trabajo de validación lo toma desde aquí. La app puede borrar su copia
      // local en cuanto recibe este 200.
      await c.query(
        `update photo set status = 'procesando', updated_at = now()
          where id = $1 and status = 'esperando_subida'`,
        [photoId],
      );
      return { outcome: 'queued', row: await this.readOne(c, photoId) };
    });
  }

  async list(
    caller: PhotoCaller,
    p: { patientId: string; sessionId: string | null; view: string | null; now: Date },
  ): Promise<readonly (PhotoRow & { links: Record<string, SignedUrl> })[]> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query<Record<string, unknown>>(
        `${PHOTO_SELECT}
          where p.patient_id = $1 and p.deleted_at is null
            and ($2::uuid is null or p.session_id = $2)
            and ($3::text is null or p.view = $3)
          order by p.taken_at desc nulls first, p.created_at desc`,
        [p.patientId, p.sessionId, p.view],
      );

      // Abrir las fotos de una ficha queda en la auditoría, igual que abrir la ficha.
      await c.query(
        `insert into access_audit (practice_id, actor_account_id, action, subject_type,
                                   subject_id, data)
         values (coalesce(medskin_current_practice(), $3), $1, 'paciente.fotos_abiertas',
                 'paciente', $2, '{}')`,
        [caller.accountId, p.patientId, rows[0]?.practice_id ?? null],
      );

      return rows.map((row) => {
        const photo = mapPhoto(row);
        // `full` NO viaja en la lista: son 450 KB por foto y una cuadrícula no los necesita.
        const links: Record<string, SignedUrl> = {};
        if (photo.status === 'lista') {
          links.thumb = this.sign(photo.id, 'thumb', p.now);
          links.view = this.sign(photo.id, 'view', p.now);
        }
        return { ...photo, links };
      });
    });
  }

  async one(caller: PhotoCaller, photoId: string): Promise<PhotoRow | null> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => this.readOne(c, photoId));
  }

  /** La maestra: dos minutos, y su línea en la auditoría. Es el objeto más sensible. */
  async master(
    caller: PhotoCaller,
    photoId: string,
    now: Date,
  ): Promise<{ outcome: 'signed' | 'no_photo' | 'cold'; url: SignedUrl | null }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const photo = await this.readOne(c, photoId);
      if (photo === null) return { outcome: 'no_photo', url: null };

      await c.query(
        `insert into access_audit (practice_id, actor_account_id, action, subject_type,
                                   subject_id, data)
         values (medskin_current_practice(), $1, 'foto.maestra_abierta', 'foto', $2,
                 jsonb_build_object('paciente_id', $3::text))`,
        [caller.accountId, photoId, photo.patientId],
      );

      return {
        outcome: 'signed',
        url: signUrl(this.storage, {
          method: 'GET',
          key: KEYS.master(photoId),
          expiresInSeconds: EXPIRY.master,
          now,
        }),
      };
    });
  }

  async compare(
    caller: PhotoCaller,
    photoId: string,
    withPhotoId: string | null,
    now: Date,
  ): Promise<
    | { outcome: 'paired'; view: string; pair: readonly { id: string; takenAt: Date | null; full: SignedUrl }[] }
    | { outcome: 'no_photo' | 'different_views' | 'not_ready' }
  > {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const first = await this.readOne(c, photoId);
      if (first === null) return { outcome: 'no_photo' };

      let second: PhotoRow | null = null;
      if (withPhotoId !== null) {
        second = await this.readOne(c, withPhotoId);
        if (second === null) return { outcome: 'no_photo' };
        // «Solo se pueden comparar fotos de la misma vista.»
        if (second.view !== first.view) return { outcome: 'different_views' };
      } else {
        // Sin par explícito: la más antigua de esa vista, que es el «antes» natural.
        const { rows } = await c.query<Record<string, unknown>>(
          `${PHOTO_SELECT}
            where p.patient_id = $1 and p.view = $2 and p.status = 'lista'
              and p.id <> $3 and p.deleted_at is null
            order by p.taken_at asc nulls last limit 1`,
          [first.patientId, first.view, first.id],
        );
        second = rows[0] === undefined ? null : mapPhoto(rows[0]);
      }

      const pair = [second, first].filter((photo): photo is PhotoRow => photo !== null);
      if (pair.some((photo) => photo.status !== 'lista')) return { outcome: 'not_ready' };

      return {
        outcome: 'paired',
        view: first.view,
        // SIEMPRE `full`, nunca `thumb`: una decisión clínica no se toma sobre una miniatura, y
        // por eso el cliente no puede pedir el tamaño.
        pair: pair.map((photo) => ({
          id: photo.id,
          takenAt: photo.takenAt,
          full: this.sign(photo.id, 'full', now),
        })),
      };
    });
  }

  async reprocess(caller: PhotoCaller, photoId: string): Promise<boolean> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // Reprocesar es gratis y seguro: las claves son deterministas, así que el resultado es
      // idéntico. Vuelve a `procesando` y el trabajador la toma otra vez.
      const { rowCount } = await c.query(
        `update photo set status = 'procesando', attempts = 0, failed_reason = null,
                          derivatives_ready = false, updated_at = now()
          where id = $1 and deleted_at is null`,
        [photoId],
      );
      return rowCount === 1;
    });
  }

  async remove(
    caller: PhotoCaller,
    photoId: string,
    reason: string | null,
    now: Date,
  ): Promise<{ outcome: 'deleted' | 'no_photo' | 'not_yours' | 'in_signed_session' }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const photo = await this.readOne(c, photoId);
      if (photo === null) return { outcome: 'no_photo' };
      // «Esa foto la tomó tu doctora en consulta: es parte de tu historia clínica.»
      if (caller.isPatient && photo.uploadedBy !== 'paciente') return { outcome: 'not_yours' };

      if (photo.sessionId !== null) {
        const { rows } = await c.query(
          `select 1 from session_note where session_id = $1 and signed_at is not null`,
          [photo.sessionId],
        );
        // «Esa foto es parte de una sesión ya firmada. Para quitarla, agrega una corrección.»
        if (rows.length > 0) return { outcome: 'in_signed_session' };
      }

      // Queda la fila con su fecha y su motivo: «el expediente dice que hubo una foto y que se
      // borró, porque un hueco sin explicación es peor que el hueco».
      await c.query(
        `update photo set deleted_at = $2, deleted_reason = $3, updated_at = now() where id = $1`,
        [photoId, now, reason],
      );
      // Y los objetos se van de verdad: la maestra es irreversible, y es lo que el contrato
      // promete. Borrar del almacenamiento no bloquea la respuesta.
      // La firma es de `DELETE`: el método entra en la firma, y con la de un `GET` el
      // almacenamiento responde `SignatureDoesNotMatch` —y el `.catch()` se lo comía—.
      // Si alguno no se va, lo recoge la pasada `eraseDeleted()` del trabajador, que mira
      // `deleted_at IS NOT NULL AND purged_at IS NULL`: esto es el camino rápido, no el único.
      for (const key of [KEYS.master(photoId), KEYS.upload(photoId), KEYS.thumb(photoId), KEYS.view(photoId), KEYS.full(photoId)]) {
        const url = signUrl(this.storage, { method: 'DELETE', key, expiresInSeconds: 60, now });
        void fetch(url.url, { method: 'DELETE' }).catch(() => undefined);
      }
      return { outcome: 'deleted' };
    });
  }

  /** El vínculo de la paciente: de ahí salen su inquilino y su ficha, nunca del cuerpo. */
  async linkedPatient(
    accountId: string,
    practiceId: string,
  ): Promise<{ patientId: string } | 'invitada' | null> {
    return withTenantContext(this.pool, { role: 'app_patient', accountId }, async (c) => {
      const { rows } = await c.query<{ patient_id: string; status: string }>(
        `select patient_id, status from patient_link where practice_id = $1`,
        [practiceId],
      );
      const link = rows[0];
      if (link === undefined) return null;
      if (link.status !== 'vinculada') return 'invitada';
      return { patientId: link.patient_id };
    });
  }

  private sign(photoId: string, derivative: 'thumb' | 'view' | 'full', now: Date): SignedUrl {
    return signUrl(this.storage, {
      method: 'GET',
      key: KEYS[derivative](photoId),
      expiresInSeconds: EXPIRY.derivative,
      now,
    });
  }

  private async readOne(c: PoolClient, photoId: string): Promise<PhotoRow | null> {
    const { rows } = await c.query<Record<string, unknown>>(
      `${PHOTO_SELECT} where p.id = $1 and p.deleted_at is null`,
      [photoId],
    );
    return rows[0] === undefined ? null : mapPhoto(rows[0]);
  }
}

function mapPhoto(row: Record<string, unknown>): PhotoRow {
  return {
    id: row.id as string,
    practiceId: row.practice_id as string,
    patientId: row.patient_id as string,
    sessionId: (row.session_id as string | null) ?? null,
    view: row.view as string,
    status: row.status as string,
    uploadedBy: row.uploaded_by as string,
    takenAt: (row.taken_at as Date | null) ?? null,
    camera: (row.camera as string | null) ?? null,
    iso: (row.iso as number | null) ?? null,
    failedReason: (row.failed_reason as string | null) ?? null,
    derivativesReady: row.derivatives_ready as boolean,
    masterFormat: (row.master_format as string | null) ?? null,
  };
}
