// El alta de una paciente · `POST /v1/patients`. Dominio: sin NestJS, sin Fastify, sin `pg`.
//
// Es LA ÚNICA PUERTA DE UNA PACIENTE AL SISTEMA («nadie se registra solo»), y por eso todo
// lo que entra se lee aquí y se normaliza aquí: la ficha, la vía del acceso y los
// antecedentes del paso 3. Lo contratan dos archivos a la vez —`cuentas.md` pone la cuenta
// y el acceso, `pacientes.md` pone lo que lleva dentro `antes_de_atenderla`— y ninguno de
// los dos cambia la forma del otro.
//
// LAS DOS REGLAS QUE GOBIERNAN ESTE ARCHIVO
//
// 1. `null` Y `false` NO SON LO MISMO, y es la decisión más importante de la forma del
//    paso 3: `false` es «se le preguntó y no tiene», `null` es «nadie preguntó todavía».
//    Un expediente que no las distingue convierte una pregunta sin hacer en una respuesta
//    negativa, y eso en una ficha clínica es un dato falso. De ahí `writtenFields()`: lo
//    que la doctora contestó lleva su `fuente`, y lo que nadie tocó se queda sin ninguna.
// 2. CADA CAMPO GUARDA QUIÉN LO ESCRIBIÓ (`docs/contratos/README.md`). En este endpoint
//    escribe la doctora, así que el autor de cada campo contestado es ella, y la paciente
//    solo podrá sobrescribir desde su app los que queden vacíos (tramo 2).

import { ContractError } from '../../../shared/contract/error-catalog';
// La MISMA comprobación de forma que usan recuperación y el alta de equipo. No se
// reescribe: dice que la cadena no tiene forma de correo, sin consultar nada.
import { readEmail } from '../../recovery/domain/code';
import { isDeliveryChannel, type DeliveryChannel } from './access-delivery';

/** «doctora y asistente clínico · permiso `pacientes:crear`. Recepción **no**.» */
export const PATIENT_CREATE_PERMISSION = 'pacientes:crear';

/**
 * «Menos de la edad legal del país» (`cuentas.md` · `400 menor_de_edad`). 18 es la de
 * Bolivia, que es el único país del despliegue de hoy. NO sale de la configuración ni de
 * una tabla porque no hay nada escrito de dónde sale: el día que haya un segundo país, es
 * una decisión de producto y no un literal que alguien mueva aquí. Anotado en la entrega.
 */
export const LEGAL_AGE = 18;

/** «Más de 60 altas en una hora» · `429 demasiadas_altas`. */
export const CREATIONS_PER_HOUR = 60;

// Todo lo que entra del cliente va acotado: estas cadenas acaban en una fila, en un correo
// y en un mensaje de WhatsApp (OWASP A03).
const NAME_MAX = 80;
const HOW_ARRIVED_MAX = 40;
const LIST_MAX_ITEMS = 20;
const ITEM_MAX = 120;
const NOTES_MAX = 2000;

/** E.164: el `+`, el país y entre 8 y 15 dígitos. «No sirve para entrar» (`cuentas.md`). */
const E164 = /^\+[1-9]\d{7,14}$/;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const REMINDERS = ['app', 'whatsapp', 'ambas'] as const;
export type RemindersVia = (typeof REMINDERS)[number];

/** `ninguno | embarazo | lactancia | no_sabe | no_aplica`, y nada más (`pacientes.md`). */
const PREGNANCY = ['ninguno', 'embarazo', 'lactancia', 'no_sabe', 'no_aplica'] as const;

/** La ficha, ya validada y normalizada. Lo que la consulta guarda de su paciente. */
export type PatientFicha = {
  firstName: string;
  lastName: string;
  /** `AAAA-MM-DD`: es una fecha de calendario, no un instante. */
  birthDate: string;
  email: string;
  phone: string | null;
  hasWhatsapp: boolean;
  remindersVia: RemindersVia;
  howArrived: string;
  /** Una ficha de ESTA consulta, y lo comprueba la política del inquilino. */
  referredBy: string | null;
};

/** Las siete casillas de los antecedentes, en el orden del contrato. */
export const HISTORY_FIELDS = [
  'allergies',
  'medication',
  'pregnancy_or_lactation',
  'phototype',
  'past_conditions',
  'previous_treatments',
  'notes',
] as const;
export type HistoryField = (typeof HISTORY_FIELDS)[number];

/**
 * El paso 3 ya validado. «El paso 3 es opcional entero»: un `antes_de_atenderla` ausente o
 * `{}` crea la ficha igual, con todo en `null` —que no es «no»—.
 */
export type HistoryDraft = {
  hasAllergies: boolean | null;
  allergies: readonly string[];
  takesMedication: boolean | null;
  medication: readonly string[];
  pregnancyOrLactation: string | null;
  phototype: number | null;
  pastConditions: readonly string[];
  previousTreatments: readonly string[];
  notes: string | null;
};

export const EMPTY_HISTORY: HistoryDraft = {
  hasAllergies: null,
  allergies: [],
  takesMedication: null,
  medication: [],
  pregnancyOrLactation: null,
  phototype: null,
  pastConditions: [],
  previousTreatments: [],
  notes: null,
};

export type PatientRegistrationRequest = {
  ficha: PatientFicha;
  history: HistoryDraft;
  /** `correo | whatsapp | ninguna`. `ya_tiene_cuenta` solo SALE, nunca entra. */
  via: DeliveryChannel;
  /** «Es otra persona» reenvía la misma petición con esto en `true` y el 409 no vuelve. */
  confirmDuplicate: boolean;
};

/**
 * QUÉ CAMPOS CONTESTÓ QUIEN ESCRIBE, que es lo que decide si la paciente podrá tocarlos
 * desde su app. Un booleano en `false` SÍ cuenta —«se le preguntó y no tiene» es una
 * respuesta— y una lista vacía NO —nadie escribió nada en ella—.
 */
export function writtenFields(history: HistoryDraft): readonly HistoryField[] {
  const answered: Record<HistoryField, boolean> = {
    allergies: history.hasAllergies !== null,
    medication: history.takesMedication !== null,
    pregnancy_or_lactation: history.pregnancyOrLactation !== null,
    phototype: history.phototype !== null,
    past_conditions: history.pastConditions.length > 0,
    previous_treatments: history.previousTreatments.length > 0,
    notes: history.notes !== null,
  };
  return HISTORY_FIELDS.filter((field) => answered[field]);
}

/** La edad cumplida en una fecha. Se calcula por calendario, no dividiendo milisegundos. */
export function ageOn(birthDate: string, day: { year: number; month: number; date: number }): number {
  const [year, month, date] = birthDate.split('-').map(Number) as [number, number, number];
  const hadBirthday = day.month > month || (day.month === month && day.date >= date);
  return day.year - year - (hadBirthday ? 0 : 1);
}

/** El día de calendario de un instante, en UTC. Es con lo que se compara una fecha. */
export function calendarDay(moment: Date): { year: number; month: number; date: number } {
  return {
    year: moment.getUTCFullYear(),
    month: moment.getUTCMonth() + 1,
    date: moment.getUTCDate(),
  };
}

/**
 * El cuerpo entero, validado en el orden de la tabla de errores de `cuentas.md` y después
 * los cuatro del paso 3 de `pacientes.md`. Devuelve lo normalizado o lanza el error del
 * contrato; no consulta nada, así que ningún 400 puede decir si un correo existe.
 */
export function readRegistration(input: unknown, now: Date): PatientRegistrationRequest {
  const body = asRecord(input);

  const firstName = readName(body.nombre);
  const lastName = readName(body.apellido);
  if (firstName === null || lastName === null) throw new ContractError('nombre_vacio');

  const birthDate = readBirthDate(body.nacimiento, now);
  const email = readPatientEmail(body.correo);
  const phone = readPhone(body.celular);

  const via = body.enviar_acceso_por;
  if (!isDeliveryChannel(via)) {
    throw new ContractError(
      'via_no_valida',
      undefined,
      undefined,
      // El campo de ESTE endpoint; el `codigo` es el del catálogo y no se duplica.
      'enviar_acceso_por',
    );
  }
  // Antes de crear nada: sin celular no hay chat que abrir, y crear la ficha para después
  // devolver un 400 le cobraría a la doctora un error que todavía se puede corregir.
  if (via === 'whatsapp' && phone === null) {
    throw new ContractError('celular_necesario_para_whatsapp');
  }

  return {
    ficha: {
      firstName,
      lastName,
      birthDate,
      email,
      phone,
      // Sin celular no hay WhatsApp que marcar: la casilla sola no es un número.
      hasWhatsapp: phone !== null && body.tiene_whatsapp === true,
      remindersVia: readReminders(body.recordatorios_por),
      ...readHowArrived(body.como_llego, body.referida_por),
    },
    history: readHistory(body.antes_de_atenderla),
    via,
    confirmDuplicate: body.confirmar_duplicado === true,
  };
}

export function readName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().slice(0, NAME_MAX);
  return name === '' ? null : name;
}

/**
 * `nacimiento_no_valido` cubre las dos: ausente y mal escrita. Un solo código con una frase
 * que vale para los dos casos, y un nombre que no afirma ninguno —`nacimiento_vacio` era
 * falso con un `18/04/1992`— (decidido el 28 de octubre de 2026).
 */
export function readBirthDate(value: unknown, now: Date): string {
  const text = typeof value === 'string' ? value.trim() : '';
  const parts = DATE.exec(text);
  if (parts === null) throw new ContractError('nacimiento_no_valido');

  const [, year, month, date] = parts.map(Number) as [number, number, number, number];
  const asUtc = Date.UTC(year, month - 1, date);
  // Un 31 de febrero pasa el patrón y no existe: el motor lo rechazaría con un 500.
  if (new Date(asUtc).getUTCMonth() + 1 !== month || new Date(asUtc).getUTCDate() !== date) {
    throw new ContractError('nacimiento_no_valido');
  }

  const today = calendarDay(now);
  if (asUtc > Date.UTC(today.year, today.month - 1, today.date)) {
    throw new ContractError('nacimiento_futuro');
  }
  if (ageOn(text, today) < LEGAL_AGE) throw new ContractError('menor_de_edad');
  return text;
}

/** El correo de la paciente, con la frase de ESTE endpoint para el campo vacío. */
export function readPatientEmail(value: unknown): string {
  try {
    return readEmail(value);
  } catch (failure) {
    if (failure instanceof ContractError && failure.code === 'correo_vacio') {
      throw new ContractError(
        'correo_vacio',
        undefined,
        'Hace falta su correo: es por donde le llega su contraseña.',
        'correo',
      );
    }
    throw failure;
  }
}

/** Opcional, E.164. «Para llamarla y recordarle la cita. No sirve para entrar.» */
export function readPhone(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const phone = typeof value === 'string' ? value.replace(/[\s()-]/g, '') : '';
  if (!E164.test(phone)) throw new ContractError('celular_mal_escrito');
  return phone;
}

export function readReminders(value: unknown): RemindersVia {
  if (value === undefined || value === null) return 'app';
  if (!isOneOf(value, REMINDERS)) throw new ContractError('cuerpo_no_valido', undefined, undefined, 'recordatorios_por');
  return value;
}

/**
 * `como_llego` no tiene lista cerrada en el contrato ni `CHECK` en la base, así que entra
 * como etiqueta acotada. `referida_por` que no es un identificador responde lo MISMO que
 * uno que no es de esta consulta: `404 referida_no_existe`, y no se distingue una cosa de
 * la otra (OWASP A01).
 */
export function readHowArrived(
  howArrived: unknown,
  referredBy: unknown,
): { howArrived: string; referredBy: string | null } {
  const label = typeof howArrived === 'string' ? howArrived.trim() : '';
  if (label === '' || label.length > HOW_ARRIVED_MAX) {
    throw new ContractError('cuerpo_no_valido', undefined, undefined, 'como_llego');
  }
  if (label !== 'referida') return { howArrived: label, referredBy: null };

  const who = typeof referredBy === 'string' ? referredBy.trim() : '';
  if (who === '') throw new ContractError('referida_sin_quien');
  if (!UUID.test(who)) throw new ContractError('referida_no_existe');
  return { howArrived: label, referredBy: who };
}

/** El paso 3 de `pacientes.md`, con sus cuatro errores propios. */
export function readHistory(value: unknown): HistoryDraft {
  if (value === undefined || value === null) return EMPTY_HISTORY;
  const body = asRecord(value);

  const allergies = asRecord(body.alergias);
  const hasAllergies = readTriState(allergies.tiene);
  const medication = asRecord(body.medicacion);
  const takesMedication = readTriState(medication.toma);

  return {
    hasAllergies,
    // Una lista solo tiene sentido con el `true`: con `false` —«se le preguntó y no
    // tiene»— la base exige la lista vacía, y guardar las dos cosas sería un expediente
    // que se contradice consigo mismo.
    allergies: hasAllergies === true ? readList(allergies.cuales, 'alergias_sin_cuales') : [],
    takesMedication,
    medication:
      takesMedication === true ? readList(medication.cuales, 'medicacion_sin_cuales') : [],
    pregnancyOrLactation: readPregnancy(body.embarazo_o_lactancia),
    phototype: readPhototype(body.fototipo),
    pastConditions: readList(body.antecedentes, null),
    previousTreatments: readList(body.tratamientos_previos, null),
    notes: readNotes(body.notas),
  };
}

/** `true | false | null`, y `null` es «no se preguntó». Cualquier otra cosa es nulo. */
function readTriState(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * Una lista de cadenas cortas. `missing` es el error de cuando la lista es obligatoria
 * —`tiene: true` sin `cuales`—; con `null` la lista es opcional y vacía significa que
 * nadie escribió nada ahí.
 *
 * Nada se recorta en silencio: un elemento demasiado largo o una lista demasiado larga es
 * `400 cuerpo_no_valido`, porque truncar una alergia es perder un dato clínico.
 */
function readList(value: unknown, missing: 'alergias_sin_cuales' | 'medicacion_sin_cuales' | null): string[] {
  if (value === undefined || value === null) {
    if (missing !== null) throw new ContractError(missing);
    return [];
  }
  if (!Array.isArray(value)) throw new ContractError('cuerpo_no_valido');
  const items = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item !== '');
  if (items.length > LIST_MAX_ITEMS || items.some((item) => item.length > ITEM_MAX)) {
    throw new ContractError('cuerpo_no_valido');
  }
  if (items.length === 0 && missing !== null) throw new ContractError(missing);
  return items;
}

function readPregnancy(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!isOneOf(value, PREGNANCY)) throw new ContractError('embarazo_valor_desconocido');
  return value;
}

/** «El fototipo es 1-6 y nada más. No se acepta texto libre: es la escala de Fitzpatrick.» */
function readPhototype(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 6) {
    throw new ContractError('fototipo_fuera_de_escala');
  }
  return value;
}

function readNotes(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ContractError('cuerpo_no_valido');
  const notes = value.trim();
  if (notes.length > NOTES_MAX) throw new ContractError('cuerpo_no_valido');
  return notes === '' ? null : notes;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/** Un cuerpo que no es un objeto se lee como vacío: lo que falte lo dirá su propio 400. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** El mismo patrón que el del controlador: lo que no es un uuid no tiene fila en ninguna consulta. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
