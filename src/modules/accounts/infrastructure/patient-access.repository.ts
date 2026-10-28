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
      // Se leen CINCO columnas: el nombre, el correo, el celular, el nombre de quien la
      // atiende y la marca de envío de ahora —que no es del mensaje: es lo que hace falta
      // para poder deshacerla si el envío falla, porque acuñar la sobreescribe—. Ni una
      // clínica más, y nada del expediente.
      const { rows } = await c.query<{
        first_name: string;
        email: string;
        phone: string | null;
        practitioner_name: string;
        access_sent_at: Date | null;
      }>(
        `select p.first_name, l.email::text as email, p.phone, l.practitioner_name,
                l.access_sent_at
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
        accessSentAt: row.access_sent_at,
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

  async restoreAccessSentAt(
    owner: AccountOwner,
    accountId: string,
    previous: Date | null,
  ): Promise<void> {
    return withTenantContext(this.pool, contextFor(owner), async (c) => {
      // EL MISMO vínculo que marcó la función: el primero por `created_at` de esa cuenta en
      // esta consulta (`0006` · `medskin_resend_patient_access`). `practice_id` va escrito
      // aunque la política ya lo ponga, por lo mismo que en `accounts.repository.ts`: un
      // `UPDATE` cuyo alcance depende solo de RLS deja de estar acotado el día que algo
      // corra con `BYPASSRLS`.
      //
      // `$2` es el valor que la ficha tenía antes de acuñar: la fecha del último envío que
      // SÍ ocurrió, o nulo si nunca hubo ninguno.
      const undone = await c.query(
        `update patient_link set access_sent_at = $2, updated_at = now()
          where id = (select l.id from patient_link l
                       where l.account_id = $1 and l.practice_id = medskin_current_practice()
                       order by l.created_at limit 1)`,
        [accountId, previous],
      );
      if (undone.rowCount === 1) return;

      // Un fallo que no se puede compensar se registra, no se esconde: quien llama lo
      // convierte en el 500 del envío con las dos causas encadenadas.
      throw new Error(
        `la marca de envío de ${accountId} no se pudo deshacer: ${undone.rowCount ?? 0} filas`,
      );
    });
  }

  /**
   * `cuenta.acceso_pedido` Y NO `cuenta.acceso_enviado`, y el nombre es el arreglo.
   *
   * La fila se escribe al ACUÑAR, dentro de la misma transacción, y el envío pasa después:
   * cuando el relé falla, «enviado» era falso y `access_audit` es inmutable a propósito
   * —ningún rol tiene `UPDATE` ni `DELETE`—, así que no hay nada que compensar. Lo que esta
   * línea puede afirmar es lo que de verdad ocurrió en su transacción: que alguien pidió el
   * acceso, cuándo y por dónde. Si el envío salió o no, lo dice el 200 o el 500 de la
   * petición, y el fallo vive en `service_failure`.
   *
   * Lo que afirma un envío que ocurrió sigue siendo `patient_link.access_sent_at`, que es la
   * columna que la consola lee y la que el 500 devuelve a su valor anterior.
   */
  private async audit(
    c: PoolClient,
    owner: AccountOwner,
    subjectAccountId: string,
    via: string,
  ): Promise<void> {
    await c.query(
      `insert into access_audit (practice_id, actor_account_id, action, subject_type,
                                 subject_id, data)
       values ($1, $2, 'cuenta.acceso_pedido', 'cuenta', $3, $4)`,
      [owner.practiceId, owner.accountId, subjectAccountId, JSON.stringify({ via })],
    );
  }
}
