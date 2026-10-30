// La escritura de la ficha médica por la paciente, con `app_patient`.
//
// CAMPO POR CAMPO, Y EL ÁRBITRO ES LA FUENTE: se escribe si está vacío (`fuente` nula) o si lo
// escribió ella (`fuente = 'patient'`). Lo que escribió la doctora se devuelve en
// `no_guardado`, no se pisa.
//
// NADA SE BORRA: cada campo que cambia deja su valor anterior en `medical_history_audit`, con
// quién y cuándo. «Son antecedentes médicos: el valor de ayer puede ser lo que explique una
// reacción de mañana.»

import type { Pool, PoolClient } from 'pg';

import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { HistoryDraft } from '../../accounts/domain/patient-registration';
import type { HistoryWriteResult, PatientHistoryWritePort } from '../domain/ports';

function contextOf(accountId: string): TenantContext {
  return { role: 'app_patient', accountId };
}

/**
 * Cada campo: cómo se llama en la API, qué columnas lo guardan, y de dónde sale su valor en el
 * borrador. `fototipo` y `notas` NO están y no pueden estar: `app_patient` no tiene `GRANT`
 * sobre esas columnas.
 */
const FIELDS = [
  {
    api: 'alergias',
    value: 'allergies',
    flag: 'has_allergies',
    source: 'allergies_source',
    at: 'allergies_source_at',
    of: (d: HistoryDraft) => ({ flag: d.hasAllergies, list: d.allergies }),
  },
  {
    api: 'medicacion',
    value: 'medication',
    flag: 'takes_medication',
    source: 'medication_source',
    at: 'medication_source_at',
    of: (d: HistoryDraft) => ({ flag: d.takesMedication, list: d.medication }),
  },
  {
    api: 'embarazo_o_lactancia',
    value: 'pregnancy_or_lactation',
    flag: null,
    source: 'pregnancy_or_lactation_source',
    at: 'pregnancy_or_lactation_source_at',
    of: (d: HistoryDraft) => ({ flag: null, list: d.pregnancyOrLactation }),
  },
  {
    api: 'antecedentes',
    value: 'past_conditions',
    flag: null,
    source: 'past_conditions_source',
    at: 'past_conditions_source_at',
    of: (d: HistoryDraft) => ({ flag: null, list: d.pastConditions }),
  },
  {
    api: 'tratamientos_previos',
    value: 'previous_treatments',
    flag: null,
    source: 'previous_treatments_source',
    at: 'previous_treatments_source_at',
    of: (d: HistoryDraft) => ({ flag: null, list: d.previousTreatments }),
  },
] as const;

export class PatientHistoryRepository implements PatientHistoryWritePort {
  constructor(private readonly pool: Pool) {}

  async write(
    accountId: string,
    linkId: string,
    draft: HistoryDraft,
  ): Promise<HistoryWriteResult> {
    return withTenantContext(this.pool, contextOf(accountId), async (c) => {
      // El vínculo primero: su política es por `account_id`, así que uno de otra cuenta no
      // devuelve fila. Y de aquí sale el `patient_id` de la escritura: si viniera del cuerpo,
      // sería escribir en la ficha de otra consulta.
      const { rows: links } = await c.query<{ patient_id: string; status: string }>(
        `select patient_id, status from patient_link where id = $1`,
        [linkId],
      );
      const link = links[0];
      if (link === undefined) return { outcome: 'no_link', saved: [], skipped: [] };
      if (link.status !== 'vinculada') return { outcome: 'not_accepted', saved: [], skipped: [] };

      const { rows: current } = await c.query<Record<string, unknown>>(
        `select ${FIELDS.map((f) => `${f.value}, ${f.source}, ${f.at}`).join(', ')}
           from medical_history where patient_id = $1 for update`,
        [link.patient_id],
      );
      const row = current[0];
      if (row === undefined) return { outcome: 'no_link', saved: [], skipped: [] };

      const saved: string[] = [];
      const skipped: string[] = [];

      for (const field of FIELDS) {
        const incoming = field.of(draft);
        // Un campo que el cuerpo no trae no se toca: el `PUT` es de la ficha entera, pero
        // `readHistory` deja en nulo lo que no vino y nulo aquí significa «no lo llenó».
        if (incoming.list === null || (Array.isArray(incoming.list) && incoming.list.length === 0 && incoming.flag === null)) {
          continue;
        }

        const source = row[field.source] as string | null;
        if (source === 'doctor') {
          skipped.push(field.api);
          continue;
        }

        await this.audit(c, {
          patientId: link.patient_id,
          accountId,
          field: field.api,
          previous: row[field.value],
          previousSource: source,
          previousAt: row[field.at] as Date | null,
        });

        const sets = [
          `${field.value} = $2`,
          `${field.source} = 'patient'`,
          `${field.at} = now()`,
          'updated_at = now()',
        ];
        const values: unknown[] = [link.patient_id, incoming.list];
        if (field.flag !== null) {
          sets.push(`${field.flag} = $3`);
          values.push(incoming.flag);
        }

        await c.query(
          `update medical_history set ${sets.join(', ')} where patient_id = $1`,
          values,
        );
        saved.push(field.api);
      }

      return { outcome: 'written', saved, skipped };
    });
  }

  /** El valor anterior, con quién lo había escrito. Nada se borra. */
  private async audit(
    c: PoolClient,
    p: {
      patientId: string;
      accountId: string;
      field: string;
      previous: unknown;
      previousSource: string | null;
      previousAt: Date | null;
    },
  ): Promise<void> {
    await c.query(
      `insert into medical_history_audit (practice_id, patient_id, field, previous_value,
                                          previous_source, previous_source_at,
                                          actor_account_id, actor_source)
       select h.practice_id, $1, $2, $3::jsonb, $4::medskin_history_source, $5, $6, 'patient'
         from medical_history h where h.patient_id = $1`,
      [
        p.patientId,
        p.field,
        JSON.stringify(p.previous ?? null),
        p.previousSource,
        p.previousAt,
        p.accountId,
      ],
    );
  }
}
