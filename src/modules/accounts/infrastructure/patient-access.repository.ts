// El acceso de su paciente, contra la base. Única puerta: `withTenantContext()`.
//
// La autorización es la POLÍTICA de `patient_link` sobre `practice_id`, más la función
// `SECURITY DEFINER` que empieza buscando ese vínculo con el `practice_id` del contexto. El
// `cuenta_id` que llega por la URL no autoriza nada: se usa como criterio de búsqueda
// DENTRO del inquilino del token, y si no hay fila, no hay respuesta (OWASP A01).

import type { Pool, PoolClient } from 'pg';

import { FAILURE_PHRASES, ServiceFailure } from '../../../shared/contract/error-catalog';
import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type {
  AccountOwner,
  PatientAccessPort,
  PatientForDelivery,
  ResendOutcome,
} from '../domain/ports';

/**
 * Siempre `app_practitioner`: este endpoint es de la doctora y de su equipo, y sus
 * políticas se leen por inquilino. Una paciente no llega aquí —no tiene el permiso y la
 * ruta exige alcance completo con `pacientes:acceso:enviar`—, y si llegara, su contexto no
 * fijaría `practice_id` y la función fallaría cerrada por falta de inquilino.
 */
function contextFor(owner: AccountOwner): TenantContext {
  return { role: 'app_practitioner', accountId: owner.accountId, practiceId: owner.practiceId };
}

export class PatientAccessRepository implements PatientAccessPort {
  constructor(private readonly pool: Pool) {}

  async forDelivery(owner: AccountOwner, accountId: string): Promise<PatientForDelivery | null> {
    return withTenantContext(this.pool, contextFor(owner), async (c) => {
      // Sin `where practice_id = …`: las políticas de `patient` y de `patient_link` lo
      // ponen, y el índice compuesto empieza por `practice_id` (§7.3, regla 5).
      // Se leen CUATRO columnas: el nombre, el correo, el celular y el nombre de quien la
      // atiende. Ni una clínica más, y nada del expediente.
      const { rows } = await c.query<{
        first_name: string;
        email: string;
        phone: string | null;
        practitioner_name: string;
      }>(
        `select p.first_name, l.email::text as email, p.phone, l.practitioner_name
           from patient_link l
           join patient p on p.id = l.patient_id
          where l.account_id = $1
          order by l.created_at
          limit 1`,
        [accountId],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return {
        firstName: row.first_name,
        email: row.email,
        phone: row.phone,
        practitionerName: row.practitioner_name,
      };
    });
  }

  async resend(p: {
    owner: AccountOwner;
    accountId: string;
    hash: string;
    expiresAt: Date;
    via: string;
  }): Promise<{ outcome: ResendOutcome; expiresAt: Date | null }> {
    return withTenantContext(this.pool, contextFor(p.owner), async (c) => {
      const { rows } = await c.query<{ outcome: string; expires_at: Date | null }>(
        'select * from medskin_resend_patient_access($1, $2, $3)',
        [p.accountId, p.hash, p.expiresAt],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new ServiceFailure(
          FAILURE_PHRASES.sendPatientAccess,
          new Error('medskin_resend_patient_access no devolvió veredicto'),
        );
      }

      // La línea de la bitácora la escribe el endpoint, que es quien sabe quién la pidió:
      // «una contraseña entregada dos veces es un hecho que alguien puede querer
      // reconstruir» (_convenciones.md · Idempotencia). La contraseña NO entra en la fila.
      if (row.outcome === 'acceso_renovado') {
        await this.audit(c, p.owner, p.accountId, p.via);
      }

      return { outcome: row.outcome as ResendOutcome, expiresAt: row.expires_at };
    });
  }

  private async audit(
    c: PoolClient,
    owner: AccountOwner,
    subjectAccountId: string,
    via: string,
  ): Promise<void> {
    await c.query(
      `insert into access_audit (practice_id, actor_account_id, action, subject_type,
                                 subject_id, data)
       values ($1, $2, 'cuenta.acceso_enviado', 'cuenta', $3, $4)`,
      [owner.practiceId, owner.accountId, subjectAccountId, JSON.stringify({ via })],
    );
  }
}
