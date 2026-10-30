// Las lecturas de `pacientes.md`, con `app_practitioner` y `withTenantContext()`.
//
// NINGUNA CONSULTA LLEVA `where practice_id`, y es a propósito: lo acota la política de
// `patient` sobre esa columna, tomada del contexto de la transacción. Escribirlo además
// escondería el día que la política dejara de estar.
//
// Las dos formas del `ORDER BY` van con `DESC NULLS FIRST` LITERAL, que es lo que
// `patient_practice_status_idx` indexa desde la 0011: con `DESC` a secas Postgres entiende
// `NULLS LAST`, son dos ordenaciones distintas, y el índice deja de servir —ordenaba las fichas
// del inquilino enteras para devolver 50.

import type { Pool, PoolClient } from 'pg';

import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { HistoryRow } from '../domain/history-view';
import type {
  AccessState,
  LinkStatus,
  PatientFileRow,
  PatientPage,
  PatientQuery,
  PatientReadPort,
  PracticeCaller,
} from '../domain/ports';

/** Lo que la consola NO puede hacer y esta sí: leer fichas. El rol es el de la consulta. */
function contextOf(caller: PracticeCaller): TenantContext {
  return { role: 'app_practitioner', practiceId: caller.practiceId, accountId: caller.accountId };
}

type ListRow = {
  id: string;
  first_name: string;
  last_name: string;
  birth_date: string;
  phone: string | null;
  link_status: LinkStatus | null;
  has_allergies: boolean | null;
  pregnancy_or_lactation: string | null;
  total: string;
};

export class PatientsReadRepository implements PatientReadPort {
  constructor(private readonly pool: Pool) {}

  async list(caller: PracticeCaller, query: PatientQuery): Promise<PatientPage> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // `count(*) over ()` y no una segunda consulta: el total y la página salen del mismo
      // recorrido, así que no hay forma de que digan cosas distintas entre dos lecturas.
      //
      // La búsqueda son DOS predicados y hacen falta los dos, medido el 28 de octubre:
      //   · `like '%x%'` encuentra «valeri» dentro de «Valeria Antelo», que es lo que hace la
      //     pantalla mientras se teclea;
      //   · `$1 <% search_text` (similitud POR PALABRA) es la tolerancia al error de tipeo.
      // `similarity_op` a secas —`search_text % $1`— NO sirve aquí y por eso no está: compara
      // la cadena ENTERA contra el texto entero, así que «valeri» contra «valeria antelo
      // valeria.21@… +5917…» queda muy por debajo del umbral y no devuelve nada.
      // Los dos los soporta `gin_trgm_ops`, y ninguno es LEAKPROOF: con RLS puesta lo que
      // recorre el índice es el inquilino y esto filtra encima.
      const { rows } = await c.query<ListRow>(
        `select p.id, p.first_name, p.last_name, to_char(p.birth_date, 'YYYY-MM-DD') as birth_date, p.phone,
                l.status as link_status,
                h.has_allergies, h.pregnancy_or_lactation,
                count(*) over () ::text as total
           from patient p
           left join patient_link l on l.patient_id = p.id
           left join medical_history h on h.patient_id = p.id
          where ($1::text is null
                 or p.search_text like '%' || $1 || '%'
                 or $1 <% p.search_text)
            and ($2::text = 'todas' or p.status = $2)
            and ($3::text is null or l.status = $3)
          order by p.created_at desc nulls first, p.id
          limit $4 offset $5`,
        [
          query.search === null ? null : query.search.toLowerCase(),
          query.status,
          query.link,
          query.perPage,
          (query.page - 1) * query.perPage,
        ],
      );

      return {
        total: Number(rows[0]?.total ?? 0),
        rows: rows.map((row) => ({
          id: row.id,
          firstName: row.first_name,
          lastName: row.last_name,
          birthDate: row.birth_date,
          phone: row.phone,
          // Sin vínculo no hay estado que enseñar, y el contrato no tiene un cuarto valor:
          // `invitada` es lo que significa una ficha a la que todavía no se le mandó nada.
          linkStatus: row.link_status ?? 'invitada',
          hasAllergies: row.has_allergies,
          pregnancyOrLactation: row.pregnancy_or_lactation,
        })),
      };
    });
  }

  async file(caller: PracticeCaller, patientId: string): Promise<PatientFileRow | null> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query<Record<string, unknown>>(
        `select p.id, p.first_name, p.last_name, to_char(p.birth_date, 'YYYY-MM-DD') as birth_date,
                p.email::text as email, p.phone, p.has_whatsapp, p.reminders_via,
                p.how_arrived, p.referred_by, p.status, p.created_at,
                r.first_name as referred_first, r.last_name as referred_last,
                l.status as link_status, l.email::text as link_email, l.access_sent_at,
                l.account_id,
                h.has_allergies, h.allergies, h.allergies_source, h.allergies_source_at,
                h.takes_medication, h.medication, h.medication_source, h.medication_source_at,
                h.pregnancy_or_lactation, h.pregnancy_or_lactation_source,
                h.pregnancy_or_lactation_source_at,
                h.phototype, h.phototype_source, h.phototype_source_at,
                h.past_conditions, h.past_conditions_source, h.past_conditions_source_at,
                h.previous_treatments, h.previous_treatments_source,
                h.previous_treatments_source_at,
                h.notes, h.notes_source, h.notes_source_at, h.updated_at as history_updated_at
           from patient p
           -- La referida es otra ficha DE ESTA CONSULTA: el join pasa por la misma política,
           -- así que un referred_by que apuntara fuera devolvería nulo en vez de un nombre.
           left join patient r on r.id = p.referred_by
           left join patient_link l on l.patient_id = p.id
           left join medical_history h on h.patient_id = p.id
          where p.id = $1`,
        [patientId],
      );
      const row = rows[0];
      if (row === undefined) return null;

      // «Abrir una ficha queda en la auditoría, con quién y cuándo. Eso no tiene interruptor.»
      // Dentro de la misma transacción que la lectura: si el rastro no se puede escribir, la
      // ficha no se sirve.
      await this.audit(c, caller, patientId);

      return mapFile(row);
    });
  }

  async accessState(caller: PracticeCaller, accountId: string): Promise<AccessState> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query<{ linked: boolean; password_chosen: boolean | null }>(
        'select linked, password_chosen from medskin_patient_access_state($1)',
        [accountId],
      );
      const row = rows[0];
      return {
        linked: row?.linked ?? false,
        passwordChosen: row?.password_chosen ?? null,
      };
    });
  }

  private async audit(c: PoolClient, caller: PracticeCaller, patientId: string): Promise<void> {
    await c.query(
      `insert into access_audit (practice_id, actor_account_id, action, subject_type, subject_id,
                                 data)
       values (medskin_current_practice(), $1, 'paciente.ficha_abierta', 'paciente', $2, '{}')`,
      [caller.accountId, patientId],
    );
  }
}

function mapFile(row: Record<string, unknown>): PatientFileRow {
  const referredFirst = row.referred_first as string | null;
  const referredLast = row.referred_last as string | null;

  return {
    id: row.id as string,
    firstName: row.first_name as string,
    lastName: row.last_name as string,
    birthDate: row.birth_date as string,
    email: row.email as string,
    phone: row.phone as string | null,
    hasWhatsapp: row.has_whatsapp as boolean,
    remindersVia: row.reminders_via as string,
    howArrived: row.how_arrived as string,
    referredById: (row.referred_by as string | null) ?? null,
    referredByName:
      referredFirst === null || referredLast === null ? null : `${referredFirst} ${referredLast}`,
    status: row.status as string,
    createdAt: row.created_at as Date,
    link:
      row.link_status === null || row.link_status === undefined
        ? null
        : {
            status: row.link_status as LinkStatus,
            email: row.link_email as string,
            accessSentAt: (row.access_sent_at as Date | null) ?? null,
            accountId: (row.account_id as string | null) ?? null,
          },
    history: row.history_updated_at === null || row.history_updated_at === undefined
      ? null
      : mapHistory(row),
  };
}

function mapHistory(row: Record<string, unknown>): HistoryRow {
  return {
    hasAllergies: (row.has_allergies as boolean | null) ?? null,
    allergies: (row.allergies as string[] | null) ?? [],
    allergiesSource: (row.allergies_source as string | null) ?? null,
    allergiesSourceAt: (row.allergies_source_at as Date | null) ?? null,
    takesMedication: (row.takes_medication as boolean | null) ?? null,
    medication: (row.medication as string[] | null) ?? [],
    medicationSource: (row.medication_source as string | null) ?? null,
    medicationSourceAt: (row.medication_source_at as Date | null) ?? null,
    pregnancyOrLactation: (row.pregnancy_or_lactation as string | null) ?? null,
    pregnancySource: (row.pregnancy_or_lactation_source as string | null) ?? null,
    pregnancySourceAt: (row.pregnancy_or_lactation_source_at as Date | null) ?? null,
    phototype: (row.phototype as number | null) ?? null,
    phototypeSource: (row.phototype_source as string | null) ?? null,
    phototypeSourceAt: (row.phototype_source_at as Date | null) ?? null,
    pastConditions: (row.past_conditions as string[] | null) ?? [],
    pastConditionsSource: (row.past_conditions_source as string | null) ?? null,
    pastConditionsSourceAt: (row.past_conditions_source_at as Date | null) ?? null,
    previousTreatments: (row.previous_treatments as string[] | null) ?? [],
    previousTreatmentsSource: (row.previous_treatments_source as string | null) ?? null,
    previousTreatmentsSourceAt: (row.previous_treatments_source_at as Date | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    notesSource: (row.notes_source as string | null) ?? null,
    notesSourceAt: (row.notes_source_at as Date | null) ?? null,
    updatedAt: row.history_updated_at as Date,
  };
}
