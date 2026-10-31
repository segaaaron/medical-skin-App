// Las pacientes vistas desde la consola, contra la base · `pacientes-consola.md`, 31 oct 2026.
//
// Única puerta: `withTenantContext()` con `app_platform` y `medskin.account_id` = el `sub` del
// token. `practice_id` NO se fija: la consola cruza inquilinos a propósito y sus políticas son
// `current_user = 'app_platform'`.
//
// LO QUE ESTE ROL NO PUEDE, y lo dice la base y no este archivo (migración 0077):
//   · escribir `medical_history` — ni insertar, ni actualizar, ni borrar;
//   · tocar de `patient` más que `status`, `archived_at` y `updated_at`;
//   · borrar una paciente o escribir un vínculo.
// Si alguien «simplifica» este archivo escribiendo una historia, la consulta muere con
// «permiso denegado». Eso es el diseño, no un accidente.
//
// LA AUDITORÍA DE LA HISTORIA VA EN LA MISMA TRANSACCIÓN QUE LA LECTURA, y es la línea que
// sostiene `medskin-design.md` §4: si la fila no se escribe, la lectura no ocurre. Auditar
// después del `COMMIT` es no auditar.

import type { Pool, PoolClient } from 'pg';

import { withTenantContext, type TenantContext } from '../../shared/db/tenant-context';
import { nextCursor, type PatientSearch } from './domain';

export type ConsoleActor = { subject: string; label: string; region: string };

function contextOf(actor: ConsoleActor): TenantContext {
  return { role: 'app_platform', accountId: actor.subject };
}

export type PatientRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  status: string;
  createdOn: string;
  linkStatus: string | null;
  createdAt: Date;
};

export type PatientFile = PatientRow & {
  practiceId: string;
  practiceName: string;
  birthDate: string;
  phone: string | null;
  hasWhatsapp: boolean;
  howArrived: string;
  archivedAt: Date | null;
};

export type HistoryRow = Record<string, unknown>;

export class PlatformPatientsRepository {
  constructor(
    private readonly pool: Pool,
    /** La zona del despliegue: `alta_en` es fecha de calendario, no un instante. */
    private readonly timeZone: string,
  ) {}

  /** `GET /v1/platform/tenants/{id}/patients`. Devuelve `perPage + 1`: la de más dice que hay página. */
  async list(p: {
    actor: ConsoleActor;
    practiceId: string;
    search: PatientSearch;
  }): Promise<{ page: readonly PatientRow[]; next: string | null; patients: number; limit: number } | null> {
    return withTenantContext(this.pool, contextOf(p.actor), async (c) => {
      const { rows: consulta } = await c.query<{ patient_limit: number }>(
        'select patient_limit from practice where id = $1',
        [p.practiceId],
      );
      // Sin consulta no hay lista: es el `404 consulta_no_existe` del contrato.
      if (consulta[0] === undefined) return null;

      const { rows } = await c.query<{
        id: string; first_name: string; last_name: string; email: string | null;
        status: string; created_on: string; link_status: string | null; created_at: Date;
      }>(
        // `left join` a `patient_link`: una paciente sin cuenta todavía es una paciente, y su
        // vínculo nulo es lo que la pantalla pinta como «sin invitar».
        `select p.id, p.first_name, p.last_name, p.email::text as email, p.status,
                (p.created_at at time zone $2)::date::text as created_on,
                l.status as link_status, p.created_at
           from patient p
           left join patient_link l on l.patient_id = p.id
          where p.practice_id = $1
            and ($3::text is null
                 or p.first_name ilike '%' || $3 || '%'
                 or p.last_name ilike '%' || $3 || '%'
                 or p.email::text ilike '%' || $3 || '%')
            and ($4::text is null or p.status = $4)
            and ($5::timestamptz is null or (p.created_at, p.id) < ($5, $6::uuid))
          order by p.created_at desc, p.id desc
          limit $7`,
        [
          p.practiceId, this.timeZone, p.search.query, p.search.state,
          p.search.cursor?.at ?? null, p.search.cursor?.id ?? null, p.search.perPage + 1,
        ],
      );

      const filas: PatientRow[] = rows.map((r) => ({
        id: r.id, firstName: r.first_name, lastName: r.last_name, email: r.email,
        status: r.status, createdOn: r.created_on, linkStatus: r.link_status, createdAt: r.created_at,
      }));
      const { page, next } = nextCursor(filas, p.search.perPage, (r) => ({ at: r.createdAt, id: r.id }));

      // El recuento del plan es de fichas ACTIVAS, el mismo que ve la doctora: las archivadas
      // no cuentan contra el límite (decisión 38). Si se separan, la pantalla dice «148 de
      // 300» y la lista muestra otra cosa.
      const { rows: cuantas } = await c.query<{ n: string }>(
        `select count(*) as n from patient where practice_id = $1 and status = 'activa'`,
        [p.practiceId],
      );
      return { page, next, patients: Number(cuantas[0]?.n ?? 0), limit: consulta[0].patient_limit };
    });
  }

  /** `GET /v1/platform/patients/{pid}` · sin un solo campo clínico. */
  async read(p: { actor: ConsoleActor; patientId: string }): Promise<PatientFile | null> {
    return withTenantContext(this.pool, contextOf(p.actor), async (c) => {
      const { rows } = await c.query<{
        id: string; practice_id: string; practice_name: string; first_name: string;
        last_name: string; email: string | null; phone: string | null; has_whatsapp: boolean;
        how_arrived: string; status: string; archived_at: Date | null; birth_date: string;
        created_on: string; link_status: string | null; created_at: Date;
      }>(
        `select p.id, p.practice_id, pr.name as practice_name, p.first_name, p.last_name,
                p.email::text as email, p.phone, p.has_whatsapp, p.how_arrived, p.status,
                p.archived_at, p.birth_date::text as birth_date,
                (p.created_at at time zone $2)::date::text as created_on,
                l.status as link_status, p.created_at
           from patient p
           join practice pr on pr.id = p.practice_id
           left join patient_link l on l.patient_id = p.id
          where p.id = $1`,
        [p.patientId, this.timeZone],
      );
      const r = rows[0];
      if (r === undefined) return null;
      return {
        id: r.id, practiceId: r.practice_id, practiceName: r.practice_name,
        firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone,
        hasWhatsapp: r.has_whatsapp, howArrived: r.how_arrived, status: r.status,
        archivedAt: r.archived_at, birthDate: r.birth_date, createdOn: r.created_on,
        linkStatus: r.link_status, createdAt: r.created_at,
      };
    });
  }

  /**
   * `POST /v1/platform/patients/{pid}/medical-history/read`.
   *
   * LA AUDITORÍA PRIMERO Y EN LA MISMA TRANSACCIÓN, y el orden importa: si la función lanza
   * —motivo corto, sin contexto— no se lee nada. Y su `NULL` es el `404`: la comprobación de
   * que la paciente existe y la fila de auditoría son la MISMA operación, así que no se pueden
   * separar por accidente al refactorizar.
   */
  async readHistory(p: {
    actor: ConsoleActor;
    patientId: string;
    reason: string;
  }): Promise<HistoryRow | null> {
    return withTenantContext(this.pool, contextOf(p.actor), async (c) => {
      const { rows: auditada } = await c.query<{ practice: string | null }>(
        'select medskin_platform_history_read($1, $2) as practice',
        [p.patientId, p.reason],
      );
      if (auditada[0]?.practice == null) return null;

      const { rows } = await c.query<HistoryRow>(
        `select has_allergies, allergies, allergies_source, allergies_source_at,
                takes_medication, medication, medication_source, medication_source_at,
                pregnancy_or_lactation, pregnancy_or_lactation_source,
                pregnancy_or_lactation_source_at, phototype, phototype_source,
                phototype_source_at, past_conditions, past_conditions_source,
                past_conditions_source_at, previous_treatments, previous_treatments_source,
                previous_treatments_source_at, notes, notes_source, notes_source_at, updated_at
           from medical_history where patient_id = $1`,
        [p.patientId],
      );
      return rows[0] ?? {};
    });
  }

  /**
   * Archivar y reactivar. Mueve TRES columnas y es lo único que su `GRANT` admite: soporte no
   * corrige el nombre ni el correo de una paciente.
   *
   * Cero filas es el `404`. Archivar lo ya archivado devuelve la misma fila, que es la
   * idempotencia que el contrato promete.
   */
  async setStatus(p: {
    actor: ConsoleActor;
    patientId: string;
    status: 'activa' | 'archivada';
  }): Promise<{ status: string; archivedAt: Date | null } | null> {
    return withTenantContext(this.pool, contextOf(p.actor), async (c) => {
      if (p.status === 'activa') {
        const sitio = await this.hasRoom(c, p.patientId);
        if (sitio === 'no_existe') return null;
        if (sitio === 'lleno') throw new PlanFull();
      }
      const { rows } = await c.query<{ status: string; archived_at: Date | null }>(
        `update patient
            set status = $2,
                archived_at = case when $2 = 'archivada' then coalesce(archived_at, now()) else null end,
                updated_at = now()
          where id = $1
        returning status, archived_at`,
        [p.patientId, p.status],
      );
      const r = rows[0];
      return r === undefined ? null : { status: r.status, archivedAt: r.archived_at };
    });
  }

  /** Reactivar vuelve a ocupar cupo, así que puede chocar con el límite del plan. */
  private async hasRoom(c: PoolClient, patientId: string): Promise<'si' | 'lleno' | 'no_existe'> {
    const { rows } = await c.query<{ activas: string; patient_limit: number; propio: string }>(
      `select (select count(*) from patient a
                where a.practice_id = p.practice_id and a.status = 'activa') as activas,
              pr.patient_limit, p.status as propio
         from patient p join practice pr on pr.id = p.practice_id
        where p.id = $1`,
      [patientId],
    );
    const r = rows[0];
    if (r === undefined) return 'no_existe';
    // Si ya está activa, reactivarla no consume un cupo nuevo: es idempotente.
    if (r.propio === 'activa') return 'si';
    return Number(r.activas) < r.patient_limit ? 'si' : 'lleno';
  }
}

/** El `409 limite_del_plan` de reactivar, en un error para que deshaga la transacción. */
export class PlanFull extends Error {
  constructor() {
    super('la consulta llegó al límite de pacientes de su plan');
    this.name = 'PlanFull';
  }
}
