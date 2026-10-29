// Las reglas del negocio. Dominio puro.

import { ContractError } from '../../../shared/contract/error-catalog';

export const CONCEPTS = ['sesion', 'sena', 'producto', 'otro'] as const;
export const METHODS = [
  'efectivo',
  'transferencia',
  'qr',
  'tarjeta',
  'credito_de_sena',
] as const;
export const MOVEMENTS = ['entrada', 'ajuste', 'merma', 'devolucion'] as const;
export const REPORTS = ['ingresos', 'ocupacion', 'repeticion', 'ausencias'] as const;

export type PaymentDraft = {
  patientId: string;
  sessionId: string | null;
  appointmentId: string | null;
  concept: string;
  cents: number;
  method: string;
  creditUsedCents: number;
  reference: string | null;
  chargedAt: Date | null;
};

export function readPayment(input: unknown): PaymentDraft {
  const body = asRecord(input);

  const patientId = text(body.patient_id ?? body.paciente_id);
  if (patientId === null) throw new ContractError('paciente_no_existe');

  const concept = CONCEPTS.find((known) => known === body.concepto);
  if (concept === undefined) throw new ContractError('medio_desconocido');
  const method = METHODS.find((known) => known === body.medio);
  if (method === undefined) throw new ContractError('medio_desconocido');

  // El importe son CENTAVOS ENTEROS: «un 1920.00 que pasa por JSON y vuelve es un redondeo
  // esperando a ocurrir, y esto son cobros».
  const cents = integer(asRecord(body.importe).centavos);
  if (cents === null || cents <= 0) throw new ContractError('importe_no_valido');

  const charged = typeof body.cobrado_en === 'string' ? new Date(body.cobrado_en) : null;

  return {
    patientId,
    sessionId: text(body.session_id ?? body.sesion_id),
    appointmentId: text(body.appointment_id ?? body.cita_id),
    concept,
    cents,
    method,
    creditUsedCents: integer(asRecord(body.credito_usado).centavos) ?? 0,
    reference: text(body.referencia),
    chargedAt: charged !== null && !Number.isNaN(charged.getTime()) ? charged : null,
  };
}

export type MovementDraft = {
  lotId: string;
  kind: string;
  units: number;
  reason: string | null;
};

export function readMovement(input: unknown): MovementDraft {
  const body = asRecord(input);

  const lotId = text(body.lot_id ?? body.lote_id);
  if (lotId === null) throw new ContractError('lote_no_existe');

  const kind = MOVEMENTS.find((known) => known === body.tipo);
  // Una SALIDA por sesión no se registra a mano: «dos caminos para descontar el mismo stock es
  // un inventario que nunca cuadra».
  if (body.tipo === 'salida') throw new ContractError('movimiento_de_sesion');
  if (kind === undefined) throw new ContractError('medio_desconocido');

  const units = integer(body.unidades);
  if (units === null || units <= 0) throw new ContractError('importe_no_valido');

  const reason = text(body.motivo);
  if (kind === 'merma' && reason === null) throw new ContractError('merma_sin_motivo');

  return { lotId, kind, units, reason };
}

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
