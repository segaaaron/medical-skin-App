// Las reglas del catálogo. Dominio puro: sin NestJS, sin Fastify, sin `pg`.
//
// EL DINERO SON ENTEROS Y LA MONEDA ES DE LA CONSULTA. Todo importe entra y sale como
// `{ centavos, moneda }`, la moneda sale de `practice.currency` y **no se acepta del cliente en
// ningún endpoint**: un precio en otra moneda es un error de programación, no una opción.
//
// LA REGLA CLÍNICA MANDA SOBRE LA COMERCIAL, y por eso `intervalo_minimo_dias` es obligatorio
// en todo tratamiento que se repita y las claves de contraindicación son una lista cerrada: es
// lo que el servidor cruza contra `medical_history`. Texto libre sería una contraindicación que
// nadie puede comprobar.

import { ContractError } from '../../../shared/contract/error-catalog';

export const CATEGORIES = [
  'toxina',
  'relleno',
  'peeling',
  'laser',
  'aparatologia',
  'hilos',
  'mesoterapia',
  'limpieza',
  'valoracion',
  'otro',
] as const;

export const ZONES = [
  'frente',
  'entrecejo',
  'patas_de_gallo',
  'tercio_superior',
  'tercio_medio',
  'tercio_inferior',
  'surcos_nasogenianos',
  'labios',
  'menton',
  'cuello',
  'escote',
  'manos',
  'cara_completa',
  'otra',
] as const;

export const CONTRAINDICATION_KEYS = [
  'embarazo',
  'lactancia',
  'alergia',
  'medicacion',
  'antecedente',
  'fototipo_mayor_que',
  'fototipo_menor_que',
  'edad_menor_que',
] as const;

/** Las dos que se comprueban solas con la ficha; el resto necesita a qué. */
const KEYS_WITHOUT_VALUE = ['embarazo', 'lactancia'];

export const SEGMENTS = ['nueva', 'inactiva_meses', 'cumpleanos', 'por_vencer', 'todas'] as const;

export const MAX_PROTOCOL_STEPS = 20;

export type Money = { centavos: number; moneda: string };

export type TreatmentDraft = {
  name: string;
  category: string;
  description: string | null;
  durationMinutes: number;
  plannedSessions: number;
  minIntervalDays: number | null;
  requiresConsent: boolean;
  visibleToPatients: boolean;
  cents: number;
  supplies: readonly { productId: string; units: number }[];
};

export function readTreatment(input: unknown): TreatmentDraft {
  const body = asRecord(input);

  const name = text(body.nombre, 120);
  if (name === null || name.length < 2) throw new ContractError('nombre_vacio');

  const category = CATEGORIES.find((known) => known === body.categoria);
  if (category === undefined) throw new ContractError('categoria_desconocida');

  const durationMinutes = integer(body.duracion_minutos);
  if (durationMinutes === null || durationMinutes < 5 || durationMinutes > 480) {
    throw new ContractError('duracion_fuera_de_rango');
  }

  const plannedSessions = integer(body.sesiones_previstas) ?? 1;
  if (plannedSessions < 1 || plannedSessions > 20) throw new ContractError('duracion_fuera_de_rango');

  const minIntervalDays = integer(body.intervalo_minimo_dias);
  // «No es un adorno comercial: es la regla clínica.» Y no admite `0` con más de una sesión.
  if (plannedSessions > 1 && (minIntervalDays === null || minIntervalDays <= 0)) {
    throw new ContractError('intervalo_necesario');
  }

  return {
    name,
    category,
    description: text(body.descripcion, 2000),
    durationMinutes,
    plannedSessions,
    minIntervalDays,
    requiresConsent: body.requiere_consentimiento === true,
    // Por omisión visible: `false` es el tratamiento que existe para la agenda interna y no se
    // ofrece —un retoque de cortesía, una valoración—.
    visibleToPatients: body.visible_para_pacientes !== false,
    cents: readCents(body.precio),
    supplies: readSupplies(body.insumos),
  };
}

/** Lo que el `PATCH` cambia. Ausente = no se toca; es la misma mezcla por campo del tramo 2. */
export function readTreatmentEdit(input: unknown): Partial<TreatmentDraft> {
  const body = asRecord(input);
  const edit: Partial<TreatmentDraft> = {};

  if (body.nombre !== undefined) {
    const name = text(body.nombre, 120);
    if (name === null || name.length < 2) throw new ContractError('nombre_vacio');
    edit.name = name;
  }
  if (body.categoria !== undefined) {
    const category = CATEGORIES.find((known) => known === body.categoria);
    if (category === undefined) throw new ContractError('categoria_desconocida');
    edit.category = category;
  }
  if (body.descripcion !== undefined) edit.description = text(body.descripcion, 2000);
  if (body.duracion_minutos !== undefined) {
    const minutes = integer(body.duracion_minutos);
    if (minutes === null || minutes < 5 || minutes > 480) {
      throw new ContractError('duracion_fuera_de_rango');
    }
    edit.durationMinutes = minutes;
  }
  if (body.sesiones_previstas !== undefined) {
    const sessions = integer(body.sesiones_previstas);
    if (sessions === null || sessions < 1 || sessions > 20) {
      throw new ContractError('duracion_fuera_de_rango');
    }
    edit.plannedSessions = sessions;
  }
  if (body.intervalo_minimo_dias !== undefined) {
    edit.minIntervalDays = integer(body.intervalo_minimo_dias);
  }
  if (body.requiere_consentimiento !== undefined) {
    edit.requiresConsent = body.requiere_consentimiento === true;
  }
  if (body.visible_para_pacientes !== undefined) {
    edit.visibleToPatients = body.visible_para_pacientes === true;
  }
  if (body.precio !== undefined) edit.cents = readCents(body.precio);
  if (body.insumos !== undefined) edit.supplies = readSupplies(body.insumos);

  if (Object.keys(edit).length === 0) throw new ContractError('nada_que_cambiar');
  return edit;
}

export type ProtocolStep = { moment: string; offsetHours: number; text: string };
export type TrafficLight = { day: number; normal: string; callIf: string };

export function readProtocol(input: unknown): {
  steps: readonly ProtocolStep[];
  trafficLight: readonly TrafficLight[];
} {
  const body = asRecord(input);
  const rawSteps = Array.isArray(body.pasos) ? body.pasos : [];
  if (rawSteps.length > MAX_PROTOCOL_STEPS) throw new ContractError('demasiados_pasos');

  const steps = rawSteps.map((raw) => {
    const step = asRecord(raw);
    const moment = step.momento === 'antes' || step.momento === 'despues' ? step.momento : null;
    if (moment === null) throw new ContractError('desfase_sin_sentido');

    const body_ = text(step.texto, 500);
    if (body_ === null) throw new ContractError('paso_sin_texto');

    const offsetHours = integer(step.desfase_horas);
    if (offsetHours === null) throw new ContractError('desfase_sin_sentido');
    // Un paso de antes va con horas negativas y uno de después con positivas.
    if (moment === 'antes' ? offsetHours >= 0 : offsetHours < 0) {
      throw new ContractError('desfase_sin_sentido');
    }
    return { moment, offsetHours, text: body_ };
  });

  const rawLights = Array.isArray(body.semaforo) ? body.semaforo : [];
  const days = new Set<number>();
  const trafficLight = rawLights.map((raw) => {
    const light = asRecord(raw);
    const day = integer(light.dia);
    if (day === null || day < 0 || day > 90) throw new ContractError('semaforo_dia_repetido');
    if (days.has(day)) throw new ContractError('semaforo_dia_repetido');
    days.add(day);

    const normal = text(light.normal, 500);
    const callIf = text(light.llamar_si, 500);
    if (normal === null || callIf === null) throw new ContractError('paso_sin_texto');
    return { day, normal, callIf };
  });

  return { steps, trafficLight };
}

export type Contraindication = { key: string; value: string | null; absolute: boolean };

export function readContraindications(input: unknown): readonly Contraindication[] {
  const body = asRecord(input);
  const raw = Array.isArray(body.contraindicaciones) ? body.contraindicaciones : [];

  return raw.map((entry) => {
    const item = asRecord(entry);
    const key = CONTRAINDICATION_KEYS.find((known) => known === item.clave);
    if (key === undefined) throw new ContractError('clave_desconocida');

    // El valor puede llegar como número —`fototipo_mayor_que: 4`— y se guarda como texto: la
    // columna es una sola y el servidor es quien lo interpreta al cruzarlo con la ficha.
    // Solo texto o número: un objeto como `valor` no es un valor, es un error de la app.
    const value =
      typeof item.valor === 'string'
        ? item.valor.trim()
        : typeof item.valor === 'number'
          ? String(item.valor)
          : null;
    if (!KEYS_WITHOUT_VALUE.includes(key) && (value === null || value === '')) {
      throw new ContractError('valor_necesario');
    }

    // Por omisión ABSOLUTA: una contraindicación que alguien escribió sin decir si bloquea,
    // bloquea. Equivocarse hacia el lado que no aplica un tratamiento es el error barato.
    return { key, value, absolute: item.absoluta !== false };
  });
}

export type PriceRow = { treatmentId: string; zone: string | null; cents: number };

export function readPrices(input: unknown): readonly PriceRow[] {
  const body = asRecord(input);
  const raw = Array.isArray(body.precios) ? body.precios : [];

  const rows = raw.map((entry) => {
    const item = asRecord(entry);
    const treatmentId = text(item.tratamiento_id, 64);
    if (treatmentId === null) throw new ContractError('tratamiento_no_existe');

    const zone =
      item.zona === undefined || item.zona === null
        ? null
        : (ZONES.find((known) => known === item.zona) ?? null);
    if (item.zona !== undefined && item.zona !== null && zone === null) {
      throw new ContractError('zona_desconocida');
    }

    const cents = integer(item.centavos);
    if (cents === null || cents < 0) throw new ContractError('precio_no_valido');

    return { treatmentId, zone, cents };
  });

  // «Un tratamiento sin precio base no se puede ofrecer»: si llegan zonas de un tratamiento,
  // su base tiene que venir en la misma petición.
  const withZone = new Set(rows.filter((r) => r.zone !== null).map((r) => r.treatmentId));
  const withBase = new Set(rows.filter((r) => r.zone === null).map((r) => r.treatmentId));
  for (const id of withZone) {
    if (!withBase.has(id)) throw new ContractError('falta_precio_base');
  }

  return rows;
}

export type PromotionDraft = {
  name: string;
  treatmentIds: readonly string[];
  discountType: string;
  discountValue: number;
  startsOn: string;
  endsOn: string;
  quota: number | null;
  code: string | null;
  segmentKey: string;
  segmentValue: number | null;
  stackable: boolean;
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function readPromotion(input: unknown, today: string): PromotionDraft {
  const body = asRecord(input);

  const name = text(body.nombre, 120);
  if (name === null || name.length < 2) throw new ContractError('nombre_vacio');

  const discount = asRecord(body.descuento);
  const discountType = discount.tipo === 'porcentaje' || discount.tipo === 'monto' ? discount.tipo : null;
  if (discountType === null) throw new ContractError('descuento_fuera_de_rango');
  const discountValue = integer(discount.valor);
  if (discountValue === null) throw new ContractError('descuento_fuera_de_rango');
  if (discountType === 'porcentaje' && (discountValue < 1 || discountValue > 90)) {
    throw new ContractError('descuento_fuera_de_rango');
  }
  if (discountType === 'monto' && discountValue <= 0) {
    throw new ContractError('descuento_fuera_de_rango');
  }

  const window = asRecord(body.vigencia);
  const startsOn = date(window.desde);
  const endsOn = date(window.hasta);
  if (endsOn < startsOn) throw new ContractError('vigencia_al_reves');
  // «Esa promoción ya habría terminado»: una vigencia vencida no se crea.
  if (endsOn < today) throw new ContractError('vigencia_en_el_pasado');

  const segment = asRecord(body.segmento);
  const segmentKey = SEGMENTS.find((known) => known === (segment.clave ?? 'todas'));
  if (segmentKey === undefined) throw new ContractError('segmento_desconocido');
  const segmentValue = integer(segment.valor);
  if (segmentKey === 'inactiva_meses' && segmentValue === null) {
    throw new ContractError('segmento_desconocido');
  }

  const quota = integer(body.cupo);
  if (quota !== null && quota < 1) throw new ContractError('descuento_fuera_de_rango');

  return {
    name,
    treatmentIds: Array.isArray(body.tratamientos) ? body.tratamientos.map(String) : [],
    discountType,
    discountValue,
    startsOn,
    endsOn,
    quota,
    code: text(body.codigo, 40)?.toUpperCase() ?? null,
    segmentKey,
    segmentValue,
    stackable: body.acumulable === true,
  };
}

/**
 * El precio con la promoción aplicada. **El orden es monto fijo primero y porcentaje después,
 * siempre**, para que el resultado no dependa de cómo se guardaron (`tratamientos.md`). Y nunca
 * baja de cero: un descuento mayor que el precio deja el precio en cero, no en negativo.
 */
export function discounted(cents: number, discount: { type: string; value: number }): number {
  if (discount.type === 'monto') return Math.max(0, cents - discount.value);
  return Math.max(0, Math.round(cents * (1 - discount.value / 100)));
}

export function money(cents: number, currency: string): Money {
  return { centavos: cents, moneda: currency };
}

// -------------------------------------------------------------------------------------
// Lectores de campo, compartidos por los cinco endpoints de arriba
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

/** Un entero de verdad: `1920.5` y `"muchos"` no son enteros y no se redondean en silencio. */
function integer(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** El precio llega como `{ centavos }`: nunca un decimal, nunca un número con punto. */
function readCents(value: unknown): number {
  const cents = integer(asRecord(value).centavos);
  if (cents === null || cents < 0) throw new ContractError('precio_no_valido');
  return cents;
}

function readSupplies(value: unknown): readonly { productId: string; units: number }[] {
  const raw = Array.isArray(value) ? value : [];
  return raw.map((entry) => {
    const item = asRecord(entry);
    const productId = text(item.producto_id, 64);
    const units = integer(item.unidades);
    if (productId === null || units === null || units <= 0) {
      throw new ContractError('producto_no_existe');
    }
    return { productId, units };
  });
}

function date(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!DATE.test(raw)) throw new ContractError('vigencia_al_reves');
  return raw;
}
