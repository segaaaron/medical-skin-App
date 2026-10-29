// Las escrituras de la ficha: el `PATCH`, el archivado y la reactivación.
//
// `app_practitioner` tiene `UPDATE` sobre `patient` y su política es por `practice_id`, así que
// el `UPDATE` no alcanza una fila de otra consulta: cero filas, y eso es el `404` del contrato.
// Nada de `where practice_id` escrito a mano.

import type { Pool } from 'pg';

import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { PatientEdit } from '../domain/editing';
import type { ArchiveResult, EditResult, PatientWritePort, PracticeCaller } from '../domain/ports';

function contextOf(caller: PracticeCaller): TenantContext {
  return { role: 'app_practitioner', practiceId: caller.practiceId, accountId: caller.accountId };
}

/** Columna de la base por campo del dominio. Lo que no está aquí no se puede escribir. */
const COLUMNS: Readonly<Record<keyof PatientEdit, string>> = {
  firstName: 'first_name',
  lastName: 'last_name',
  birthDate: 'birth_date',
  email: 'email',
  phone: 'phone',
  hasWhatsapp: 'has_whatsapp',
  remindersVia: 'reminders_via',
  howArrived: 'how_arrived',
  referredBy: 'referred_by',
};

export class PatientsWriteRepository implements PatientWritePort {
  constructor(private readonly pool: Pool) {}

  async edit(
    caller: PracticeCaller,
    patientId: string,
    edit: PatientEdit,
  ): Promise<EditResult> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // El estado primero, y en la misma transacción: una ficha archivada no se edita, y
      // leerlo fuera dejaría la ventana en que se archiva entre la comprobación y el `UPDATE`.
      const { rows: current } = await c.query<{ status: string; linked: boolean }>(
        `select p.status, exists (select 1 from patient_link l
                                   where l.patient_id = p.id and l.account_id is not null) as linked
           from patient p where p.id = $1 for update`,
        [patientId],
      );
      const patient = current[0];
      if (patient === undefined) return { outcome: 'no_patient', linked: false };
      if (patient.status === 'archivada') return { outcome: 'archived', linked: patient.linked };

      if (edit.referredBy !== undefined && edit.referredBy !== null) {
        const { rows: referrer } = await c.query(`select 1 from patient where id = $1`, [
          edit.referredBy,
        ]);
        if (referrer.length === 0) return { outcome: 'no_referrer', linked: patient.linked };
      }

      // El `SET` se arma con la lista blanca de arriba y los valores van como parámetros: lo
      // único que viene del cuerpo son los valores, nunca un nombre de columna.
      const fields = Object.keys(edit) as (keyof PatientEdit)[];
      const sets = fields.map((field, i) => `${COLUMNS[field]} = $${i + 2}`);
      const values = fields.map((field) => edit[field]);

      await c.query(
        `update patient set ${sets.join(', ')}, updated_at = now() where id = $1`,
        [patientId, ...values],
      );

      await c.query(
        `insert into access_audit (practice_id, actor_account_id, action, subject_type,
                                   subject_id, data)
         values (medskin_current_practice(), $1, 'paciente.ficha_editada', 'paciente', $2, $3)`,
        // Qué campos cambiaron, NUNCA sus valores: `access_audit` lo lee la consulta entera y
        // un correo o un celular ahí convertiría la bitácora en un padrón de contacto.
        [caller.accountId, patientId, JSON.stringify({ campos: fields })],
      );

      return { outcome: 'edited', linked: patient.linked };
    });
  }

  async archive(
    caller: PracticeCaller,
    patientId: string,
    archived: boolean,
  ): Promise<ArchiveResult> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // «Una ficha archivada con una cita viva es una paciente que se presenta y no está en la
      // agenda.» Se mira ANTES del `UPDATE` y en la misma transacción, y solo al archivar:
      // reactivar no tiene nada que comprobar. Una cita viva es una por delante que no está
      // cancelada ni atendida; la política de `appointment` ya la acota a esta consulta.
      if (archived) {
        const { rows: live } = await c.query<{ id: string }>(
          `select a.id from appointment a
            where a.patient_id = $1
              and a.status in ('pendiente_de_sena', 'confirmada')
              and a.starts_at > now()
            limit 1`,
          [patientId],
        );
        if (live.length > 0) {
          return { outcome: 'future_appointment', status: '', archivedAt: null };
        }
      }

      const { rows } = await c.query<{ status: string; archived_at: Date | null }>(
        `update patient
            set status = $2,
                -- La fecha del archivado DE VERDAD: archivar lo archivado no la mueve, y
                -- reactivar la borra porque ya no hay archivado que fechar.
                archived_at = case when $2 = 'archivada' then coalesce(archived_at, now())
                                   else null end,
                updated_at = now()
          where id = $1
          returning status, archived_at`,
        [patientId, archived ? 'archivada' : 'activa'],
      );
      const row = rows[0];
      if (row === undefined) return { outcome: 'no_patient', status: '', archivedAt: null };

      await c.query(
        `insert into access_audit (practice_id, actor_account_id, action, subject_type,
                                   subject_id, data)
         values (medskin_current_practice(), $1, $2, 'paciente', $3, '{}')`,
        [
          caller.accountId,
          archived ? 'paciente.archivada' : 'paciente.reactivada',
          patientId,
        ],
      );

      return { outcome: 'done', status: row.status, archivedAt: row.archived_at };
    });
  }
}
