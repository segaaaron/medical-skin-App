// Las reglas de la lista: qué entra por la query, y qué palabra sale en `alerta`.
// Dominio puro: se prueba sin base y sin HTTP.

import { ContractError, type ErrorCode } from '../../../shared/contract/error-catalog';
import type {
  LinkStatus,
  PatientQuery,
  PatientRow,
  PatientStatusFilter,
} from './ports';

/** «`busca` necesita 2 caracteres o más» (`pacientes.md`). Menos es `400`. */
export const SEARCH_MIN = 2;
/** Lo que acota la página. 50 es el valor por omisión del contrato. */
export const PER_PAGE_DEFAULT = 50;
export const PER_PAGE_MAX = 100;

const STATUSES: readonly PatientStatusFilter[] = ['activa', 'archivada', 'todas'];
const LINKS: readonly LinkStatus[] = ['invitada', 'vinculada', 'revocada'];

/**
 * La query de `GET /v1/pacientes`. Todo opcional, y lo que no se entiende **no se adivina**:
 * un `estado=cualquiera` no cae en `activa` en silencio, porque entonces la app creería que
 * está filtrando algo que no filtra.
 *
 * `por_pagina` sí se acota en vez de rechazarse —100 es el techo— porque un número grande no
 * es un error de la app: es una petición que el servidor no quiere servir entera, y servir 100
 * es una respuesta honesta a «dame 5000».
 */
export function readPatientQuery(raw: Record<string, unknown>): PatientQuery {
  const search = readSearch(raw.busca);
  const status = readEnum<PatientStatusFilter>(raw.estado, STATUSES, 'activa', 'estado_no_valido');
  const link = raw.vinculo === undefined ? null : readEnum<LinkStatus>(raw.vinculo, LINKS, null, 'vinculo_no_valido');

  return {
    search,
    status,
    link,
    page: readPositive(raw.pagina, 1),
    perPage: Math.min(readPositive(raw.por_pagina, PER_PAGE_DEFAULT), PER_PAGE_MAX),
  };
}

function readSearch(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ContractError('busqueda_muy_corta');
  const text = value.trim();
  if (text === '') return null;
  // El `400` que la app no llega a provocar —no manda la petición hasta el segundo
  // carácter— y que existe igual: la app no es la única que puede llamar.
  if (text.length < SEARCH_MIN) throw new ContractError('busqueda_muy_corta');
  return text;
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T | null,
  code: ErrorCode,
): T {
  if (value === undefined || value === null || value === '') {
    if (fallback === null) throw new ContractError(code);
    return fallback;
  }
  const found = allowed.find((known) => known === value);
  if (found === undefined) throw new ContractError(code);
  return found;
}

/** Una página o un tamaño que no es un entero positivo vale lo que vale por omisión. */
function readPositive(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

/**
 * `alerta`: UNA PALABRA, NO UN DATO. «Lo que esa pantalla necesita saber es *aquí hay algo que
 * leer antes de pinchar*, no qué» (`pacientes.md`), porque la lista la ve también recepción,
 * que no puede abrir la ficha.
 *
 * **El embarazo y la lactancia van por delante de las alergias cuando coinciden las dos**, y
 * es una decisión, no un orden de escritura: contraindican tratamientos enteros del catálogo,
 * mientras que una alergia contraindica un producto. La app pinta un solo punto ámbar, así que
 * la palabra tiene que ser la que más cambia lo que se puede hacer ese día.
 *
 * `no_sabe` y `no_aplica` **no** son alerta: son respuestas a la pregunta, no un estado.
 */
export function alertOf(row: {
  hasAllergies: boolean | null;
  pregnancyOrLactation: string | null;
}): 'alergias' | 'embarazo' | 'lactancia' | null {
  if (row.pregnancyOrLactation === 'embarazo') return 'embarazo';
  if (row.pregnancyOrLactation === 'lactancia') return 'lactancia';
  if (row.hasAllergies === true) return 'alergias';
  return null;
}

/** El nombre que la lista enseña. Una sola forma, aquí, para las dos pantallas. */
export function fullNameOf(row: Pick<PatientRow, 'firstName' | 'lastName'>): string {
  return `${row.firstName} ${row.lastName}`;
}
