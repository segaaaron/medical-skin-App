// Las dos acciones de consola de `cuentas.md`, contra la base. Única puerta:
// `withTenantContext()`.
//
// EL CONTEXTO ES `app_platform` CON `medskin.account_id` = EL `sub` DEL TOKEN, y fijarlo **no
// crea ninguna fila en `account`**: la persona de plataforma no vive en esta región. Ese uuid
// es lo que la política de `idempotency_key` compara y lo que viaja a la bitácora.
// `practice_id` NO se fija: la consola cruza consultas a propósito y sus políticas son
// `current_user = 'app_platform'`, no por consulta.
//
// LO QUE ESTE ROL NO ALCANZA, Y NO SE ABRE PARA ESTAS DOS RUTAS:
//   · `credential` — ni política ni grant. «No cambia su contraseña» es un permiso que no
//     existe, no una comprobación del código. El reenvío la reemplaza a través de una función
//     `SECURITY DEFINER` que NO devuelve la contraseña: la respuesta no la puede llevar
//     aunque alguien quiera.
//   · `patient`, `patient_link`, `medical_history` — nada clínico alcanza a plataforma nunca.
//     De ahí que el correo del reenvío no pueda nombrar a ninguna doctora.
//   · de `account`, las columnas de «correo, rol, estado y pausa», más el celular desde la
//     0075 —soporte llama a la dueña, y ese teléfono se recoge en el alta justo para eso—. Ni
//     nombre ni apellido. Lo que no se puede leer no se filtra.

import type { Pool, PoolClient } from 'pg';

import { FAILURE_PHRASES, ServiceFailure } from '../../../shared/contract/error-catalog';
import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type {
  ConsoleAccountRow,
  ConsoleAccountSearchPort,
  ConsoleActor,
  PlatformAccessPort,
  PlatformResendOutcome,
} from '../domain/ports';

function contextOf(actor: ConsoleActor): TenantContext {
  return { role: 'app_platform', accountId: actor.subject };
}

export class ConsoleRepository implements PlatformAccessPort, ConsoleAccountSearchPort {
  constructor(private readonly pool: Pool) {}

  /**
   * `GET /v1/platform/accounts?correo=` · la búsqueda por correo EXACTO.
   *
   * `$1::citext` y no `lower(a.email) = lower($1)`: la columna ES `citext`, así que la
   * comparación ya ignora mayúsculas y **entra por `account_email_uq`**. Bajarla a `lower()`
   * desactivaría ese índice y convertiría la búsqueda en un recorrido de la tabla entera.
   *
   * Las columnas van UNA POR UNA, como en todo lo que corre con este rol: un privilegio de
   * columna se comprueba antes que la política, así que un `select *` aquí es «permiso
   * denegado» — y eso es lo que mantiene honesta la lista de lo que soporte puede ver.
   */
  async findByEmail(p: {
    actor: ConsoleActor;
    email: string;
  }): Promise<readonly ConsoleAccountRow[]> {
    return withTenantContext(this.pool, contextOf(p.actor), async (c) => {
      const { rows } = await c.query<{
        id: string;
        email: string;
        role: string;
        status: string;
        locked_until: Date | null;
      }>(
        `select a.id, a.email::text as email, a.role, a.status, a.locked_until
           from account a
          where a.email = $1::citext
          limit 1`,
        [p.email],
      );
      return rows.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        status: row.status,
        lockedUntil: row.locked_until,
      }));
    });
  }

  async resend(p: {
    actor: ConsoleActor;
    accountId: string;
    hash: string;
    expiresAt: Date;
  }): Promise<{ outcome: PlatformResendOutcome; expiresAt: Date | null; email: string | null }> {
    return withTenantContext(this.pool, contextOf(p.actor), async (c) => {
      const { rows } = await c.query<{ outcome: string; expires_at: Date | null }>(
        'select outcome, expires_at from medskin_platform_resend_access($1, $2, $3)',
        [p.accountId, p.hash, p.expiresAt],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new ServiceFailure(
          FAILURE_PHRASES.resendPlatformAccess,
          new Error('medskin_platform_resend_access no devolvió veredicto'),
        );
      }
      const outcome = row.outcome as PlatformResendOutcome;
      if (outcome !== 'acceso_renovado') {
        // Ni el correo ni la fecha salen por un 404 ni por un 409.
        return { outcome, expiresAt: null, email: null };
      }

      // A dónde escribir. Se lee DENTRO de la misma transacción y DESPUÉS del veredicto: la
      // función es la que decide si esa cuenta existe, y leer el correo antes sería una
      // segunda respuesta a la misma pregunta que podría no coincidir con la primera.
      const { rows: destino } = await c.query<{ email: string }>(
        'select email::text as email from account where id = $1',
        [p.accountId],
      );
      const email = destino[0]?.email;
      if (email === undefined) {
        throw new ServiceFailure(
          FAILURE_PHRASES.resendPlatformAccess,
          new Error(`la cuenta ${p.accountId} se renovó y no tiene correo que leer`),
        );
      }

      // «Las dos quedan en `access_audit` con quién las ejecutó.» La escribe el endpoint, que
      // es quien sabe qué operador fue; la función no recibe al actor y así no puede
      // confundirlo con el sujeto.
      await this.audit(c, p.actor, p.accountId, 'cuenta.acceso_pedido', {
        via: 'correo',
        origen: 'consola',
      });

      return { outcome, expiresAt: row.expires_at, email };
    });
  }

  async liftPause(actor: ConsoleActor, accountId: string): Promise<boolean> {
    return withTenantContext(this.pool, contextOf(actor), async (c) => {
      // Las tres columnas del `GRANT UPDATE` de este rol y ni una más. `status <> 'borrada'`
      // porque levantarle la pausa a una cuenta borrada sería devolverle un acceso que el
      // borrado le quitó: cero filas, y el 404 lo dice.
      const lifted = await c.query(
        `update account
            set locked_until = null, failed_attempts = 0, updated_at = now()
          where id = $1 and status <> 'borrada'`,
        [accountId],
      );
      if (lifted.rowCount !== 1) return false;

      await this.audit(c, actor, accountId, 'cuenta.pausa_levantada', {});
      return true;
    });
  }

  /**
   * La línea de la bitácora. `actor_account_id` es el `sub` del token y `actor_label` su
   * nombre legible: la tabla no tiene clave foránea hacia esa persona —no vive en esta
   * región— y es deliberado.
   *
   * `practice_id` va NULO: esta acción no es de ninguna consulta, y `app_platform` no fija
   * consulta. En `data` van etiquetas cerradas: NI EL CORREO, NI LA CONTRASEÑA, ni un dato
   * clínico (§10.3, regla 1). El correo además no podría entrar sin convertir la bitácora
   * —que soporte lee entera— en un padrón consultable.
   */
  private async audit(
    c: PoolClient,
    actor: ConsoleActor,
    subjectAccountId: string,
    action: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await c.query(
      `insert into access_audit (practice_id, actor_account_id, actor_label, action,
                                 subject_type, subject_id, data, region)
       values (null, $1, $2, $3, 'cuenta', $4, $5, $6)`,
      [actor.subject, actor.label, action, subjectAccountId, JSON.stringify(data), actor.region],
    );
  }
}
