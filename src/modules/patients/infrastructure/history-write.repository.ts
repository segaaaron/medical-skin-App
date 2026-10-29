// PUT /v1/patients/{id}/medical-history · los antecedentes escritos por LA DOCTORA.
//
// LA ASIMETRÍA ES LA REGLA DEL TRAMO, y es deliberada: la paciente escribe un campo solo si
// está vacío o si lo escribió ella; **la doctora escribe cualquiera, siempre, porque es la
// responsable del expediente**. Por eso este camino no mira la fuente anterior y el de ella sí.
//
// Y NADA SE BORRA: cada campo que cambia deja su valor anterior en `medical_history_audit`, con
// quién y cuándo. «Son antecedentes médicos: el valor de ayer puede ser lo que explique una
// reacción de mañana.»

import type { Pool, PoolClient } from 'pg';

import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { HistoryDraft } from '../../accounts/domain/patient-registration';
import type { PracticeCaller } from '../domain/ports';

function contextOf(caller: PracticeCaller): TenantContext {
  return { role: 'app_practitioner', practiceId: caller.practiceId, accountId: caller.accountId };
}

/** Los siete campos, con sus columnas. `fototipo` y `notas` SOLO están aquí: son de ella. */
const FIELDS = [
  {
    api: 'alergias',
    value: 'allergies',
    flag: 'has_allergies',
    source: 'allergies_source',
    at: 'allergies_source_at',
    of: (d: HistoryDraft) => ({ flag: d.hasAllergies, value: d.allergies }),
  },
  {
    api: 'medicacion',
    value: 'medication',
    flag: 'takes_medication',
    source: 'medication_source',
    at: 'medication_source_at',
    of: (d: HistoryDraft) => ({ flag: d.takesMedication, value: d.medication }),
  },
  {
    api: 'embarazo_o_lactancia',
    value: 'pregnancy_or_lactation',
    flag: null,
    source: 'pregnancy_or_lactation_source',
    at: 'pregnancy_or_lactation_source_at',
    of: (d: HistoryDraft) => ({ flag: null, value: d.pregnancyOrLactation }),
  },
  {
    api: 'fototipo',
    value: 'phototype',
    flag: null,
    source: 'phototype_source',
    at: 'phototype_source_at',
    of: (d: HistoryDraft) => ({ flag: null, value: d.phototype }),
  },
  {
    api: 'antecedentes',
    value: 'past_conditions',
    flag: null,
    source: 'past_conditions_source',
    at: 'past_conditions_source_at',
    of: (d: HistoryDraft) => ({ flag: null, value: d.pastConditions }),
  },
  {
    api: 'tratamientos_previos',
    value: 'previous_treatments',
    flag: null,
    source: 'previous_treatments_source',
    at: 'previous_treatments_source_at',
    of: (d: HistoryDraft) => ({ flag: null, value: d.previousTreatments }),
  },
  {
    api: 'notas',
    value: 'notes',
    flag: null,
    source: 'notes_source',
    at: 'notes_source_at',
    of: (d: HistoryDraft) => ({ flag: null, value: d.notes }),
  },
] as const;

export class HistoryWriteRepository {
  constructor(private readonly pool: Pool) {}

  async write(
    caller: PracticeCaller,
    patientId: string,
    draft: HistoryDraft,
    /**
     * Qué campos NOMBRÓ el cuerpo. Hace falta porque `readHistory` normaliza un campo ausente a
     * `[]`, y escribir ese `[]` sería borrar lo que había y firmarlo como de la doctora. Es la
     * misma mezcla por campo del `PATCH` de la ficha: lo que no se nombra no se toca.
     */
    named: ReadonlySet<string>,
  ): Promise<{ outcome: 'written' | 'no_patient' | 'archived'; saved: readonly string[] }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows: patients } = await c.query<{ status: string }>(
        `select status from patient where id = $1 for update`,
        [patientId],
      );
      const patient = patients[0];
      if (patient === undefined) return { outcome: 'no_patient', saved: [] };
      // «Esa ficha está archivada. Reactívala antes de editarla.»
      if (patient.status === 'archivada') return { outcome: 'archived', saved: [] };

      const { rows: current } = await c.query<Record<string, unknown>>(
        `select ${FIELDS.map((f) => `${f.value}, ${f.source}, ${f.at}`).join(', ')}
           from medical_history where patient_id = $1 for update`,
        [patientId],
      );
      const row = current[0];
      if (row === undefined) return { outcome: 'no_patient', saved: [] };

      const saved: string[] = [];
      for (const field of FIELDS) {
        // Lo que el cuerpo no nombra NO SE TOCA. Vaciar un campo es nombrarlo con `null`, y eso
        // sí queda registrado como un cambio.
        if (!named.has(field.api)) continue;
        const incoming = field.of(draft);

        await this.audit(c, {
          patientId,
          accountId: caller.accountId,
          field: field.api,
          previous: row[field.value],
          previousSource: row[field.source] as string | null,
          previousAt: row[field.at] as Date | null,
        });

        const sets = [
          `${field.value} = $2`,
          `${field.source} = 'doctora'`,
          `${field.at} = now()`,
          'updated_at = now()',
        ];
        const values: unknown[] = [patientId, incoming.value];
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

      return { outcome: 'written', saved };
    });
  }

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
       select h.practice_id, $1, $2, $3::jsonb, $4::medskin_history_source, $5, $6, 'doctora'
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
