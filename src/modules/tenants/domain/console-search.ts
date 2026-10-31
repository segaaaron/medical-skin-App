// LAS DOS LECTURAS DE LA CONSOLA QUE DEVUELVEN MÁS DE UNA FILA · `consultas.md`, 30 oct 2026.
//
// Buscar una consulta y mirar la bandeja de licencias. Las dos comparten tres decisiones, y
// por eso comparten archivo:
//
//   1. CURSOR, NO NÚMERO DE PÁGINA. El padrón crece por el final: con `?pagina=2`, una
//      consulta creada entre dos peticiones desplaza todo y se salta una fila. El cursor es
//      `created_at|id` —o `submitted_at|practice_id`—, que no se mueve.
//   2. `cuantas` ES LO DE ESTA PÁGINA, NO EL TOTAL. Contar el padrón entero en cada búsqueda
//      es un recuento que nadie mira y que crece con la tabla.
//   3. SIN RESULTADOS ES UN 200 CON LISTA VACÍA. Un `404` aquí diría «ese correo no está en
//      MedSkin», que es el oráculo que el acceso cierra — servido a quien tenga token de
//      consola, pero servido igual.
//
// Sin NestJS, sin `pg` y sin Fastify: esto se prueba sin levantar nada.

import { ContractError } from '../../../shared/contract/error-catalog';

/** Los cuatro estados de `license.status`. Lista cerrada: lo que no está, no se filtra. */
export const LICENSE_STATES = ['sin_enviar', 'en_revision', 'verificada', 'rechazada'] as const;
export type LicenseState = (typeof LICENSE_STATES)[number];

export const PAGE_DEFAULT = 25;
export const PAGE_MAX = 100;
const QUERY_MIN = 2;
const QUERY_MAX = 120;

/**
 * El cursor, ya partido. `at` es el instante de la última fila devuelta y `id` su uuid: la
 * pareja desempata cuando dos filas comparten instante, que con `created_at` por omisión de
 * la base es más frecuente de lo que parece —una semilla crea varias en el mismo milisegundo—.
 */
export type Cursor = { at: Date; id: string };

export type ConsoleSearch = {
  query: string | null;
  license: LicenseState | null;
  cursor: Cursor | null;
  perPage: number;
};

export type LicenseInbox = {
  state: LicenseState;
  cursor: Cursor | null;
  perPage: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Todo lo que falla aquí es `400 cuerpo_no_valido`, que es el del transporte para «algo de lo
 * que mandaste no está bien». No se inventan códigos por parámetro: quien llama es una consola
 * interna y lo que necesita es saber que su petición está mal, no cuál de los cuatro.
 */
function invalid(): never {
  throw new ContractError('cuerpo_no_valido');
}

function readPerPage(value: unknown): number {
  if (value === undefined || value === null || value === '') return PAGE_DEFAULT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > PAGE_MAX) invalid();
  return n;
}

/**
 * `<instante ISO>|<uuid>`. Se valida entero: un cursor a medias es una petición mal formada,
 * y seguir con la mitad buena devolvería una página que no es la siguiente de nada.
 */
function readCursor(value: unknown): Cursor | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') invalid();
  const [at, id, ...resto] = value.split('|');
  if (at === undefined || id === undefined || resto.length > 0) invalid();
  if (!UUID.test(id)) invalid();
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) invalid();
  return { at: when, id };
}

function readLicenseState(value: unknown, fallback: LicenseState | null): LicenseState | null {
  if (value === undefined || value === null || value === '') return fallback;
  const found = LICENSE_STATES.find((known) => known === value);
  if (found === undefined) invalid();
  return found;
}

export function readConsoleSearch(params: Record<string, unknown>): ConsoleSearch {
  const raw = params.q;
  let query: string | null = null;
  if (raw !== undefined && raw !== null && raw !== '') {
    if (typeof raw !== 'string') invalid();
    const trimmed = raw.trim();
    // Menos de dos caracteres devuelve casi todo el padrón con un `LIKE %a%`, que no es una
    // búsqueda: es un volcado con un filtro decorativo.
    if (trimmed.length < QUERY_MIN || trimmed.length > QUERY_MAX) invalid();
    query = trimmed;
  }

  return {
    query,
    license: readLicenseState(params.licencia, null),
    cursor: readCursor(params.cursor),
    perPage: readPerPage(params.por_pagina),
  };
}

export function readLicenseInbox(params: Record<string, unknown>): LicenseInbox {
  // `en_revision` por omisión: eso ES la bandeja. Los otros tres se piden a propósito.
  const state = readLicenseState(params.estado, 'en_revision');
  if (state === null) invalid();
  return { state, cursor: readCursor(params.cursor), perPage: readPerPage(params.por_pagina) };
}

/**
 * El cursor de la última fila, o `null` si esta página es la última.
 *
 * Se calcula pidiendo UNA fila más de las que se devuelven: si viene, hay más. Contar aparte
 * sería una segunda consulta sobre la misma tabla para saber algo que la primera ya sabe.
 */
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
