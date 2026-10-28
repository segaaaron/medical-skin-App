// La guarda que le faltaba a `app_platform` en `withTenantContext()`: la vio
// `revisor-senior` y era la única de los cinco roles sin cerradura.
//
// No se re-verifican las otras cuatro, que ya están probadas donde tocaba. Esta prueba
// comprueba además algo que la de los otros roles no dice: que la guarda **falla antes de
// abrir una conexión**. Por eso el `Pool` apunta a un puerto donde no escucha nadie: si la
// comprobación se hiciera después de `pool.connect()`, el error sería de red y no el
// nuestro, y la prueba lo distinguiría.

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenantContext } from './tenant-context';

const nowhere = new Pool({ connectionString: 'postgresql://nadie:nadie@127.0.0.1:1/nada', max: 1 });

afterAll(async () => {
  await nowhere.end();
});

describe('withTenantContext · la guarda de app_platform', () => {
  it('rechaza un practiceId para la consola, y lo rechaza sin abrir una conexión', async () => {
    const abrir = withTenantContext(
      nowhere,
      {
        role: 'app_platform',
        accountId: '3d3d3d3d-0000-4000-8000-00000000000a',
        practiceId: '3d3d3d3d-0000-4000-8000-00000000000b',
      },
      () => Promise.resolve('no se debería llegar aquí'),
    );

    // El mensaje nombra la razón —ninguna política de la consola lee `medskin.practice_id`—
    // y no es un error de red: si lo fuera, la comprobación llegaría tarde.
    await expect(abrir).rejects.toThrow('app_platform no fija practiceId');
    await expect(abrir).rejects.not.toThrow(/ECONNREFUSED|connect/i);
  });

  it('sin practiceId la consola pasa la comprobación y lo que falla ya es la conexión', async () => {
    // El otro lado de la guarda: lo que se rechaza es el inquilino, no el rol. Aquí el
    // contexto es válido y el único error posible es el del puerto vacío, que es
    // exactamente lo que prueba que la guarda no se disparó.
    await expect(
      withTenantContext(
        nowhere,
        { role: 'app_platform', accountId: '3d3d3d3d-0000-4000-8000-00000000000a' },
        () => Promise.resolve('tampoco se llega'),
      ),
    ).rejects.not.toThrow('app_platform no fija practiceId');
  });
});
