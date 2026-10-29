// EL TRABAJADOR DE IMÁGENES. Nada de esto ocurre en el ciclo de la petición (§8.4).
//
// Y ES IDEMPOTENTE POR CONSTRUCCIÓN: reclama el trabajo por el identificador de la foto en la
// base y escribe CLAVES DETERMINISTAS —`<photo_id>/thumb.avif` y las otras tres—, así que un
// trabajador que muere a mitad produce exactamente el mismo resultado al reintentar. No hay
// nombre aleatorio, no hay sufijo con la hora, no hay nada que cambie entre dos intentos.
//
// LO QUE HACE, EN ESTE ORDEN:
//   1 · los BYTES MÁGICOS, antes de decodificar nada;
//   2 · las dimensiones por la cabecera, también antes de decodificar: «una imagen de 200 MP
//       bien formada es un ataque de memoria, no una foto»;
//   3 · la metadata útil a la base y el GPS FUERA del archivo;
//   4 · la maestra, recomprimida solo si la compilación lo permite;
//   5 · las tres derivadas en AVIF.
//
// JPEG XL · MEDIDO OTRA VEZ EL 29 DE OCTUBRE DE 2026, con `sharp` 0.35.5 y libvips 8.18.7
// —la subida que cierra tres CVE de libvips, libheif y librsvg (OWASP A06)—: **sigue sin traer
// libjxl**, ni de entrada ni de salida. HEIF/AVIF sí. Así que la maestra se guarda TAL CUAL y
// se anota en `master_format: 'original'`. Es lo que el contrato manda («nunca se degrada la
// maestra por un problema de codificador») y lo que convierte la pregunta abierta del traspaso
// en un hecho: el presupuesto de disco de la VPS hay que recalcularlo con la foto sin
// recomprimir, no con 1,55 MB.

import type { Pool } from 'pg';
import sharp, { type Metadata } from 'sharp';

import { withTenantContext } from '../../../shared/db/tenant-context';
import type { FailureLog } from '../../../shared/failures/service-failure';
import { KEYS, signUrl, type StorageConfig } from '../../../shared/storage/signed-url';
import { DERIVATIVES, MAX_ATTEMPTS, dimensionsAreSane, typeOfBytes } from '../domain/photos';

/** Si esta compilación de libvips puede escribir JPEG XL. Se pregunta una vez, al arrancar. */
export const JXL_AVAILABLE = sharp.format.jxl?.output?.buffer === true;

export class PhotoWorker {
  constructor(
    private readonly pool: Pool,
    private readonly storage: StorageConfig,
    private readonly failures: FailureLog,
  ) {}

  /**
   * Una pasada. La llama la cola; devuelve cuántas procesó para que quien la programa sepa si
   * queda trabajo. Corre con `medskin_access`, que es el rol de los trabajos: no hay petición y
   * no hay inquilino que fijar.
   */
  async run(limit = 5): Promise<number> {
    // POR FUNCIÓN, y no con `SET ROLE`: `medskin_access` es NOLOGIN y el rol de la aplicación
    // **no puede convertirse en él** —lo intenté y la base lo rechazó, que es justo la
    // garantía—. Lo que el trabajador tiene es `EXECUTE` sobre tres funciones que devuelven
    // identificadores y estado, nunca un byte ni un nombre.
    const rows = await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows: pending } = await c.query<{
        id: string;
        practice_id: string;
        attempts: number;
        patient_id: string;
      }>('select id, practice_id, attempts, patient_id from medskin_photos_pending($1, $2)', [
        limit,
        MAX_ATTEMPTS,
      ]);
      return pending;
    });

    for (const photo of rows) {
      await this.process(photo.id, photo.practice_id, photo.attempts, photo.patient_id);
    }
    return rows.length;
  }

  /**
   * LAS DERIVADAS DE UNA FICHA ARCHIVADA SE BORRAN · hallazgo H-18.
   *
   * `pacientes.md` lo dice desde el principio: «al archivar, las derivadas de sus fotos se
   * borran y la maestra se queda», y se regeneran al reactivarla. Nadie lo hacía: una consulta
   * que archiva 50 fichas al cerrar el año se quedaba con las tres derivadas de cada foto
   * ocupando disco, y eso es crecimiento que el presupuesto de la VPS no contaba.
   *
   * No hace falta tabla nueva: el estado ya está en los datos —`patient.status` y
   * `photo.derivatives_ready`—, y las dos consultas son dos funciones de la 0043. La maestra
   * NO se toca: es la prueba legal del expediente.
   */
  async purgeDerivatives(limit = 25): Promise<number> {
    const photos = await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<{ id: string }>('select id from medskin_photos_to_purge($1)', [
        limit,
      ]);
      return rows;
    });

    const now = new Date();
    for (const photo of photos) {
      for (const derivative of DERIVATIVES) {
        await this.remove(`${photo.id}/${derivative.name}.avif`, now);
      }
      // El sello DESPUÉS de tocar el almacenamiento: si el proceso muere en medio, el siguiente
      // intento vuelve a encontrar la foto y borra lo que quede. Las claves son deterministas,
      // así que borrar lo ya borrado es un 404 que no importa.
      await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) =>
        c.query('select medskin_photo_derivatives($1, false)', [photo.id]),
      );
    }
    return photos.length;
  }

  /** Y el camino de vuelta: reactivar la ficha las regenera desde la maestra. */
  async rebuildDerivatives(limit = 25): Promise<number> {
    const photos = await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        'select id from medskin_photos_to_rebuild($1)',
        [limit],
      );
      return rows;
    });

    const now = new Date();
    for (const photo of photos) {
      const master = await this.download(KEYS.master(photo.id), now);
      // Sin maestra no hay nada que regenerar, y marcarla como lista sería mentir. Se queda
      // como está: la foto sigue `lista` sin derivadas, y eso se ve en la pantalla.
      if (master === null) continue;

      for (const derivative of DERIVATIVES) {
        const bytes = await sharp(master)
          .rotate()
          .resize({
            width: derivative.side,
            height: derivative.side,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .avif({ quality: 62 })
          .toBuffer();
        await this.upload(`${photo.id}/${derivative.name}.avif`, bytes, now);
      }
      await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) =>
        c.query('select medskin_photo_derivatives($1, true)', [photo.id]),
      );
    }
    return photos.length;
  }

  /**
   * LOS BYTES DE UNA FOTO BORRADA · la otra mitad de un borrado.
   *
   * Borrar una foto marcaba la fila (`deleted_at`) y dejaba los cuatro objetos en el disco
   * para siempre. Es disco que nadie contaba y, peor, es la cara de alguien que pidió que se
   * fuera y seguía estando. Aquí se van los cuatro —las tres derivadas y LA MAESTRA—, porque
   * esto no es archivar: es borrar.
   */
  async eraseDeleted(limit = 25): Promise<number> {
    const photos = await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<{ id: string }>('select id from medskin_photos_to_erase($1)', [
        limit,
      ]);
      return rows;
    });

    const now = new Date();
    for (const photo of photos) {
      for (const derivative of DERIVATIVES) {
        await this.remove(`${photo.id}/${derivative.name}.avif`, now);
      }
      await this.remove(KEYS.master(photo.id), now);
      await this.remove(KEYS.upload(photo.id), now);
      await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) =>
        c.query('select medskin_photo_erased($1)', [photo.id]),
      );
    }
    return photos.length;
  }

  private async process(
    photoId: string,
    practiceId: string,
    attempts: number,
    uploader: string,
  ): Promise<void> {
    const now = new Date();
    try {
      const original = await this.download(KEYS.upload(photoId), now);
      if (original === null) {
        await this.fail(photoId, attempts, 'La foto no llegó al almacenamiento.');
        return;
      }

      // 1 · los bytes, no la extensión ni el `Content-Type` del cliente.
      const realType = typeOfBytes(original.subarray(0, 32));
      if (realType === null) {
        await this.fail(photoId, attempts, 'Ese archivo no es una foto.');
        // El objeto se borra del almacenamiento y queda la fila del intento (§8.3).
        await this.remove(KEYS.upload(photoId), now);
        return;
      }

      // 2 · las dimensiones por la cabecera. `metadata()` no decodifica la imagen entera.
      const meta = await sharp(original, { limitInputPixels: 300_000_000 }).metadata();
      if (!dimensionsAreSane(meta.width, meta.height)) {
        await this.fail(photoId, attempts, 'Esa foto es demasiado pequeña o demasiado grande.');
        await this.remove(KEYS.upload(photoId), now);
        return;
      }

      // 4 · la maestra. `withMetadata()` NO se usa: sharp borra todos los metadatos al derivar y
      // eso es exactamente lo que se quiere — el GPS no puede viajar dentro del archivo.
      const master = JXL_AVAILABLE
        ? await sharp(original).jxl({ lossless: true }).toBuffer()
        : original;
      await this.upload(KEYS.master(photoId), master, now);

      // 5 · las tres derivadas, en AVIF y por el lado mayor.
      for (const derivative of DERIVATIVES) {
        const bytes = await sharp(original)
          .rotate()
          .resize({ width: derivative.side, height: derivative.side, fit: 'inside', withoutEnlargement: true })
          .avif({ quality: 62 })
          .toBuffer();
        await this.upload(`${photoId}/${derivative.name}.avif`, bytes, now);
      }

      await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) =>
        c.query('select medskin_photo_processed($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
          photoId,
          realType,
          meta.width,
          meta.height,
          JXL_AVAILABLE ? 'jxl' : 'original',
          master.byteLength,
          // 3 · la metadata útil A LA BASE. El GPS de `meta.exif` NO se copia a ningún sitio.
          readCamera(meta),
          readIso(meta),
          now,
        ]),
      );

      // La copia de la subida ya no hace falta: la maestra es la que se conserva.
      await this.remove(KEYS.upload(photoId), now);
    } catch (cause) {
      await this.fail(photoId, attempts, 'No pudimos procesar la foto.');
      // Nunca en silencio: el fallo va a `service_failure` con su causa real (§8.3).
      await this.failures.record({
        service: 'worker',
        operation: 'foto.procesar',
        severity: attempts + 1 >= MAX_ATTEMPTS ? 'error' : 'warning',
        errorCode: 'foto_no_se_pudo_procesar',
        cause,
        traceId: photoId,
        requestId: photoId,
        appVersion: null,
        platform: null,
        region: null,
        // El contexto es el de la CONSULTA de la foto, no el del trabajador: un trabajador no
        // actúa en nombre de nadie, y quien tiene que ver este fallo es la doctora cuya foto
        // no se procesó. `accountId` es la cuenta que la subió.
        context: { accountId: uploader, accountRole: 'practitioner', practiceId },
      });
    }
  }

  /** Tres fallos y la foto queda `fallida` con el motivo real, visible para la doctora. */
  private async fail(photoId: string, attempts: number, reason: string): Promise<void> {
    void attempts;
    // La cuenta de intentos la lleva LA BASE y no el trabajador: dos trabajadores que fallan a
    // la vez sobre la misma foto no pueden perder un intento entre los dos.
    await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) =>
      c.query('select medskin_photo_failed($1, $2, $3)', [photoId, reason, MAX_ATTEMPTS]),
    );
  }

  private async download(key: string, now: Date): Promise<Buffer | null> {
    const url = signUrl(this.storage, { method: 'GET', key, expiresInSeconds: 120, now });
    const response = await fetch(url.url);
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  }

  private async upload(key: string, bytes: Buffer, now: Date): Promise<void> {
    const url = signUrl(this.storage, { method: 'PUT', key, expiresInSeconds: 120, now });
    const response = await fetch(url.url, { method: 'PUT', body: new Uint8Array(bytes) });
    if (!response.ok) throw new Error(`el almacenamiento rechazó ${key}: ${response.status}`);
  }

  private async remove(key: string, now: Date): Promise<void> {
    const url = signUrl(this.storage, { method: 'GET', key, expiresInSeconds: 120, now });
    await fetch(url.url, { method: 'DELETE' }).catch(() => undefined);
  }
}

/** La cámara, de los metadatos. Nunca el GPS, que no se copia a ningún sitio. */
function readCamera(meta: Metadata): string | null {
  const exif = meta.exif;
  if (exif === undefined) return null;
  // El EXIF crudo lleva el modelo en texto plano; leerlo entero exigiría un analizador, y lo
  // único que se quiere de él son dos campos. Si no se encuentra, nulo: no se inventa.
  const text = exif.toString('latin1');
  const model = /Model\0*([\w\s.-]{2,40})/.exec(text);
  return model?.[1]?.trim() ?? null;
}

function readIso(meta: Metadata): number | null {
  const exif = meta.exif;
  if (exif === undefined) return null;
  const iso = /ISO\w*\0*(\d{2,5})/.exec(exif.toString('latin1'));
  return iso?.[1] === undefined ? null : Number(iso[1]);
}
