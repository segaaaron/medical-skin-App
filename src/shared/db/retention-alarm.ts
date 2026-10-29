// EL ALAMBRE DEL PLAZO DE CONSERVACIÓN · 29 de octubre de 2026.
//
// El 200 de `DELETE /v1/accounts/mine` promete `se_conserva.hasta: <fecha>`, y **el barrendero
// que la cumplía está apagado**: borraba el dato de salud de seis tablas y dejaba dentro la nota
// clínica firmada, el evento adverso, el plan de cuidados, la incidencia y las observaciones, y
// escribía su sello igual, así que la ficha no volvía a ser candidata nunca. La decisión de qué
// se va está abierta en `docs/contratos/preguntas-abiertas.md` y es de producto con asesoría
// legal.
//
// Hoy eso es gratis: el vencimiento más temprano posible es 2033 y hay CERO fichas con un plazo
// vivo. El riesgo no es de hoy, es el de olvidarlo: «sin barrendero, el plazo no es un plazo, es
// una frase» (cabecera de la 0051), y el índice que encuentra los vencidos existe y no lo lee
// nadie.
//
// Esto lo lee. Al arrancar, cuenta los vínculos sueltos con el plazo ya cumplido y **lo dice en
// voz alta**. No tumba el proceso —apagar la API de una consulta porque venció un plazo legal
// sería peor que el problema— pero deja de ser silencio: una línea que nadie puso ahí por gusto
// y una fila de diagnóstico.

import type { Pool } from 'pg';

import { withTenantContext } from './tenant-context';

export type RetentionDebt = { expired: number; pending: number };

/**
 * Cuántos plazos hay cumplidos y sin barrer.
 *
 * POR FUNCIÓN (0062), y no leyendo `patient_link`: el rol de los trabajos no tiene `SELECT`
 * sobre esa tabla y no debe tenerlo —es también el rol de las peticiones sin sesión—. La
 * primera versión la leía a pelo y **la API no arrancaba**; lo encontró arrancarla, porque la
 * prueba de aquí al lado probaba la frase y no la consulta.
 *
 * La función entra por `patient_link_retention_idx` (0051), parcial sobre los vínculos sueltos
 * con plazo, así que no cuesta nada aunque la tabla crezca.
 */
export async function countRetentionDebt(pool: Pool): Promise<RetentionDebt> {
  return withTenantContext(pool, { role: 'app_anonymous' }, async (c) => {
    const { rows } = await c.query<{ expired: number; pending: number }>(
      'select * from medskin_retention_debt()',
    );
    return { expired: rows[0]?.expired ?? 0, pending: rows[0]?.pending ?? 0 };
  });
}

/** La línea del arranque. Silenciosa mientras no haya deuda, y ruidosa en cuanto la haya. */
export function retentionLine(debt: RetentionDebt): string | null {
  if (debt.expired > 0) {
    return (
      `AVISO · ${debt.expired} ficha(s) con el plazo de conservación CUMPLIDO y sin barrer, ` +
      'y el barrido está apagado por decisión pendiente: docs/contratos/preguntas-abiertas.md'
    );
  }
  if (debt.pending > 0) {
    return `plazos de conservación vivos: ${debt.pending} · ninguno vencido · barrido apagado`;
  }
  return null;
}
