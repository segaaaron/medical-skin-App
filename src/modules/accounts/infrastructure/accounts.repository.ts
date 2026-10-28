// El repositorio de las cuentas. La ÚNICA puerta a la base es `withTenantContext()`, que
// abre la transacción, adopta el rol y fija los dos contextos. Aquí no hay un solo
// `pool.query()`.
//
// Ninguna de estas dos consultas lleva `where account_id = …`: las políticas de
// `credential` y de `session` son `account_id = medskin_current_account()`, y escribirlo
// otra vez en el código daría a entender que la base no lo hace. Lo hace, y
// `isolation.spec.ts` lo prueba. El `account_id` que importa es el del CONTEXTO, que sale
// del token, no de un identificador del cliente (OWASP A01).

import type { Pool, PoolClient } from 'pg';

import { FAILURE_PHRASES, ServiceFailure } from '../../../shared/contract/error-catalog';
import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { AccountOwner, OwnCredentialPort } from '../domain/ports';

function contextFor(owner: AccountOwner): TenantContext {
  // `app_practitioner` exige inquilino porque sus políticas se leen por inquilino;
  // `app_patient` no lo fija nunca porque la paciente no pertenece a ninguno (§12.2.1).
  if (owner.accountRole === 'paciente') {
    return { role: 'app_patient', accountId: owner.accountId };
  }
  return { role: 'app_practitioner', accountId: owner.accountId, practiceId: owner.practiceId };
}

export class AccountsRepository implements OwnCredentialPort {
  constructor(private readonly pool: Pool) {}

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
        `update credential set hash = $1, set_at = now(), updated_at = now()`,
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
          where id <> $1 and revoked_at is null`,
        [p.owner.sessionId],
      );

      await this.audit(c, p.owner);

      return { sessionsRevoked: revoked.rowCount ?? 0 };
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
