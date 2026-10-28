// `POST /v1/equipo` contra la base. Única puerta: `withTenantContext()`.
//
// Siempre `app_practitioner` con el inquilino del token: `medskin_create_team_member()` saca
// el `practice_id` del CONTEXTO y comprueba ella misma que quien llama es
// `practice.owner_account_id`. La autorización no es un `if` de este archivo ni del
// controlador: es la misma transacción que escribiría (OWASP A01).
//
// Y la función es lo único que puede hacer este alta: `app_practitioner` no tiene —ni va a
// tener— `INSERT` sobre `account` ni nada sobre `credential`, cuya política es
// `account_id = medskin_current_account()`. Es la misma frontera que impide que una doctora
// resetee la contraseña de su paciente.

import type { Pool, PoolClient } from 'pg';

import { FAILURE_PHRASES, ServiceFailure } from '../../../shared/contract/error-catalog';
import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { AssignableTeamRole } from '../domain/team';
import type {
  AccountOwner,
  TeamAccessPort,
  TeamMemberCreation,
  TeamMemberForDelivery,
  TeamPort,
  TeamResendOutcome,
  TeamVerdict,
} from '../domain/ports';

function contextFor(owner: AccountOwner): TenantContext {
  return { role: 'app_practitioner', accountId: owner.accountId, practiceId: owner.practiceId };
}

export class TeamRepository implements TeamPort, TeamAccessPort {
  constructor(private readonly pool: Pool) {}

  async create(p: {
    owner: AccountOwner;
    email: string;
    firstName: string;
    lastName: string;
    role: AssignableTeamRole;
    hash: string;
    expiresAt: Date;
  }): Promise<TeamMemberCreation> {
    return withTenantContext(this.pool, contextFor(p.owner), async (c) => {
      // `$1::citext` y no `text`: con `text` la comparación contra la columna se resolvería
      // por `text = text` y pasaría a ser sensible a mayúsculas, en silencio (§1.10).
      const { rows } = await c.query<{
        verdict: string;
        account_id: string | null;
        practitioner_id: string | null;
      }>(
        `select verdict, account_id, practitioner_id
           from medskin_create_team_member($1::citext, $2, $3, $4, $5, $6::timestamptz)`,
        [p.email, p.firstName, p.lastName, p.role, p.hash, p.expiresAt],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new ServiceFailure(
          FAILURE_PHRASES.createTeamMember,
          new Error('medskin_create_team_member no devolvió veredicto'),
        );
      }
      const verdict = row.verdict as TeamVerdict;
      if (verdict !== 'created') {
        return { verdict, accountId: null, practitionerId: null, practiceName: null };
      }

      // El nombre de la consulta, para el correo del acceso. Sin `where`: la política
      // `practice_practitioner_select` es `id = medskin_current_practice()`. Se lee en ESTA
      // transacción porque es la misma que acaba de crear la fila, y así el correo no puede
      // nombrar una consulta distinta de la que lo dio de alta.
      const { rows: practice } = await c.query<{ name: string }>('select name from practice');

      await this.audit(c, p.owner, row.account_id, p.role);

      return {
        verdict,
        accountId: row.account_id,
        practitionerId: row.practitioner_id,
        practiceName: practice[0]?.name ?? null,
      };
    });
  }

  // -------------------------------------------------------------------------------------
  // POST /v1/equipo/{miembro_id}/acceso
  // -------------------------------------------------------------------------------------

  async forDelivery(
    owner: AccountOwner,
    practitionerId: string,
  ): Promise<TeamMemberForDelivery | null> {
    return withTenantContext(this.pool, contextFor(owner), async (c) => {
      // Sin `where practice_id = …`: las políticas de `practitioner` y de `practice` lo
      // ponen las dos (`practice_id = medskin_current_practice()` y
      // `id = medskin_current_practice()`), así que el `join` no puede cruzar inquilinos.
      //
      // `account_id <> medskin_current_account()` es «eres tú», y está aquí Y en la función:
      // aquí para que ese 404 llegue antes de gastar contador, y allí porque es la frontera
      // de verdad. El `status` activo y la cuenta viva los comprueba la función.
      //
      // El CORREO no se lee: `app_practitioner` no tiene política en `account` fuera de su
      // propia fila. Lo devuelve la función, que es `SECURITY DEFINER`.
      const { rows } = await c.query<{
        account_id: string;
        first_name: string;
        practice_name: string;
      }>(
        `select pt.account_id, pt.first_name, p.name as practice_name
           from practitioner pt
           join practice p on p.id = pt.practice_id
          where pt.id = $1
            and pt.status = 'activa'
            and pt.account_id <> medskin_current_account()`,
        [practitionerId],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return {
        accountId: row.account_id,
        firstName: row.first_name,
        practiceName: row.practice_name,
      };
    });
  }

  async resend(p: {
    owner: AccountOwner;
    practitionerId: string;
    accountId: string;
    hash: string;
    expiresAt: Date;
  }): Promise<{ outcome: TeamResendOutcome; email: string | null }> {
    return withTenantContext(this.pool, contextFor(p.owner), async (c) => {
      const { rows } = await c.query<{ outcome: string; email: string | null }>(
        `select outcome, email::text as email
           from medskin_resend_team_access($1, $2, $3::timestamptz)`,
        [p.practitionerId, p.hash, p.expiresAt],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new ServiceFailure(
          FAILURE_PHRASES.resendTeamAccess,
          new Error('medskin_resend_team_access no devolvió veredicto'),
        );
      }

      // La línea la escribe el endpoint y no la función, que es deliberado: quien sabe
      // QUIÉN lo pidió es esta transacción, con el contexto puesto. Va solo cuando se acuñó
      // de verdad, y dice `acceso_pedido` porque el envío pasa después de este COMMIT.
      if (row.outcome === 'acceso_renovado') {
        await this.auditResend(c, p.owner, p.accountId, p.practitionerId);
      }

      return { outcome: row.outcome as TeamResendOutcome, email: row.email };
    });
  }

  /** El acto, sin el correo y sin la contraseña: identificadores y la vía (§10.3, regla 1). */
  private async auditResend(
    c: PoolClient,
    owner: AccountOwner,
    subjectAccountId: string,
    practitionerId: string,
  ): Promise<void> {
    await c.query(
      `insert into access_audit (practice_id, actor_account_id, action, subject_type,
                                 subject_id, data)
       values ($1, $2, 'cuenta.acceso_pedido', 'cuenta', $3, $4)`,
      [
        owner.practiceId,
        owner.accountId,
        subjectAccountId,
        JSON.stringify({ via: 'correo', miembro_id: practitionerId }),
      ],
    );
  }

  /**
   * La bitácora del alta, en la misma transacción. Quién la pidió, a quién y con qué rol:
   * una cuenta nueva con una contraseña entregada es un hecho que alguien puede querer
   * reconstruir (§10.3, regla 1 · OWASP A09). NI el correo NI la contraseña entran en la
   * fila: el `subject_id` ya dice de quién es la cuenta.
   */
  private async audit(
    c: PoolClient,
    owner: AccountOwner,
    subjectAccountId: string | null,
    role: AssignableTeamRole,
  ): Promise<void> {
    await c.query(
      `insert into access_audit (practice_id, actor_account_id, action, subject_type,
                                 subject_id, data)
       values ($1, $2, 'equipo.creado', 'cuenta', $3, $4)`,
      [owner.practiceId, owner.accountId, subjectAccountId, JSON.stringify({ rol: role })],
    );
  }
}
