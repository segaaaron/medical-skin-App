// El catálogo de la paciente, con `app_patient` y los DOS contextos.
//
// AQUÍ ESTÁ LO DELICADO DEL ENDPOINT: la paciente no tiene contexto de inquilino, pero las
// políticas de `treatment`, `price` y `promotion` son por `practice_id`. Así que el
// `practice_id` se fija DESDE SU PROPIA FILA de `patient_link` —leída con `app_patient` y su
// política por `account_id`— y nunca desde el parámetro: el parámetro solo elige cuál de sus
// vínculos, y si no es suyo no hay fila y la respuesta es el 404.
//
// Aun así el contexto no es lo único que la protege: las políticas de estas tablas para
// `app_patient` son «existe un vínculo mío y aceptado con esa consulta» (0026), que es
// autoverificable. Fijar un `practice_id` ajeno a mano no abriría nada.

import type { Pool, PoolClient } from 'pg';

import { withTenantContext } from '../../../shared/db/tenant-context';
import type { CatalogTreatment, PatientCatalogPort, PatientFacts } from '../domain/ports';

export class PatientCatalogRepository implements PatientCatalogPort {
  constructor(private readonly pool: Pool) {}

  async read(accountId: string, practiceId: string): Promise<PatientFacts | 'invitada' | null> {
    // 1 · Su vínculo, con contexto de cuenta y nada más. De aquí sale el inquilino.
    const link = await withTenantContext(
      this.pool,
      { role: 'app_patient', accountId },
      async (c) => {
        const { rows } = await c.query<{
          practice_id: string;
          status: string;
          practice_name: string;
          patient_id: string;
        }>(
          `select practice_id, status, practice_name, patient_id from patient_link
            where practice_id = $1`,
          [practiceId],
        );
        return rows[0] ?? null;
      },
    );
    if (link === null) return null;
    if (link.status !== 'vinculada') return 'invitada';

    // 2 · El catálogo. `app_patient` NO FIJA INQUILINO —`withTenantContext()` lo prohíbe y
    // tiene razón: la paciente no pertenece a ninguno—, así que el `practice_id` de su vínculo
    // va como FILTRO de la consulta y la garantía la pone la política, que es «existe un
    // vínculo mío y aceptado con esa consulta» (0026). El parámetro solo elige cuál.
    return withTenantContext(
      this.pool,
      { role: 'app_patient', accountId },
      async (c) => {
        const { rows: history } = await c.query<Record<string, unknown>>(
          // Sin `join` con `patient`: `app_patient` no tiene `GRANT` sobre esa tabla y no se
          // le da. Su fecha de nacimiento sale de la función de la 0028, que devuelve una
          // fecha y solo de una consulta que la tenga vinculada.
          `select h.has_allergies, h.allergies, h.takes_medication, h.medication,
                  h.pregnancy_or_lactation, h.past_conditions,
                  medskin_patient_birth_date($2)::text as birth_date
             from medical_history h
            where h.patient_id = $1`,
          [link.patient_id, link.practice_id],
        );
        const own = history[0] ?? {};

        const { rows: treatments } = await c.query<Record<string, unknown>>(
          // Solo lo visible y activo: `visible_para_pacientes: false` es el tratamiento que
          // existe para la agenda interna y no se ofrece.
          //
          // La promoción que le toca: publicada, vigente hoy, con cupo libre, y que cubra este
          // tratamiento —sin filas en `promotion_treatment` significa todo el catálogo—. El
          // segmento NO se filtra aquí: «inactiva_meses» y «cumpleanos» necesitan historia de
          // sesiones, que es del tramo 5; hasta entonces se ofrecen las de segmento `todas`.
          `select t.id, t.name, t.category, t.description, t.duration_minutes,
                  t.min_interval_days,
                  (select cents from price p
                    where p.treatment_id = t.id and p.zone is null) as cents,
                  coalesce((select jsonb_agg(jsonb_build_object(
                              'key', ci.key, 'value', ci.value, 'absolute', ci.absolute))
                              from treatment_contraindication ci
                             where ci.treatment_id = t.id), '[]'::jsonb) as contraindications,
                  (select jsonb_build_object('id', pr.id, 'name', pr.name,
                                             'endsOn', pr.ends_on::text,
                                             'discountType', pr.discount_type,
                                             'discountValue', pr.discount_value)
                     from promotion pr
                    where pr.published
                      and pr.starts_on <= current_date and pr.ends_on >= current_date
                      and (pr.quota is null or pr.redeemed < pr.quota)
                      and pr.segment_key = 'todas'
                      and (not exists (select 1 from promotion_treatment pt
                                        where pt.promotion_id = pr.id)
                           or exists (select 1 from promotion_treatment pt
                                       where pt.promotion_id = pr.id
                                         and pt.treatment_id = t.id))
                    order by pr.ends_on, pr.id limit 1) as promotion
             from treatment t
            where t.practice_id = $1 and t.status = 'activo' and t.visible_to_patients
            order by t.name`,
          [link.practice_id],
        );

        return {
          practiceName: link.practice_name,
          currency: await currencyOf(c, link.practice_id),
          history: {
            hasAllergies: (own.has_allergies as boolean | null) ?? null,
            allergies: (own.allergies as string[] | null) ?? [],
            takesMedication: (own.takes_medication as boolean | null) ?? null,
            medication: (own.medication as string[] | null) ?? [],
            pregnancyOrLactation: (own.pregnancy_or_lactation as string | null) ?? null,
            // `phototype` NO está en el `GRANT SELECT` de `app_patient` sobre
            // `medical_history` (0006), así que no se puede leer por aquí y entra nulo: una
            // contraindicación por fototipo no bloquea su catálogo, y es correcto — quien la
            // evalúa es la doctora al verla.
            phototype: null,
            pastConditions: (own.past_conditions as string[] | null) ?? [],
          },
          birthDate: (own.birth_date as string | null) ?? '1900-01-01',
          treatments: treatments.map(mapTreatment),
        };
      },
    );
  }

}

/**
 * La moneda, por la función de la 0027: `app_patient` no lee `practice`, y darle política ahí
 * abriría todos los inquilinos para poder leer uno. Devuelve nulo si el vínculo no es suyo.
 */
async function currencyOf(c: { query: PoolClient['query'] }, practiceId: string): Promise<string> {
  const { rows } = await c.query<{ currency: string | null }>(
    'select medskin_patient_practice_currency($1) as currency',
    [practiceId],
  );
  return rows[0]?.currency ?? '';
}

function mapTreatment(row: Record<string, unknown>): CatalogTreatment {
  const promotion = row.promotion as CatalogTreatment['promotion'];
  return {
    id: row.id as string,
    name: row.name as string,
    category: row.category as string,
    description: (row.description as string | null) ?? null,
    durationMinutes: row.duration_minutes as number,
    minIntervalDays: (row.min_interval_days as number | null) ?? null,
    cents: (row.cents as number | null) ?? 0,
    contraindications: (row.contraindications as CatalogTreatment['contraindications']) ?? [],
    // La última sesión suya de este tratamiento es del tramo 5: hasta entonces el intervalo
    // mínimo no cierra nada, porque no hay nada que contar desde cuándo.
    lastSessionOn: null,
    promotion: promotion ?? null,
  };
}
