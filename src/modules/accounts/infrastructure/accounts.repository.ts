// El repositorio de las cuentas. La ÚNICA puerta a la base es `withTenantContext()`, que
// abre la transacción, adopta el rol y fija los dos contextos. Aquí no hay un solo
// `pool.query()`.
//
// Las dos escrituras llevan `where account_id = medskin_current_account()` y es REDUNDANTE:
// las políticas de `credential` y de `session` ya dicen eso mismo, y `isolation.spec.ts` lo
// prueba. Está escrito igual porque un `UPDATE` sin `WHERE` solo es correcto mientras RLS
// se aplique: un rol con `BYPASSRLS` o un script del dueño lo convierten en una reescritura
// de la tabla entera, y el cinturón no cuesta nada. El `account_id` sigue saliendo del
// CONTEXTO —del token— y nunca de un identificador del cliente (OWASP A01); por eso va la
// función y no un parámetro.

import type { Pool, PoolClient } from 'pg';

import { FAILURE_PHRASES, ServiceFailure } from '../../../shared/contract/error-catalog';
import type { Region } from '../../../shared/contract/session';
import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type {
  AccountDeletionPort,
  AccountOwner,
  DeletionResult,
  DeletionVerdict,
  LinkedPractice,
  OwnCredentialPort,
  OwnProfile,
  OwnProfilePort,
} from '../domain/ports';

function contextFor(owner: AccountOwner): TenantContext {
  // `app_practitioner` exige inquilino porque sus políticas se leen por inquilino;
  // `app_patient` no lo fija nunca porque la paciente no pertenece a ninguno (§12.2.1).
  if (owner.accountRole === 'paciente') {
    return { role: 'app_patient', accountId: owner.accountId };
  }
  return { role: 'app_practitioner', accountId: owner.accountId, practiceId: owner.practiceId };
}

/**
 * El rol de base de una SESIÓN RESTRINGIDA, la que todavía no eligió su contraseña:
 * `app_account`, que llega a `account`, `credential` y `patient_link` por cuenta y a nada
 * más. No `app_patient` ni `app_practitioner`: esos llevan además el `UPDATE` de
 * `credential.hash`, el de `medical_history` y el `EXECUTE` del borrado de cuenta, que la
 * 0014 le niega por escrito a una sesión a medio abrir (§5.6 del napkin).
 */
function restrictedContextFor(owner: AccountOwner): TenantContext {
  return { role: 'app_account', accountId: owner.accountId };
}

export class AccountsRepository
  implements OwnCredentialPort, OwnProfilePort, AccountDeletionPort
{
  /**
   * `zone` es la zona del despliegue y la usa UNA columna: el `desde` de cada doctora es una
   * etiqueta de día («2026-03-01») y no un instante, así que el `::date` se calcula en esa
   * zona. Con el UTC de la conexión, un vínculo creado a las 21:00 en La Paz se mostraría al
   * día siguiente.
   */
  constructor(
    private readonly pool: Pool,
    private readonly zone: string,
  ) {}

  async readMine(owner: AccountOwner): Promise<{ hash: string } | null> {
    return withTenantContext(this.pool, contextFor(owner), async (c) => {
      const { rows } = await c.query<{ hash: string }>('select * from medskin_current_credential()');
      const row = rows[0];
      return row === undefined ? null : { hash: row.hash };
    });
  }

  async replace(p: { owner: AccountOwner; hash: string }): Promise<{ sessionsRevoked: number }> {
    return withTenantContext(this.pool, contextFor(p.owner), async (c) => {
      // `is_temporary` NO se toca: a esta pantalla solo se llega con alcance `completo`, y
      // una credencial con alcance completo ya dejó de ser temporal. Marcarla aquí sería
      // escribir una columna que otra cosa ya decidió.
      const written = await c.query(
        `update credential set hash = $1, set_at = now(), updated_at = now()
          where account_id = medskin_current_account()`,
        [p.hash],
      );
      if (written.rowCount !== 1) {
        throw new ServiceFailure(
          FAILURE_PHRASES.changePassword,
          new Error(
            `la credencial de ${p.owner.accountId} no se pudo escribir: ${written.rowCount ?? 0} filas`,
          ),
        );
      }

      // «Quien tuviera la contraseña vieja se queda fuera.» El `refresh_hash` no se borra
      // a propósito: con él puesto, un refresco de una sesión revocada se distingue de uno
      // inventado, y son dos frases distintas en `sesion.md`.
      const revoked = await c.query(
        `update session set revoked_at = now(), revoked_reason = 'password_changed'
          where account_id = medskin_current_account() and id <> $1 and revoked_at is null`,
        [p.owner.sessionId],
      );

      await this.audit(c, p.owner);

      return { sessionsRevoked: revoked.rowCount ?? 0 };
    });
  }

  // -------------------------------------------------------------------------------------
  // GET /v1/accounts/mine
  // -------------------------------------------------------------------------------------

  async readProfile(p: {
    owner: AccountOwner;
    restricted: boolean;
    withLinks: boolean;
  }): Promise<OwnProfile | null> {
    const context = p.restricted ? restrictedContextFor(p.owner) : contextFor(p.owner);

    return withTenantContext(this.pool, context, async (c) => {
      // SIN `where`: las políticas `account_own` y `credential_own` son
      // `id = medskin_current_account()` y `account_id = medskin_current_account()`, así que
      // la fila que vuelve es la de quien pregunta y no puede ser otra. El `hash` NO se
      // nombra: no hay `GRANT SELECT (hash)` para ningún rol de aplicación y pedirlo sería
      // «permiso denegado», que es justo la garantía.
      //
      // `left join` porque una cuenta puede no tener credencial —el borrado la borra— y
      // entonces `contrasena_es_temporal` es falso, no nulo.
      const { rows } = await c.query<{
        email: string;
        first_name: string;
        last_name: string;
        phone: string | null;
        status: string;
        region: string;
        is_temporary: boolean;
      }>(
        `select a.email::text as email, a.first_name, a.last_name, a.phone, a.status,
                a.region, coalesce(c.is_temporary, false) as is_temporary
           from account a
           left join credential c on c.account_id = a.id`,
      );
      const row = rows[0];
      if (row === undefined) return null;

      return {
        email: row.email,
        firstName: row.first_name,
        lastName: row.last_name,
        phone: row.phone,
        status: row.status,
        region: row.region as Region,
        passwordIsTemporary: row.is_temporary,
        doctoras: p.withLinks ? await this.linksOf(c) : [],
      };
    });
  }

  /**
   * `doctoras` · LA ÚNICA LECTURA DEL SISTEMA QUE CRUZA INQUILINOS, y cruza solo las fichas
   * de quien pregunta: la política `patient_link_patient_select` es
   * `account_id = medskin_current_account()`, así que no lleva `where` y no puede llevar un
   * `practice_id` del cliente.
   *
   * El nombre de la consulta y el de la doctora son COPIAS guardadas en `patient_link` desde
   * la 0006: `app_patient` no tiene política en `practice` ni en `practitioner`, y dárselas
   * para servir dos nombres abriría todos los inquilinos.
   */
  private async linksOf(c: PoolClient): Promise<readonly LinkedPractice[]> {
    const { rows } = await c.query<{
      practice_id: string;
      practice_name: string;
      practitioner_name: string;
      status: string;
      since: string;
    }>(
      `select practice_id, practice_name, practitioner_name, status,
              (created_at at time zone $1)::date::text as since
         from patient_link
        order by created_at`,
      [this.zone],
    );
    return rows.map((r) => ({
      practiceId: r.practice_id,
      practiceName: r.practice_name,
      practitionerName: r.practitioner_name,
      status: r.status,
      since: r.since,
    }));
  }

  // -------------------------------------------------------------------------------------
  // DELETE /v1/accounts/mine
  // -------------------------------------------------------------------------------------

  async deleteMine(p: {
    owner: AccountOwner;
    retentionUntil: string;
    reason: string | null;
  }): Promise<DeletionResult> {
    return withTenantContext(this.pool, contextFor(p.owner), async (c) => {
      // La cuenta NO es un argumento: sale del contexto, dentro de la función. Y la línea de
      // `access_audit` la escribe ella en la misma transacción, con el plazo que recibió:
      // aquí no se duplica.
      //
      // `plan_renews_on::text` y no la columna cruda: es una `date`, y convertirla a un
      // instante la movería un día en cualquier zona al este de Greenwich. La frase del
      // `409` interpola ese texto.
      const { rows } = await c.query<{
        verdict: string;
        deleted_at: Date | null;
        patient_count: number | null;
        plan_renews_on: string | null;
      }>(
        `select verdict, deleted_at, patient_count, plan_renews_on::text as plan_renews_on
           from medskin_delete_own_account($1::date, $2)`,
        [p.retentionUntil, p.reason],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new ServiceFailure(
          FAILURE_PHRASES.deleteOwnAccount,
          new Error('medskin_delete_own_account no devolvió veredicto'),
        );
      }
      return {
        verdict: row.verdict as DeletionVerdict,
        deletedAt: row.deleted_at,
        patientCount: row.patient_count === null ? null : Number(row.patient_count),
        planRenewsOn: row.plan_renews_on,
      };
    });
  }

  /** La bitácora. Identificadores sí, contenido no (§10.3, regla 1). */
  private async audit(c: PoolClient, owner: AccountOwner): Promise<void> {
    await c.query(
      `insert into access_audit (practice_id, actor_account_id, action, subject_type,
                                 subject_id, data)
       values ($1, $2, 'cuenta.contrasena_cambiada', 'cuenta', $2, '{}'::jsonb)`,
      [owner.practiceId, owner.accountId],
    );
  }
}
