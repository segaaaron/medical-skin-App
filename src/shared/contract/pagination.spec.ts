// El lector de página. Dominio puro: sin base y sin HTTP.
//
// Lo que se fija aquí es lo único que este archivo decide, y es lo que protege a la API de una
// petición que pide la tabla entera: **el tope gana siempre**.

import { describe, expect, it } from 'vitest';

import { paginaDe, readPaginado, totalDe } from './pagination';

describe('readPaginado', () => {
  it('sin query, lo que diga el recurso', () => {
    expect(readPaginado({}, 50, 100)).toEqual({ page: 1, perPage: 50, offset: 0 });
  });

  it('EL TOPE GANA: pedir 5000 devuelve el máximo, no un 400', () => {
    // Si esto deja de pasar, un solo `GET` vuelve a poder arrastrar la tabla entera.
    expect(readPaginado({ por_pagina: '5000' }, 50, 100).perPage).toBe(100);
    expect(readPaginado({ por_pagina: 101 }, 50, 100).perPage).toBe(100);
    expect(readPaginado({ por_pagina: 100 }, 50, 100).perPage).toBe(100);
  });

  it('el desplazamiento sale de la página, y la primera no desplaza nada', () => {
    expect(readPaginado({ pagina: '1', por_pagina: '20' }, 50, 100).offset).toBe(0);
    expect(readPaginado({ pagina: '3', por_pagina: '20' }, 50, 100).offset).toBe(40);
  });

  it('lo que no es un entero positivo vale lo que vale por omisión', () => {
    // Un `pagina=abc` no merece un 400: la app no puede hacer nada con él, y la primera página
    // es la respuesta correcta a «no entendí qué página querías».
    for (const basura of ['abc', '', '0', '-2', '1.5', null, undefined, {}, []]) {
      expect(readPaginado({ pagina: basura, por_pagina: basura }, 50, 100)).toEqual({
        page: 1,
        perPage: 50,
        offset: 0,
      });
    }
  });

  it('cada recurso trae sus propios números', () => {
    expect(readPaginado({}, 20, 100).perPage).toBe(20);
    expect(readPaginado({}, 200, 500).perPage).toBe(200);
  });
});

describe('las tres claves de la respuesta', () => {
  it('son `cuantas`, `pagina` y `por_pagina`, las mismas que pacientes', () => {
    expect(paginaDe({ page: 2, perPage: 20, offset: 20 }, 137)).toEqual({
      cuantas: 137,
      pagina: 2,
      por_pagina: 20,
    });
  });

  it('`cuantas` sale de la fila, y sin filas es cero', () => {
    expect(totalDe([{ total: '137' }, { total: '137' }])).toBe(137);
    expect(totalDe([])).toBe(0);
    expect(totalDe([{ total: null }])).toBe(0);
  });
});
