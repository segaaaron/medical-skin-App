// EL TOPE DE FILAS, en un solo sitio · 3 de noviembre de 2026.
//
// Antes solo `GET /v1/patients` tenía tope: las demás listas devolvían la tabla entera. Con los
// datos de hoy eso responde, y por eso nadie lo notó; lo que no aguanta es el tiempo. Una
// consulta con tres años de sesiones, una galería con mil fotos o un informe de un año entero
// son la misma petición de siempre con mil veces más filas, y la primera señal es un tiempo de
// respuesta que crece despacio hasta que alguien se queja.
//
// LAS DOS REGLAS QUE ESTE ARCHIVO FIJA:
//
//   1. **Hay un máximo, siempre.** `por_pagina=5000` no es un error del cliente: es una petición
//      que el servidor no sirve entera. Se acota y se sirve el tope, que es una respuesta
//      honesta a «dame todo». Rechazarla con un 400 obligaría a la app a saber el número.
//   2. **El número lo fija el contrato DE CADA RECURSO, no una constante global.** Un historial
//      en un móvil quiere veinte; una rejilla de precios en un escritorio quiere doscientos.
//      Una sola cifra para todo obliga a uno de los dos a pedir seis veces lo mismo.
//
// La respuesta lleva `cuantas`, `pagina` y `por_pagina` al lado de su lista —las mismas claves
// que `GET /v1/patients` desde el primer día— y `cuantas` sale del MISMO recorrido que la página
// con `count(*) over ()`, nunca de un segundo `select count(*)`: dos lecturas distintas pueden
// decir cosas distintas, y entonces la app dibuja «1 de 3 páginas» sobre un total que ya cambió.

/** Lo que el cliente pidió, ya acotado. `offset` va listo para la consulta. */
export type Paginado = {
  page: number;
  perPage: number;
  offset: number;
};

/**
 * `pagina` y `por_pagina` de la query. Lo que no es un entero positivo vale lo que vale por
 * omisión: una página no es un campo de formulario y un `pagina=abc` no merece un 400 con el
 * que la app no puede hacer nada.
 */
export function readPaginado(
  raw: Record<string, unknown>,
  porOmision: number,
  maximo: number,
): Paginado {
  const page = readPositive(raw.pagina, 1);
  const perPage = Math.min(readPositive(raw.por_pagina, porOmision), maximo);
  return { page, perPage, offset: (page - 1) * perPage };
}

/** Las tres claves de la respuesta, para no escribirlas a mano en cada caso de uso. */
export function paginaDe(asked: Paginado, total: number): {
  cuantas: number;
  pagina: number;
  por_pagina: number;
} {
  return { cuantas: total, pagina: asked.page, por_pagina: asked.perPage };
}

/**
 * El total que viaja en cada fila por `count(*) over ()`. Cero filas es cero: una página más
 * allá de la última no tiene de dónde leerlo, y eso es correcto.
 */
export function totalDe(rows: readonly { total?: string | null }[]): number {
  return Number(rows[0]?.total ?? 0);
}

function readPositive(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}
