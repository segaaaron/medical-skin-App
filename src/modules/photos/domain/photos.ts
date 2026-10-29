// Las reglas de las fotos. Dominio puro: ni almacenamiento, ni base, ni HTTP.

import { ContractError } from '../../../shared/contract/error-catalog';

/** Las cinco vistas estándar, más `libre`. Son lo que hace comparable cualquier par de fechas. */
export const VIEWS = [
  'frente',
  'perfil_izq',
  'perfil_der',
  'oblicuo_izq',
  'oblicuo_der',
  'libre',
] as const;

/** Lo que se acepta subir. Se comprueba otra vez por los BYTES al confirmar. */
export const TYPES = [
  'image/jpeg',
  'image/heic',
  'image/heif',
  'image/png',
  'image/x-adobe-dng',
] as const;

/** 25 MiB. Lo aplica el almacenamiento con la URL firmada, no solo este número. */
export const MAX_BYTES = 26_214_400;
export const MIN_SIDE = 320;
export const MAX_SIDE = 12_000;
/** Tres fallos y la foto queda `fallida` con el motivo real (§8.4). */
export const MAX_ATTEMPTS = 3;

export type UploadRequest = {
  patientId: string | null;
  practiceId: string | null;
  sessionId: string | null;
  view: string;
  declaredType: string;
  declaredBytes: number;
  takenAt: Date | null;
};

export function readUploadRequest(input: unknown): UploadRequest {
  const body = asRecord(input);

  const view = VIEWS.find((known) => known === (body.view ?? body.vista));
  if (view === undefined) throw new ContractError('vista_desconocida');

  const declaredType = TYPES.find((known) => known === body.tipo_declarado);
  if (declaredType === undefined) throw new ContractError('tipo_no_admitido');

  const declaredBytes = integer(body.bytes_declarados);
  if (declaredBytes === null || declaredBytes <= 0) throw new ContractError('demasiado_grande');
  if (declaredBytes > MAX_BYTES) throw new ContractError('demasiado_grande');

  const takenAt = typeof body.tomada_en === 'string' ? new Date(body.tomada_en) : null;

  return {
    patientId: text(body.patient_id ?? body.paciente_id),
    practiceId: text(body.practice_id),
    sessionId: text(body.session_id ?? body.sesion_id),
    view,
    declaredType,
    declaredBytes,
    takenAt: takenAt !== null && !Number.isNaN(takenAt.getTime()) ? takenAt : null,
  };
}

/**
 * EL TIPO REAL SE DECIDE POR LOS BYTES MÁGICOS (§8.3), nunca por la extensión ni por el
 * `Content-Type` que declaró el cliente. Son los cuatro formatos del contrato y nada más: un
 * archivo que no empieza por una de estas firmas no es una foto que vayamos a guardar.
 */
export function typeOfBytes(head: Buffer): string | null {
  if (head.length < 12) return null;
  // JPEG: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  // PNG: 89 P N G 0D 0A 1A 0A
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  // HEIC/HEIF: caja `ftyp` en el byte 4, con marca `heic`, `heix`, `hevc`, `mif1` o `msf1`.
  if (head.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('ascii');
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis'].includes(brand)) {
      return 'image/heic';
    }
    // `avif` también llega por aquí y es una foto válida que sharp lee.
    if (brand === 'avif' || brand === 'avis') return 'image/heif';
  }
  // DNG es un TIFF: II 2A 00 (little endian) o MM 00 2A (big endian).
  if (
    head.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
    head.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
  ) {
    return 'image/x-adobe-dng';
  }
  return null;
}

/**
 * Las dimensiones se comprueban ANTES DE DECODIFICAR NADA: «una imagen de 200 MP bien formada
 * es un ataque de memoria, no una foto».
 */
export function dimensionsAreSane(width: number | undefined, height: number | undefined): boolean {
  if (width === undefined || height === undefined) return false;
  return (
    width >= MIN_SIDE && height >= MIN_SIDE && width <= MAX_SIDE && height <= MAX_SIDE
  );
}

/** Los tres tamaños del contrato. `full` es el de la comparación clínica. */
export const DERIVATIVES = [
  { name: 'thumb', side: 320 },
  { name: 'view', side: 1280 },
  { name: 'full', side: 2560 },
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function integer(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}
