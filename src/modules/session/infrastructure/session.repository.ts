// El repositorio de la sesión: `GET /v1/session` y `POST /v1/session/refresh`. La ÚNICA puerta a la base es `withTenantContext()`:
// abre la transacción, adopta el rol y fija los dos contextos con `SET LOCAL`. Aquí no hay
// un solo `pool.query()` y no hay un solo `SET` de sesión — detrás del pooler en modo
// transacción se lo lleva el siguiente cliente, y eso es una fuga entre doctoras.
//
// Consultas parametrizadas sin excepción (OWASP A03), y ni un `where` escrito a mano con
// un valor del cliente salvo el `sid`, que va como parámetro y BAJO la política de
// `session`: un `sid` de otra cuenta no devuelve fila.

import type { Pool, PoolClient } from 'pg';

import { FAILURE_PHRASES, ServiceFailure } from '../../../shared/contract/error-catalog';
import type { AccountRole, PractitionerRole, Scope } from '../../../shared/contract/session';
import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type {
  RefreshPort,
  RefreshVerdict,
  RotatedRefresh,
  SessionOwner,
  SessionSnapshot,
  SessionSnapshotPort,
} from '../domain/ports';

type SessionRow = {
  revoked_at: Date | null;
  refresh_expires_at: Date | null;
  account_status: string;
};

/** Las catorce columnas de `medskin_session_refresh()` (migración 0018), en su orden. */
type RefreshRow = {
  verdict: string;
  session_id: string | null;
  account_id: string | null;
  practice_id: string | null;
  scope: string | null;
  role: string | null;
  practitioner_role: string | null;
  permissions: string[] | null;
  account_status: string | null;
  password_is_temporary: boolean | null;
  license_declared: boolean | null;
  first_day_done: boolean | null;
  refresh_expires_at: Date | null;
  graced: boolean | null;
};

type PracticeRow = {
  id: string;
  name: string;
  license_declared: boolean | null;
  first_day_practice_data: boolean;
  first_day_schedule: boolean;
  first_day_first_treatment: boolean;
  first_day_dismissed: boolean;
  permissions: string[] | null;
};

export class SessionRepository implements SessionSnapshotPort, RefreshPort {
  constructor(private readonly pool: Pool) {}

  async read(owner: SessionOwner): Promise<SessionSnapshot | null> {
    // `app_practitioner` exige consulta porque sus políticas se leen por consulta;
    // `app_patient` no lo fija nunca porque la paciente no pertenece a ninguno.
    const ctx: TenantContext =
      owner.accountRole === 'patient'
        ? { role: 'app_patient', accountId: owner.accountId }
        : {
            role: 'app_practitioner',
            accountId: owner.accountId,
            practiceId: owner.practiceId,
          };

    return withTenantContext(this.pool, ctx, async (c) => {
      const { rows } = await c.query<SessionRow>(
        // Las dos políticas trabajan juntas y no hay `where account_id = …`: la de
        // `session` es `account_id = medskin_current_account()` y la de `account` es
        // `id = medskin_current_account()`. Filtrar otra vez en el código daría a
        // entender que la base no lo hace; lo hace, y `isolation.spec.ts` lo prueba.
        `select s.revoked_at, s.refresh_expires_at, a.status as account_status
           from session s
           join account a on a.id = s.account_id
          where s.id = $1`,
        [owner.sessionId],
      );
      const row = rows[0];
      if (row === undefined) return null;

      // La consulta de la consulta va APARTE y no como un `left join`, y no es por
      // estilo: `app_patient` no tiene un solo `GRANT` sobre `practice`, `license` ni
      // `practitioner`, y un privilegio de columna se comprueba antes que cualquier
      // política, así que el `left join` que para una doctora da nulos para una paciente
      // da «permiso denegado». Dos caminos, una consulta cada uno.
      const practice = owner.accountRole === 'patient' ? null : await this.readPractice(c);

      return {
        accountStatus: row.account_status,
        revokedAt: row.revoked_at,
        refreshExpiresAt: row.refresh_expires_at,
        practice: practice === null ? null : { id: practice.id, name: practice.name },
        licenseDeclared: practice?.license_declared ?? false,
        firstDayDone: practice === null ? true : firstDayDone(practice),
        permissions: practice?.permissions ?? null,
      };
    });
  }

  /**
   * La consulta de quien llama, su licencia y SU fila de `practitioner`. Las tres filas
   * son de la consulta del contexto y las políticas las acotan a él, así que no hay
   * `where practice_id = …` con un valor del cliente. La de `practitioner` sí lleva
   * filtro, y no es por consulta: dentro de una consulta hay varias, y la que se quiere
   * es la de QUIEN PREGUNTA, que sale de `medskin_current_account()` (OWASP A01).
   */
  private async readPractice(c: PoolClient): Promise<PracticeRow | null> {
    const { rows } = await c.query<PracticeRow>(
      `select p.id, p.name, l.license_number is not null as license_declared,
              p.first_day_practice_data, p.first_day_schedule,
              p.first_day_first_treatment, p.first_day_dismissed,
              pr.permissions
         from practice p
         left join license l on l.practice_id = p.id
         left join practitioner pr
                on pr.practice_id = p.id
               and pr.account_id = medskin_current_account()
               and pr.status = 'activa'
        limit 1`,
    );
    return rows[0] ?? null;
  }

  // -------------------------------------------------------------------------------------
  // POST /v1/session/refresh
  // -------------------------------------------------------------------------------------

  /**
   * `app_anonymous`: ni consulta ni cuenta, porque cuando llega esta petición no hay
   * sesión que leer y el refresco no dice quién es hasta que la función lo resuelve. Su
   * único privilegio es el `EXECUTE` de estas funciones, así que lo que la función no
   * devuelva no se puede leer por fuera — y por eso devuelve las catorce columnas del 200.
   *
   * LAS DOS VIDAS VAN EN SEGUNDOS Y EN ESTE ORDEN: paciente primero, consulta después
   * (migración 0020). El número vive en el contrato y en `REFRESH_LIFETIME_MS`, no
   * duplicado en la base; lo que vive en la base es la COTA —31 días y 13 h—, y por eso
   * invertir los dos argumentos no deja a una doctora con un refresco de 30 días: revienta
   * con `invalid_parameter_value`. La caducidad buena la calcula la función con el rol en
   * la mano y vuelve en `refresh_expires_at`.
   */
  async rotate(p: {
    digest: string;
    newDigest: string;
    patientSeconds: number;
    practitionerSeconds: number;
    withinTransaction: (verdict: RotatedRefresh) => Promise<void>;
  }): Promise<RotatedRefresh> {
    return withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<RefreshRow>(
        'select * from medskin_session_refresh($1, $2, $3, $4)',
        [p.digest, p.newDigest, p.patientSeconds, p.practitionerSeconds],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new ServiceFailure(
          FAILURE_PHRASES.refreshSession,
          new Error('medskin_session_refresh no devolvió veredicto'),
        );
      }

      const verdict = toRotatedRefresh(row);
      // DENTRO de la transacción: lo que lance aquí deshace la rotación con el `ROLLBACK`
      // de `withTenantContext()`, y el refresco que llegó sigue valiendo. Es lo que hace
      // verdad la frase del `429`: «espera y reintenta con retroceso».
      await p.withinTransaction(verdict);
      return verdict;
    });
  }
}

/**
 * La fila de la función, traducida. Los veredictos que no son `rotated` llegan con todo en
 * nulo y se quedan así: lo que no vale no autoriza a saber de quién era.
 */
function toRotatedRefresh(row: RefreshRow): RotatedRefresh {
  return {
    verdict: row.verdict as RefreshVerdict,
    sessionId: row.session_id,
    accountId: row.account_id,
    practiceId: row.practice_id,
    scope: row.scope as Scope | null,
    accountRole: row.role as AccountRole | null,
    practitionerRole: row.practitioner_role as PractitionerRole | null,
    permissions: row.permissions,
    accountStatus: row.account_status,
    passwordIsTemporary: row.password_is_temporary ?? false,
    licenseDeclared: row.license_declared ?? false,
    firstDayDone: row.first_day_done ?? false,
    refreshExpiresAt: row.refresh_expires_at,
    graced: row.graced ?? false,
  };
}

/** La lista de tres tareas de `PrimerDia`, o la que ella cerró. */
function firstDayDone(p: PracticeRow): boolean {
  return (
    p.first_day_dismissed ||
    (p.first_day_practice_data && p.first_day_schedule && p.first_day_first_treatment)
  );
}
