// Los vínculos de la paciente, con `app_patient` y SOLO `medskin.account_id` en el contexto:
// no hay consulta que fijar porque esta es la lectura que los cruza a propósito.
//
// `app_patient` tiene `GRANT UPDATE (status, updated_at)` sobre `patient_link` y su política es
// `account_id = medskin_current_account()`: el `vinculo_id` de la URL no autoriza nada, es
// criterio de búsqueda bajo esa política. Un vínculo de otra cuenta no devuelve fila, y eso es
// el `404` del contrato.

import type { Pool } from 'pg';

import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { LinkDecision, LinkRow, LinkStatus, PatientLinkPort } from '../domain/ports';

function contextOf(accountId: string): TenantContext {
  return { role: 'app_patient', accountId };
}

type Row = {
  id: string;
  status: LinkStatus;
  practice_name: string;
  practitioner_name: string;
  city: string | null;
  created_at: Date;
  history_by_patient: boolean;
};

/**
 * `ficha_medica_pendiente` sale de si algún campo de sus antecedentes lleva fuente `paciente`.
 * No hace falta función: `app_patient` SÍ tiene política de lectura sobre `medical_history`, y
 * es `EXISTS (… l.account_id = medskin_current_account() AND l.status = 'vinculada')`. Para un
 * vínculo todavía `invitada` la política esconde la fila, así que el `EXISTS` da falso y el
 * pendiente queda en `true`, que es la verdad: todavía no llenó nada.
 */
function select(one: boolean): string {
  return `
  select l.id, l.status, l.practice_name, l.practitioner_name, l.city, l.created_at,
         exists (select 1 from medical_history h
                  where h.patient_id = l.patient_id
                    and 'patient' in (h.allergies_source, h.medication_source,
                                       h.pregnancy_or_lactation_source,
                                       h.past_conditions_source,
                                       h.previous_treatments_source)) as history_by_patient
    from patient_link l
   ${one ? 'where l.id = $1' : ''}
   order by l.created_at desc nulls first, l.id`;
}

export class PatientLinksRepository implements PatientLinkPort {
  constructor(private readonly pool: Pool) {}

  async list(accountId: string): Promise<readonly LinkRow[]> {
    return withTenantContext(this.pool, contextOf(accountId), async (c) => {
      const { rows } = await c.query<Row>(select(false));
      return rows.map(mapRow);
    });
  }

  async decide(accountId: string, linkId: string, accept: boolean): Promise<LinkDecision> {
    return withTenantContext(this.pool, contextOf(accountId), async (c) => {
      // `for update` para que dos toques del mismo botón no se pisen: el segundo espera y
      // encuentra el estado ya movido, que es el `409 vinculo_ya_resuelto`.
      const { rows: current } = await c.query<{ status: LinkStatus }>(
        `select status from patient_link where id = $1 for update`,
        [linkId],
      );
      const link = current[0];
      if (link === undefined) return { outcome: 'no_link' };
      // «Una paciente con N vínculos los resuelve uno por uno»: solo `invitada` se decide.
      if (link.status !== 'invitada') return { outcome: 'already_resolved' };

      // Rechazar NO borra la ficha: el expediente es de la consulta y se conserva. Lo que se
      // corta es su acceso y sus avisos, y la doctora lo ve en la ficha la próxima vez que la
      // abra —avisarle por notificación convertiría un «no, gracias» en una conversación.
      await c.query(
        `update patient_link set status = $2, updated_at = now() where id = $1`,
        [linkId, accept ? 'vinculada' : 'revocada'],
      );

      const { rows } = await c.query<Row>(select(true), [linkId]);
      const row = rows[0];
      if (row === undefined) {
        // La fila que esta misma transacción acaba de escribir tiene que estar.
        throw new Error(`el vínculo ${linkId} no se pudo releer después de decidirlo`);
      }
      return { outcome: 'decided', row: mapRow(row) };
    });
  }
}

function mapRow(row: Row): LinkRow {
  return {
    id: row.id,
    status: row.status,
    practiceName: row.practice_name,
    practitionerName: row.practitioner_name,
    city: row.city,
    createdAt: row.created_at,
    historyWrittenByPatient: row.history_by_patient,
  };
}
