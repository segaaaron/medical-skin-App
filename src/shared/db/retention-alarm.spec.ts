// El alambre del plazo de conservación: que diga la verdad en los tres estados.
//
// Existe porque el barrido está apagado por una decisión de producto pendiente, y lo único que
// impide que «se conserva hasta 2036» se convierta en una frase olvidada es que alguien lo vea.

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { countRetentionDebt, retentionLine } from './retention-alarm';

describe('el aviso del plazo de conservación', () => {
  it('calla cuando no hay ningún plazo vivo', () => {
    expect(retentionLine({ expired: 0, pending: 0 })).toBeNull();
  });

  it('con plazos vivos y ninguno vencido, informa sin alarmar', () => {
    const line = retentionLine({ expired: 0, pending: 3 });
    expect(line).toContain('3');
    expect(line).not.toContain('AVISO');
    expect(line).toContain('barrido apagado');
  });

  it('con uno CUMPLIDO grita, y dice dónde está la decisión', () => {
    const line = retentionLine({ expired: 1, pending: 4 });
    expect(line).toContain('AVISO');
    expect(line).toContain('CUMPLIDO');
    // La salida, no solo el problema: quien lo lea tiene que saber qué falta decidir.
    expect(line).toContain('preguntas-abiertas.md');
  });
});

// Y LA CONSULTA, no solo la frase. La primera versión de este alambre leía `patient_link` a
// pelo con el rol de los trabajos —que no tiene `SELECT` sobre esa tabla— y **la API no
// arrancaba**. Las pruebas de arriba pasaban igual porque probaban la función pura: el camino
// que se cae es el que toca la base, así que es el que hay que ejecutar.
const app = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin',
  max: 1,
});

afterAll(async () => {
  await app.end();
});

describe('la consulta de la deuda de retención', () => {
  it('corre con el rol de los trabajos y devuelve dos números', async () => {
    const debt = await countRetentionDebt(app);
    expect(Number.isInteger(debt.expired)).toBe(true);
    expect(Number.isInteger(debt.pending)).toBe(true);
    // Lo que importa del invariante: nunca puede haber más vencidos que vivos.
    expect(debt.expired).toBeLessThanOrEqual(debt.pending);
  });
});
