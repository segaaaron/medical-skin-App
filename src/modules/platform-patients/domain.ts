// LO QUE SE ACEPTA DE LAS PETICIONES DE `pacientes-consola.md` · 31 de octubre de 2026.
//
// Sin NestJS, sin Fastify y sin `pg`: se prueba sin levantar nada.
//
// LAS DOS DECISIONES QUE VIVEN AQUÍ, y las dos son de producto y no de código:
//   1. `antes_de_atenderla` SE RECHAZA, no se ignora. Quien lo manda cree que se guardó.
//   2. El motivo de la lectura de historia es OBLIGATORIO y de 10 a 300. Sin motivo no hay
//      lectura, y eso lo vuelve a comprobar la función de base: dos puertas para lo mismo, a
//      propósito, porque es la que sostiene la promesa de §4.

import { ContractError } from '../../shared/contract/error-catalog';

export const PAGE_DEFAULT = 25;
export const PAGE_MAX = 100;
const QUERY_MIN = 2;
const QUERY_MAX = 120;

/** Los dos estados de `patient.status`. Lista cerrada: lo que no está, no se filtra. */
const STATES = ['activa', 'archivada'] as const;
export type PatientState = (typeof STATES)[number];

export type Cursor = { at: Date; id: string };

export type PatientSearch = {
  query: string | null;
  state: PatientState | null;
  cursor: Cursor | null;
  perPage: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(): never {
  throw new ContractError('cuerpo_no_valido');
}

function readPerPage(value: unknown): number {
  if (value === undefined || value === null || value === '') return PAGE_DEFAULT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > PAGE_MAX) invalid();
  return n;
}

/** `<instante ISO>|<uuid>`, entero o nada: media página no es la siguiente de nada. */
function readCursor(value: unknown): Cursor | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') invalid();
  const [at, id, ...resto] = value.split('|');
  if (at === undefined || id === undefined || resto.length > 0 || !UUID.test(id)) invalid();
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) invalid();
  return { at: when, id };
}

export function readPatientSearch(params: Record<string, unknown>): PatientSearch {
  const raw = params.q;
  let query: string | null = null;
  if (raw !== undefined && raw !== null && raw !== '') {
    if (typeof raw !== 'string') invalid();
    const trimmed = raw.trim();
    // Menos de dos caracteres con `LIKE %a%` no es una búsqueda: es el padrón con un filtro
    // decorativo, y aquí el padrón son pacientes.
    if (trimmed.length < QUERY_MIN || trimmed.length > QUERY_MAX) invalid();
    query = trimmed;
  }

  const estado = params.estado;
  let state: PatientState | null = null;
  if (estado !== undefined && estado !== null && estado !== '') {
    const found = STATES.find((known) => known === estado);
    if (found === undefined) invalid();
    state = found;
  }

  return { query, state, cursor: readCursor(params.cursor), perPage: readPerPage(params.por_pagina) };
}

/**
 * EL MOTIVO DE LA LECTURA DE HISTORIA.
 *
 * De 10 a 300, y el mínimo no es cosmético: «ok», «revisar» o un punto no son un motivo, y el
 * día que alguien pregunte quién leyó qué, esa palabra es toda la respuesta que va a haber.
 *
 * Se comprueba aquí Y en `medskin_platform_history_read()`. Dos puertas para lo mismo es algo
 * que este repositorio evita por norma; aquí es deliberado, porque la de la base es la que no
 * se puede saltar llamando a la función desde otro sitio.
 */
export const REASON_MIN = 10;
export const REASON_MAX = 300;

export function readHistoryReason(input: unknown): string {
  const body = typeof input === 'object' && input !== null ? (input as { motivo?: unknown }) : {};
  const motivo = typeof body.motivo === 'string' ? body.motivo.trim() : '';
  if (motivo.length < REASON_MIN || motivo.length > REASON_MAX) {
    throw new ContractError('motivo_necesario');
  }
  return motivo;
}

/**
 * EL ALTA, Y LO QUE NO ENTRA POR AQUÍ.
 *
 * `antes_de_atenderla` se RECHAZA con su propio código en vez de ignorarse, y esa es la
 * diferencia que importa: ignorarlo deja a quien lo mandó creyendo que la alergia quedó
 * guardada, y nadie se entera hasta que haga falta.
 *
 * El motivo no es de permisos sino de verdad del dato: cada campo de `medical_history` guarda
 * su `fuente`, así que una alergia tecleada por soporte diría `fuente: 'doctor'` cuando el
 * doctor nunca lo dijo. El valor de ayer es lo que explica una reacción de mañana.
 */
export function rejectClinicalBlock(input: unknown): void {
  const body = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  if (body.antes_de_atenderla !== undefined && body.antes_de_atenderla !== null) {
    throw new ContractError('historia_no_se_recoge_aqui');
  }
}

/** El cursor de la última fila, o `null` si esta página es la última. */
export function nextCursor<T>(
  rows: readonly T[],
  perPage: number,
  of: (row: T) => Cursor,
): { page: readonly T[]; next: string | null } {
  if (rows.length <= perPage) return { page: rows, next: null };
  const page = rows.slice(0, perPage);
  const last = page[page.length - 1];
  if (last === undefined) return { page, next: null };
  const { at, id } = of(last);
  return { page, next: `${at.toISOString()}|${id}` };
}
