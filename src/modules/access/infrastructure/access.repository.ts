// El repositorio del acceso. La ÚNICA puerta a la base es `withTenantContext()`: abre la
// transacción, adopta el rol y fija los dos contextos. Aquí no hay un solo `pool.query()`.
//
// Las consultas son parametrizadas sin excepción (OWASP A03). Las funciones del acceso se
// llaman con `select * from medskin_…($1)`, que es la forma que fija
// `0002_access_functions_and_console.sql` y la que prueba `access-functions.spec.ts`.

import type { Pool, PoolClient } from 'pg';

import { FAILURE_PHRASES, ServiceFailure } from '../../../shared/contract/error-catalog';
import type {
  AccountRole,
  PractitionerRole,
  Region,
} from '../../../shared/contract/session';
import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type {
  AccessCredential,
  ActiveSession,
  CredentialPort,
  NextStepFacts,
  OpenedSession,
  OwnerOfSessions,
  SavedPassword,
  SavePasswordVerdict,
  SessionOpening,
  SessionPort,
} from '../domain/ports';

type CredentialRow = {
  account_id: string | null;
  role: string | null;
  status: string | null;
  region: string | null;
  hash: string;
  is_temporary: boolean;
  temp_expires_at: Date | null;
  temp_first_used_at: Date | null;
  temp_used_at: Date | null;
  practice_id: string | null;
  practitioner_role: string | null;
  permissions: string[] | null;
};

/**
 * El contexto de la base que le toca a quien llama. No es una elección: `app_practitioner`
 * exige `practiceId` porque sus políticas se leen por consulta, y `app_patient` no lo
 * fija nunca porque la paciente no pertenece a ninguna consulta (§12.2.1).
 */
function contextFor(owner: {
  accountId: string;
  practiceId: string | null;
  accountRole: AccountRole | null;
}): TenantContext {
  // `accountRole` nulo es la entrada por recuperación: su token no lleva rol a propósito,
  // así que adopta `app_account` (migración 0013), el rol de «sé quién eres y no sé qué
  // eres»: políticas por `account_id` sobre `account`, `credential` y `session`, y ni una
  // que sea solo de paciente. Por ahí entra una doctora igual que una paciente, y por eso
  // no es `app_patient`: ese rol lleva además el `UPDATE` de `credential.hash`, el de
  // `medical_history` y el `EXECUTE` de `medskin_delete_own_account`, que la 0014 le niega
  // a una sesión a medio abrir. Verificado en el catálogo el 28 oct: lo que esta
  // transacción hace —`medskin_set_final_password()` y su línea de bitácora— cabe exacto
  // en `app_account`, y no hizo falta migración.
  if (owner.accountRole === null) {
    return { role: 'app_account', accountId: owner.accountId };
  }
  if (owner.accountRole === 'paciente') {
    return { role: 'app_patient', accountId: owner.accountId };
  }
  return {
    role: 'app_practitioner',
    accountId: owner.accountId,
    practiceId: owner.practiceId,
  };
}

export class AccessRepository implements CredentialPort, SessionPort {
  constructor(private readonly pool: Pool) {}

  // -------------------------------------------------------------------------------------
  // Credenciales
  // -------------------------------------------------------------------------------------

  /** `app_anonymous`: ni consulta ni cuenta, porque todavía no se sabe quién llama. */
  async read(email: string): Promise<AccessCredential> {
    return withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<CredentialRow>(
        'select * from medskin_access_credential($1)',
        [email],
      );
      const row = rows[0];
      // La función devuelve SIEMPRE exactamente una fila y SIEMPRE un hash. Si no, el
      // señuelo no está sembrado y el acceso no se puede servir sin abrir el oráculo del
      // reloj: antes un 500 con su causa que un 401 que llega más rápido.
      if (rows.length !== 1 || row === undefined || !row.hash) {
        throw new ServiceFailure(
          FAILURE_PHRASES.signIn,
          new Error(`medskin_access_credential devolvió ${rows.length} filas o sin hash señuelo`),
        );
      }
      return {
        accountId: row.account_id,
        accountRole: row.role as AccountRole | null,
        accountStatus: row.status,
        region: row.region as Region | null,
        hash: row.hash,
        isTemporary: row.is_temporary,
        tempExpiresAt: row.temp_expires_at,
        tempUsedAt: row.temp_used_at,
        practiceId: row.practice_id,
        practitionerRole: row.practitioner_role as PractitionerRole | null,
        permissions: row.permissions,
      };
    });
  }

  async recordAttempt(email: string, matched: boolean): Promise<void> {
    await withTenantContext(this.pool, { role: 'app_anonymous' }, (c) =>
      c.query('select * from medskin_access_attempt($1, $2)', [email, matched]),
    );
  }

  async readMine(accountId: string, practiceId: string | null): Promise<AccessCredential | null> {
    const accountRole: AccountRole = practiceId === null ? 'paciente' : 'practitioner';
    const ctx = contextFor({ accountId, practiceId, accountRole });
    return withTenantContext(this.pool, ctx, async (c) => {
      const { rows } = await c.query<{
        hash: string;
        is_temporary: boolean;
        temp_expires_at: Date | null;
        temp_first_used_at: Date | null;
        temp_used_at: Date | null;
      }>('select * from medskin_current_credential()');
      const row = rows[0];
      if (row === undefined) return null;
      return {
        accountId,
        accountRole,
        accountStatus: null,
        region: null,
        hash: row.hash,
        isTemporary: row.is_temporary,
        tempExpiresAt: row.temp_expires_at,
        tempUsedAt: row.temp_used_at,
        practiceId,
        practitionerRole: null,
        permissions: null,
      };
    });
  }

  async saveFinalPassword(p: {
    accountId: string;
    practiceId: string | null;
    accountRole: AccountRole | null;
    hash: string;
    via: 'temporal' | 'recuperacion';
    currentSessionId: string | null;
    refreshDigest: string | null;
    refreshExpiresAt: Date | null;
  }): Promise<SavedPassword> {
    const ctx = contextFor(p);
    return withTenantContext(this.pool, ctx, async (c) => {
      const { rows } = await c.query<{
        verdict: string;
        role: string | null;
        practice_id: string | null;
        permissions: string[] | null;
      }>('select * from medskin_set_final_password($1, $2, $3)', [
        p.hash,
        p.via,
        p.currentSessionId,
      ]);
      const row = rows[0];
      if (row === undefined) {
        throw new ServiceFailure(
          FAILURE_PHRASES.savePassword,
          new Error('medskin_set_final_password no devolvió veredicto'),
        );
      }
      if (row.verdict !== 'saved') {
        return {
          verdict: row.verdict as SavePasswordVerdict,
          accountRole: null,
          practiceId: null,
          permissions: null,
        };
      }

      const saved: SavedPassword = {
        verdict: 'saved',
        accountRole: row.role as AccountRole | null,
        practiceId: row.practice_id,
        permissions: row.permissions,
      };

      // El ascenso de esta sesión, en la MISMA transacción: de alcance restringido a
      // `completo` y con el refresco que no tenía. `session_scope_without_refresh_ck`
      // obliga a que las dos cosas pasen juntas, y está bien que obligue.
      //
      // Por recuperación no hay sesión que ascender —el token no lleva `sid`—, así que la
      // sesión se abre después con `open()`, que es el mismo acto que una entrada normal.
      if (p.currentSessionId !== null) {
        const promoted = await c.query(
          `update session
              set scope = 'completo',
                  refresh_hash = $1,
                  refresh_expires_at = $2,
                  refresh_rotated_at = now(),
                  previous_refresh_hash = null,
                  last_seen_at = now()
            where id = $3 and account_id = $4 and revoked_at is null`,
          [p.refreshDigest, p.refreshExpiresAt, p.currentSessionId, p.accountId],
        );
        if (promoted.rowCount !== 1) {
          throw new ServiceFailure(
            FAILURE_PHRASES.savePassword,
            new Error(`la sesión ${p.currentSessionId} no se pudo ascender a alcance completo`),
          );
        }
      }

      await this.audit(c, {
        practiceId: p.practiceId ?? saved.practiceId,
        accountId: p.accountId,
        action: 'acceso.contrasena_elegida',
        data: { via: p.via },
      });

      return saved;
    });
  }

  // -------------------------------------------------------------------------------------
  // Sesiones
  // -------------------------------------------------------------------------------------

  async open(p: SessionOpening): Promise<OpenedSession> {
    const ctx = contextFor(p);
    return withTenantContext(this.pool, ctx, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into session (account_id, practice_id, scope, refresh_hash, refresh_expires_at,
                              refresh_rotated_at, device_id, device, os, app_version, platform, city)
         values ($1, $2, $3, $4, $5, case when $4::text is null then null else now() end,
                 $6, $7, $8, $9, $10, $11)
         returning id`,
        [
          p.accountId,
          p.practiceId,
          p.scope,
          p.refreshDigest,
          p.refreshExpiresAt,
          p.device.deviceId,
          p.device.model,
          p.device.os,
          p.device.appVersion,
          p.device.platform,
          p.device.city,
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new ServiceFailure(FAILURE_PHRASES.signIn, new Error('la sesión no se pudo abrir'));
      }

      const facts = await this.readNextStepFacts(c, p.accountRole);

      // «Aparece en su bitácora de accesos como cualquier otra apertura» (`sesion.md`).
      // Identificadores y nada más: ni el correo, ni la IP, ni nada clínico.
      await this.audit(c, {
        practiceId: p.practiceId,
        accountId: p.accountId,
        action: 'acceso.entro',
        data: { alcance: p.scope, plataforma: p.device.platform },
        region: p.region,
        actorLabel: p.actorLabel,
      });

      return { sessionId: row.id, ...facts };
    });
  }

  async nextStepFacts(owner: OwnerOfSessions): Promise<NextStepFacts> {
    return withTenantContext(this.pool, contextFor(owner), (c) =>
      this.readNextStepFacts(c, owner.accountRole),
    );
  }

  async list(owner: OwnerOfSessions): Promise<readonly ActiveSession[]> {
    return withTenantContext(this.pool, contextFor(owner), async (c) => {
      // Sin `where account_id = …`: la política de `session` es
      // `account_id = medskin_current_account()` y filtrar otra vez en el código daría a
      // entender que la base no lo hace. Lo hace, y `isolation.spec.ts` lo prueba.
      const { rows } = await c.query<{
        id: string;
        device: string | null;
        os: string | null;
        app_version: string | null;
        city: string | null;
        signed_in_at: Date;
        last_seen_at: Date;
      }>(
        `select id, device, os, app_version, city, signed_in_at, last_seen_at
           from session
          where revoked_at is null
          order by last_seen_at desc`,
      );
      return rows.map((r) => ({
        id: r.id,
        model: r.device,
        os: r.os,
        appVersion: r.app_version,
        city: r.city,
        signedInAt: r.signed_in_at,
        lastSeenAt: r.last_seen_at,
      }));
    });
  }

  async revokeOne(owner: OwnerOfSessions, sessionId: string): Promise<boolean> {
    return withTenantContext(this.pool, contextFor(owner), async (c) => {
      // Un `sesion_id` de otra cuenta no encuentra fila: la política decide, no un `if`.
      const r = await c.query(
        `update session set revoked_at = now(), revoked_reason = 'signed_out'
          where id = $1 and revoked_at is null`,
        [sessionId],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }

  async revokeOthers(owner: OwnerOfSessions, currentSessionId: string): Promise<number> {
    return withTenantContext(this.pool, contextFor(owner), async (c) => {
      const r = await c.query(
        `update session set revoked_at = now(), revoked_reason = 'signed_out_others'
          where id <> $1 and revoked_at is null`,
        [currentSessionId],
      );
      return r.rowCount ?? 0;
    });
  }

  // -------------------------------------------------------------------------------------

  /**
   * El estado que decide `siguiente_paso`. Para una paciente no hay nada que leer: su
   * `vincular` y su `ficha_medica` salen de `patient_link`, que es del tramo 2.
   */
  private async readNextStepFacts(
    c: PoolClient,
    accountRole: AccountRole,
  ): Promise<NextStepFacts> {
    const sinConsulta: NextStepFacts = {
      licenseStatus: null,
      firstDayDone: true,
      practitionerRole: null,
      permissions: null,
    };
    if (accountRole === 'paciente') return sinConsulta;

    // Las tres filas son de la consulta del contexto y las políticas las acotan a él: por
    // eso no hay `where practice_id = …` escrito a mano con un valor del cliente. La de
    // `practitioner` sí lleva filtro, y no es por consulta: dentro de una consulta hay
    // varias, y la que se quiere es la de QUIEN PREGUNTA, que sale de
    // `medskin_current_account()` y nunca del cuerpo ni de la URL (OWASP A01).
    const { rows } = await c.query<{
      status: string | null;
      first_day_practice_data: boolean;
      first_day_schedule: boolean;
      first_day_first_treatment: boolean;
      first_day_dismissed: boolean;
      practitioner_role: string | null;
      permissions: string[] | null;
    }>(
      `select l.status,
              p.first_day_practice_data, p.first_day_schedule,
              p.first_day_first_treatment, p.first_day_dismissed,
              pr.role as practitioner_role, pr.permissions
         from practice p
         left join license l on l.practice_id = p.id
         left join practitioner pr
                on pr.practice_id = p.id
               and pr.account_id = medskin_current_account()
               and pr.status = 'activa'
        limit 1`,
    );
    const row = rows[0];
    if (row === undefined) return sinConsulta;
    return {
      licenseStatus: row.status,
      firstDayDone:
        row.first_day_dismissed ||
        (row.first_day_practice_data &&
          row.first_day_schedule &&
          row.first_day_first_treatment),
      practitionerRole: row.practitioner_role as PractitionerRole | null,
      permissions: row.permissions,
    };
  }

  /** La bitácora. Identificadores sí, contenido no (§10.3, regla 1). */
  private async audit(
    c: PoolClient,
    line: {
      practiceId: string | null;
      accountId: string;
      action: string;
      data: Record<string, unknown>;
      region?: Region;
      actorLabel?: string | null;
    },
  ): Promise<void> {
    await c.query(
      `insert into access_audit (practice_id, actor_account_id, actor_label, action,
                                 subject_type, subject_id, data, region)
       values ($1, $2, $3, $4, 'cuenta', $2, $5, $6)`,
      [
        line.practiceId,
        line.accountId,
        line.actorLabel ?? null,
        line.action,
        JSON.stringify(line.data),
        line.region ?? null,
      ],
    );
  }
}
