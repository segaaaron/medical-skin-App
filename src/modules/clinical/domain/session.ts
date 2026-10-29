// Las reglas de la sesión clínica. Dominio puro.
//
// LO QUE ESTE ARCHIVO NO HACE, Y ES LO IMPORTANTE: no corrige nada. «En un registro de dosis,
// un ajuste silencioso es un dato inventado», así que cuando la suma de los puntos no cuadra
// con el total, devuelve el `400` y se acabó.

import { ContractError } from '../../../shared/contract/error-catalog';
import { ZONES } from '../../catalog/domain/treatment';

export const CORRECTION_REASONS = [
  'error_de_transcripcion',
  'dato_omitido',
  'dato_equivocado',
  'aclaracion',
] as const;

export const ADVERSE_KINDS = [
  'hematoma',
  'edema',
  'asimetria',
  'ptosis',
  'infeccion',
  'nodulo',
  'necrosis',
  'reaccion_alergica',
  'dolor_persistente',
  'otro',
] as const;

export const SEVERITIES = ['leve', 'moderada', 'grave'] as const;
/** Los campos de la nota. Lo que no esté aquí no se guarda. */
export const NOTE_FIELDS = [
  'motivo',
  'hallazgos',
  'procedimiento',
  'indicaciones',
  'proxima_revision',
] as const;

export type ApplicationPoint = { zone: string; x: number; y: number; units: number };

export type Application = {
  lotId: string;
  zone: string;
  technique: string | null;
  depth: string | null;
  totalUnits: number;
  points: readonly ApplicationPoint[];
};

export type SessionDraft = {
  appointmentId: string;
  startedAt: Date;
  endedAt: Date;
  applications: readonly Application[];
  observations: string | null;
};

export function readSession(input: unknown): SessionDraft {
  const body = asRecord(input);

  const appointmentId = text(body.appointment_id ?? body.cita_id, 64);
  if (appointmentId === null) throw new ContractError('cita_no_existe');

  const raw = Array.isArray(body.aplicaciones) ? body.aplicaciones : [];
  if (raw.length === 0) throw new ContractError('sin_aplicaciones');

  const applications = raw.map((entry) => {
    const item = asRecord(entry);
    const lotId = text(item.lot_id ?? item.lote_id, 64);
    if (lotId === null) throw new ContractError('lote_no_existe');

    const zone = ZONES.find((known) => known === item.zona);
    if (zone === undefined) throw new ContractError('zona_desconocida');

    const totalUnits = integer(item.unidades_totales);
    if (totalUnits === null || totalUnits <= 0) throw new ContractError('unidades_no_cuadran');

    const points = (Array.isArray(item.puntos) ? item.puntos : []).map((rawPoint) => {
      const point = asRecord(rawPoint);
      const pointZone = ZONES.find((known) => known === point.zona) ?? zone;
      const x = decimal(point.x);
      const y = decimal(point.y);
      // «Ese punto cae fuera de la imagen»: relativas, 0 a 1, y no píxeles.
      if (x === null || y === null || x < 0 || x > 1 || y < 0 || y > 1) {
        throw new ContractError('punto_fuera_de_rango');
      }
      const units = integer(point.unidades);
      if (units === null || units <= 0) throw new ContractError('unidades_no_cuadran');
      return { zone: pointZone, x, y, units };
    });

    // «Los puntos suman 16 y pusiste 20. Revisa antes de guardar.» Solo cuando hay puntos: una
    // aplicación sin mapa es válida —no todo tratamiento se pincha— y entonces el total manda.
    if (points.length > 0) {
      const sum = points.reduce((total, point) => total + point.units, 0);
      if (sum !== totalUnits) {
        throw new ContractError('unidades_no_cuadran', { suma: sum, total: totalUnits });
      }
    }

    return {
      lotId,
      zone,
      technique: text(item.tecnica, 60),
      depth: text(item.profundidad, 60),
      totalUnits,
      points,
    };
  });

  const startedAt = moment(body.empezo_en);
  const endedAt = moment(body.termino_en);

  return {
    appointmentId,
    startedAt,
    endedAt,
    applications,
    observations: text(body.observaciones, 4000),
  };
}

export type NoteConflict = {
  campo: string;
  tuyo: string;
  del_servidor: string;
  del_servidor_lo_escribio: string;
  cuando: string;
};

/**
 * LA MEZCLA DE LA NOTA, CAMPO POR CAMPO, Y SIN ELEGIR POR NADIE.
 *
 * §9.3: no «gana el último». Si el campo cambió en el servidor después de lo que esta pantalla
 * vio (`visto_en`), **se conservan los dos valores** y decide una persona. «Perder una frase de
 * una nota clínica porque dos personas escribieron a la vez es inaceptable, y elegir por ellas
 * también.»
 */
export function mergeNote(p: {
  incoming: Record<string, unknown>;
  seenAt: Date | null;
  current: Record<string, { value: string; at: string; by: string }>;
  author: string;
  now: Date;
}): {
  saved: string[];
  conflicts: NoteConflict[];
  fields: Record<string, { value: string; at: string; by: string }>;
} {
  const saved: string[] = [];
  const conflicts: NoteConflict[] = [];
  const fields = { ...p.current };

  for (const field of NOTE_FIELDS) {
    const incoming = p.incoming[field];
    if (incoming === undefined) continue;
    const value = typeof incoming === 'string' ? incoming.trim() : '';

    const mine = p.current[field];
    const changedBehind =
      mine !== undefined && p.seenAt !== null && new Date(mine.at) > p.seenAt && mine.value !== value;

    if (changedBehind) {
      conflicts.push({
        campo: field,
        tuyo: value,
        del_servidor: mine.value,
        del_servidor_lo_escribio: mine.by,
        cuando: mine.at,
      });
      continue;
    }

    fields[field] = { value, at: p.now.toISOString(), by: p.author };
    saved.push(field);
  }

  return { saved, conflicts, fields };
}

/** Si la nota tiene algo escrito. «Escribe la nota antes de firmarla.» */
export function noteIsEmpty(fields: Record<string, { value: string }>): boolean {
  return Object.values(fields).every((field) => field.value.trim() === '');
}

export function readCorrection(input: unknown): { text: string; reason: string } {
  const body = asRecord(input);
  const body_ = text(body.texto, 4000);
  if (body_ === null) throw new ContractError('texto_vacio');
  const reason = CORRECTION_REASONS.find((known) => known === body.motivo);
  if (reason === undefined) throw new ContractError('motivo_desconocido');
  return { text: body_, reason };
}

export type AdverseEventDraft = {
  kind: string;
  severity: string;
  appearedAt: Date;
  description: string;
  management: string | null;
  lotId: string | null;
};

export function readAdverseEvent(input: unknown): AdverseEventDraft {
  const body = asRecord(input);
  const kind = ADVERSE_KINDS.find((known) => known === body.tipo);
  if (kind === undefined) throw new ContractError('motivo_desconocido');
  const severity = SEVERITIES.find((known) => known === body.gravedad);
  if (severity === undefined) throw new ContractError('motivo_desconocido');
  const description = text(body.descripcion, 4000);
  if (description === null) throw new ContractError('texto_vacio');

  return {
    kind,
    severity,
    appearedAt: moment(body.aparecio_en),
    description,
    management: text(body.conducta, 4000),
    lotId: text(body.lot_id ?? body.lote_id, 64),
  };
}

/** `{ "motivo": "…" }`, obligatorio y de 10 caracteres o más: va al expediente. */
export function readVoidReason(input: unknown): string {
  const reason = text(asRecord(input).motivo, 500);
  if (reason === null || reason.length < 10) throw new ContractError('motivo_muy_corto');
  return reason;
}

export type LotDraft = {
  productId: string;
  code: string;
  expiresOn: string;
  units: number;
  costCents: number | null;
};

export function readLot(input: unknown, today: string): LotDraft {
  const body = asRecord(input);
  const productId = text(body.product_id ?? body.producto_id, 64);
  if (productId === null) throw new ContractError('producto_no_existe');
  const code = text(body.codigo, 60);
  if (code === null) throw new ContractError('codigo_de_lote_repetido');

  const expiresOn = text(body.vence_en, 10);
  if (expiresOn === null || !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) {
    throw new ContractError('vencimiento_en_el_pasado');
  }
  // «Ese lote ya está vencido. Si es correcto, no lo cargues.»
  if (expiresOn < today) throw new ContractError('vencimiento_en_el_pasado');

  const units = integer(body.unidades);
  if (units === null || units <= 0) throw new ContractError('unidades_no_cuadran');

  return { productId, code, expiresOn, units, costCents: integer(body.costo_total) };
}

export const CONSENT_PURPOSES = ['clinico', 'imagenes', 'marketing'] as const;

export type ConsentDraft = {
  patientId: string;
  treatmentId: string | null;
  version: string;
  purpose: string;
  answers: Record<string, number>;
  readSeconds: number | null;
  signedBy: string;
};

export function readConsent(input: unknown): ConsentDraft {
  const body = asRecord(input);
  const patientId = text(body.patient_id ?? body.paciente_id, 64);
  if (patientId === null) throw new ContractError('paciente_no_existe');

  const purpose = CONSENT_PURPOSES.find((known) => known === body.proposito);
  if (purpose === undefined) throw new ContractError('motivo_desconocido');

  const version = text(body.version, 40);
  if (version === null) throw new ContractError('version_desactualizada');

  const raw = asRecord(body.respuestas);
  const answers: Record<string, number> = {};
  for (const [id, value] of Object.entries(raw)) {
    const picked = integer(value);
    if (picked !== null) answers[id] = picked;
  }

  return {
    patientId,
    treatmentId: text(body.treatment_id ?? body.tratamiento_id, 64),
    version,
    purpose,
    answers,
    readSeconds: integer(body.leido_en_segundos),
    signedBy: body.firmado_por === 'tutor' ? 'tutor' : 'paciente',
  };
}

/**
 * La corrección de las tres preguntas, EN EL SERVIDOR. Devuelve cuáles falló, y el contrato es
 * explícito con qué hacer: «no es un muro», la app vuelve al párrafo de esa pregunta.
 */
export function wrongAnswers(
  answers: Record<string, number>,
  key: Record<string, number>,
): string[] {
  return Object.entries(key)
    .filter(([id, correct]) => answers[id] !== correct)
    .map(([id]) => id);
}

// -------------------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed === '' ? null : trimmed;
}

function integer(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function decimal(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** Un instante del cliente, o ahora. La hora de la sala la pone quien registra. */
function moment(value: unknown): Date {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}
