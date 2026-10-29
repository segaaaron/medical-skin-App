// El repositorio de los TRES endpoints de consola de `inquilinos.md`.
//
// `app_platform` y `withTenantContext()`, como todo lo demás. El contexto que se fija es
// `medskin.account_id` = el `sub` del token de plataforma, y eso **no crea ninguna fila en
// `account`**: es lo que la política de `idempotency_key` compara
// (`account_id = medskin_current_account()`) y lo que viaja a la bitácora. `practice_id` NO
// se fija: la consola cruza inquilinos a propósito y sus políticas son
// `current_user = 'app_platform'`, no por inquilino.
//
// LO QUE ESTE ROL NO PUEDE LEER, Y NO SE ABRE:
//   · `patient` — ni para contar. Por eso `plan.pacientes` sale de
//     `medskin_platform_practice_stats()`, que devuelve TRES NÚMEROS y ni una fila.
//   · `session.practice_id` — la 0003 le concedió cinco columnas y ninguna más, así que la
//     consola solo puede agrupar sesiones por cuenta. Las versiones de la consulta salen de
//     la misma función.
//   · `credential` — no tiene política: soporte no toca contraseñas, lo promete la pantalla.
//
// Y las columnas se nombran UNA POR UNA: un privilegio de columna se comprueba ANTES que la
// política, así que `select *` sobre `session` con este rol es «permiso denegado».

import type { Pool, PoolClient } from 'pg';

// Los dos errores que este archivo lanzaba por la idempotencia —`clave_idempotencia_reutilizada`
// y el 500 de la reserva sin cerrar— ya no se nombran aquí: los lanza `claim()`, que es el
// único sitio donde vive ese criterio.
import { FAILURE_PHRASES } from '../../../shared/contract/error-catalog';
import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import { claim, complete } from '../../../shared/idempotency/idempotency-rows';
import type {
  Admission,
  AdmissionVerdict,
  CreatedTenant,
  DecidedLicense,
  Decision,
  DecisionResult,
  IdempotencyRecord,
  LicenseDecisionPort,
  NewOwner,
  NewPractice,
  PlatformActor,
  Served,
  TenantAdmissionPort,
  TenantFile,
  TenantFilePort,
} from '../domain/platform-ports';

type StatsRow = {
  patient_count: string;
  app_version_ios: string | null;
  app_version_android: string | null;
};

type FileRow = {
  id: string;
  name: string;
  plan: string;
  patient_limit: number;
  region: string;
  created_on: string;
  owner_account_id: string | null;
  license_status: string | null;
  decided_at: Date | null;
};

type OwnerRow = {
  email: string;
  status: string;
  locked_until: Date | null;
  live_sessions: string;
};

/**
 * El veredicto que no es `created` viaja en un error para que `withTenantContext()` haga
 * `ROLLBACK`: sin eso, el `INSERT` de `practice` quedaría como una consulta sin dueña, que
 * «no existe» según el contrato y que la consola vería como una consulta real.
 */
class AdmissionRejected extends Error {
  constructor(readonly verdict: Exclude<AdmissionVerdict, 'created'>) {
    super(`el alta no pasó: ${verdict}`);
    this.name = 'AdmissionRejected';
  }
}

/** Lo mismo para la decisión: los tres casos que la base distingue deshacen la transacción. */
class DecisionRejected extends Error {
  constructor(readonly outcome: 'no_license' | 'not_submitted' | 'already_decided') {
    super(`la decisión no pasó: ${outcome}`);
    this.name = 'DecisionRejected';
  }
}

export class PlatformRepository
  implements TenantAdmissionPort, TenantFilePort, LicenseDecisionPort
{
  constructor(
    private readonly pool: Pool,
    /** La zona del despliegue: `alta_en` es una fecha de calendario, no un instante. */
    private readonly timeZone: string,
  ) {}

  // -------------------------------------------------------------------------------------
  // POST /v1/platform/tenants
  // -------------------------------------------------------------------------------------

  async create<T>(p: {
    actor: PlatformActor;
    idempotency: IdempotencyRecord;
    practice: NewPractice;
    owner: NewOwner;
    respond: (created: CreatedTenant) => T;
  }): Promise<Admission<T>> {
    try {
      const served = await withTenantContext(this.pool, contextOf(p.actor), async (c) => {
        // LO PRIMERO DE LA TRANSACCIÓN Y ANTES DE ESCRIBIR NADA. Antes se leía aquí y se
        // guardaba al final, con `INSERT INTO practice` y la función de la dueña en medio:
        // dos altas simultáneas con la misma clave pasaban las dos la lectura vacía, creaban
        // las dos su consulta, y la perdedora recibía `email_taken` —un `409` por una
        // petición que salió bien, y sin la contraseña de la dueña, que solo existía en la
        // respuesta de la ganadora—. Lo que serializa es la clave primaria `(account_id,
        // key)`, así que `claim()` va delante, como en los otros tres caminos.
        const replay = await claim<T>(c, claimOf(p.actor, p.idempotency, FAILURE_PHRASES.createTenant));
        // La respuesta original de la misma petición, contraseña temporal incluida: «"una
        // sola vez" significa que ninguna LECTURA posterior la trae, no que el reintento de
        // la misma petición se quede sin ella» (_convenciones.md).
        if (replay !== null) return { replayed: true, ...replay };

        const { rows: created } = await c.query<{ id: string; created_at: Date }>(
          `insert into practice (name, region, country, time_zone, currency, plan,
                                 patient_limit, internal_note)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning id, created_at`,
          [
            p.practice.name,
            p.practice.region,
            p.practice.country,
            p.practice.timeZone,
            p.practice.currency,
            p.practice.plan,
            p.practice.patientLimit,
            p.practice.internalNote,
          ],
        );
        const practice = created[0];
        if (practice === undefined) throw new Error('el INSERT de practice no devolvió fila');

        // La cuenta de la dueña, su credencial temporal, su fila de `practitioner`, el
        // vínculo `practice.owner_account_id` y LA FILA DE `license` en `sin_enviar`: las
        // cinco piezas del mismo acto, dentro de la función (0015). El correo va `citext`:
        // con `text` la comparación se vuelve sensible a mayúsculas en silencio.
        const { rows: admitted } = await c.query<{ verdict: string; account_id: string | null }>(
          `select verdict, account_id
             from medskin_create_practice_owner($1, $2::citext, $3, $4, $5, $6)`,
          [
            practice.id,
            p.owner.email,
            p.owner.firstName,
            p.owner.lastName,
            p.owner.hash,
            p.owner.expiresAt,
          ],
        );
        const row = admitted[0];
        if (row === undefined)
          throw new Error('medskin_create_practice_owner no devolvió veredicto');
        if (row.verdict !== 'created' || row.account_id === null) {
          throw new AdmissionRejected(row.verdict as Exclude<AdmissionVerdict, 'created'>);
        }

        const response = p.respond({
          practiceId: practice.id,
          accountId: row.account_id,
          createdAt: practice.created_at,
        });
        const outcome: Served<T> = { replayed: false, status: 201, response };
        // La respuesta ya es definitiva aquí dentro: lo único que pasa después del `COMMIT`
        // es el correo de la dueña, que NO cambia este 201 ni lo hace fallar. Así que se
        // cierra en la misma transacción y este camino no deja reservas sin cerrar.
        //
        // Y no hay `release()` que llamar: todos los veredictos que no crean —`email_taken`,
        // los dos de la función— LANZAN, así que la transacción se deshace entera y con ella
        // la reserva. Si algún día uno devuelve en vez de lanzar, hay que soltarla.
        await complete(c, {
          record: p.idempotency,
          accountId: p.actor.subject,
          status: outcome.status,
          response: outcome.response,
        });
        return outcome;
      });

      return { verdict: 'created', served };
    } catch (failure) {
      // La transacción ya está deshecha: no hay consulta, no hay cuenta y no hay fila de
      // idempotencia, así que el reintento del contrato puede volver a intentarlo de verdad.
      if (failure instanceof AdmissionRejected) return { verdict: failure.verdict, served: null };
      throw failure;
    }
  }

  // -------------------------------------------------------------------------------------
  // GET /v1/platform/tenants/{id}
  // -------------------------------------------------------------------------------------

  async read(p: { actor: PlatformActor; practiceId: string }): Promise<TenantFile | null> {
    return withTenantContext(this.pool, contextOf(p.actor), async (c) => {
      const { rows } = await c.query<FileRow>(
        // `created_at` en la zona del despliegue y como `date`: «alta_en: 2026-03-14» es una
        // fecha de calendario, y pasarla por un instante la mueve un día.
        `select p.id, p.name, p.plan, p.patient_limit, p.region,
                (p.created_at at time zone $2)::date::text as created_on,
                p.owner_account_id,
                l.status as license_status, l.decided_at
           from practice p
           left join license l on l.practice_id = p.id
          where p.id = $1`,
        [p.practiceId, this.timeZone],
      );
      const row = rows[0];
      if (row === undefined) return null;

      // Los tres números de la consola. La función existe porque este rol no alcanza
      // `patient` ni `session.practice_id`, y de ella no sale un nombre, un correo ni una
      // fecha de nacimiento: no hay `WHERE` que pasarle más que el inquilino.
      const { rows: stats } = await c.query<StatsRow>(
        'select * from medskin_platform_practice_stats($1)',
        [p.practiceId],
      );
      const numbers = stats[0];

      return {
        id: row.id,
        name: row.name,
        plan: row.plan,
        patientLimit: row.patient_limit,
        activePatients: Number(numbers?.patient_count ?? 0),
        region: row.region,
        createdOn: row.created_on,
        license: {
          // Sin fila de licencia la ficha dice `sin_enviar`: desde la 0015 nace con la
          // consulta, y para las de antes el relleno de esa migración la puso.
          status: row.license_status ?? 'sin_enviar',
          decidedAt: row.decided_at,
        },
        appVersions: {
          ios: numbers?.app_version_ios ?? null,
          android: numbers?.app_version_android ?? null,
        },
        owner: row.owner_account_id === null ? null : await this.readOwner(c, row.owner_account_id),
      };
    });
  }

  /**
   * La dueña, en TRES columnas: «la consola ve correo, rol, estado y pausa», literal. Ni
   * nombre, ni apellido, ni celular, ni región —no los necesita para reenviar un acceso ni
   * para levantar una pausa, y lo que no se puede leer no se filtra—.
   *
   * Las sesiones vivas se cuentan por `account_id`, que es la primera columna de
   * `session_account_active_idx (account_id, last_seen_at DESC) WHERE revoked_at IS NULL`.
   * `practice_id` no se puede nombrar aquí: este rol no tiene esa columna.
   */
  private async readOwner(c: PoolClient, accountId: string): Promise<TenantFile['owner']> {
    const { rows } = await c.query<OwnerRow>(
      `select a.email::text as email, a.status, a.locked_until,
              (select count(*) from session s
                where s.account_id = a.id and s.revoked_at is null) as live_sessions
         from account a
        where a.id = $1`,
      [accountId],
    );
    const row = rows[0];
    if (row === undefined) return null;

    return {
      accountId,
      email: row.email,
      status: row.status,
      lockedUntil: row.locked_until,
      liveSessions: Number(row.live_sessions),
    };
  }

  // -------------------------------------------------------------------------------------
  // POST /v1/platform/tenants/{id}/license/decision
  // -------------------------------------------------------------------------------------

  async decide<T>(p: {
    actor: PlatformActor;
    practiceId: string;
    decision: Decision;
    idempotency: IdempotencyRecord;
    respond: (decided: DecidedLicense) => T;
  }): Promise<DecisionResult<T>> {
    try {
      const served = await withTenantContext(this.pool, contextOf(p.actor), async (c) => {
        // «La misma decisión dos veces no manda dos avisos»: con su clave, el reintento
        // devuelve el 200 de la primera en vez del `409` de «ya se decidió». Y eso valía
        // para el reintento pero NO para dos decisiones simultáneas: el `FOR UPDATE` de
        // abajo serializa la licencia, no la clave, así que la perdedora recibía
        // `already_decided`. Lo que serializa la clave es su clave primaria, y se reclama
        // aquí, antes de mirar la licencia.
        const replay = await claim<T>(c, claimOf(p.actor, p.idempotency, FAILURE_PHRASES.decideLicense));
        if (replay !== null) return { replayed: true, ...replay };

        // `FOR UPDATE` para que dos personas de soporte decidiendo a la vez no se pisen: la
        // segunda espera y encuentra el estado ya movido.
        const { rows: current } = await c.query<{ status: string; patient_limit: number }>(
          `select l.status, p.patient_limit
             from license l
             join practice p on p.id = l.practice_id
            where l.practice_id = $1
              for update of l`,
          [p.practiceId],
        );
        const license = current[0];
        // Sin fila: o la consulta no existe, o no tiene licencia. Los dos son el mismo 404 y
        // no se distinguen, que además es lo que el contrato escribe.
        if (license === undefined) throw new DecisionRejected('no_license');
        if (license.status === 'sin_enviar') throw new DecisionRejected('not_submitted');
        if (license.status !== 'en_revision') throw new DecisionRejected('already_decided');

        const { rows: decided } = await c.query<{ status: string; decided_at: Date }>(
          // El `AND status = 'en_revision'` ES la validación de la transición, y se queda
          // aunque el `SELECT ... FOR UPDATE` ya lo haya visto: es lo que hace que cero filas
          // signifique «ya se decidió» sin depender del orden de dos sentencias.
          `update license
              set status = $2, decided_at = now(), rejection_reason = $3,
                  reviewed_by = $4, updated_at = now()
            where practice_id = $1 and status = 'en_revision'
            returning status, decided_at`,
          [p.practiceId, p.decision.status, p.decision.rejectionReason, p.actor.subject],
        );
        const row = decided[0];
        if (row === undefined) throw new DecisionRejected('already_decided');

        // «La decisión va a `access_audit` con quién la tomó.» `actor_account_id` es el `sub`
        // del token y `actor_label` su nombre legible: la tabla no tiene clave foránea hacia
        // esa persona —no vive en esta región— y es deliberado. En `data` va la decisión y
        // NUNCA el motivo del rechazo: `access_audit` lo lee soporte entero y el motivo ya
        // vive en su columna, bajo la política de la licencia.
        await c.query(
          `insert into access_audit (practice_id, actor_account_id, actor_label, action,
                                     subject_type, data, region)
           values ($1, $2, $3, 'license.decision', 'license',
                   jsonb_build_object('decision', $4::text), $5)`,
          [p.practiceId, p.actor.subject, p.actor.label, p.decision.status, p.actor.region],
        );

        // Y SE LE AVISA, en la misma transacción que la decisión. Hasta hoy la doctora pasaba
        // de «en revisión» a «activa» —o a «rechazada»— sin que nadie se lo dijera: en una
        // aprobación es una espera de más, y en un rechazo hay algo que corregir y nadie lo
        // contó. Los dos canales, porque esto es seguridad de la cuenta y no se apaga.
        //
        // El aviso NO lleva el motivo del rechazo: eso vive en su columna, bajo la política de
        // la licencia, y la doctora lo lee al abrir la app. Un motivo en una pantalla de
        // bloqueo es la misma clase de fuga que un dato clínico.
        const subject = row.status === 'verificada' ? 'licencia_aprobada' : 'licencia_rechazada';
        for (const channel of ['push', 'correo'] as const) {
          await c.query(
            `select medskin_notify_owner($1, 'seguridad', $2, $3,
                                         jsonb_build_object('estado', $4::text),
                                         $5)`,
            [
              p.practiceId,
              channel,
              subject,
              row.status,
              `licencia:${p.practiceId}:${row.status}:${channel}`,
            ],
          );
        }

        const { rows: stats } = await c.query<StatsRow>(
          'select patient_count from medskin_platform_practice_stats($1)',
          [p.practiceId],
        );

        const response = p.respond({
          status: row.status,
          decidedAt: row.decided_at,
          activePatients: Number(stats[0]?.patient_count ?? 0),
          patientLimit: license.patient_limit,
        });
        const outcome: Served<T> = { replayed: false, status: 200, response };
        // Dentro de la transacción: aquí no hay nada después del `COMMIT`. Y tampoco hay
        // `release()`: los tres veredictos que no deciden lanzan y lo deshacen todo.
        await complete(c, {
          record: p.idempotency,
          accountId: p.actor.subject,
          status: outcome.status,
          response: outcome.response,
        });
        return outcome;
      });

      return { outcome: 'decided', served };
    } catch (failure) {
      // Deshecha: «La licencia sigue en revisión: puedes volver a intentarlo» es verdad.
      if (failure instanceof DecisionRejected) return { outcome: failure.outcome, served: null };
      throw failure;
    }
  }
}

/**
 * `app_platform` con `medskin.account_id` = el `sub` del token, y **sin** `practice_id`: la
 * consola lee cruzando inquilinos a propósito y sus políticas no son por inquilino.
 */
function contextOf(actor: PlatformActor): TenantContext {
  return { role: 'app_platform', accountId: actor.subject };
}

/**
 * El contexto de la clave de idempotencia de la consola. `account_id` es el `sub` del token
 * —que es lo que su política compara— y `practice_id` va NULO: una acción de consola no es de
 * ninguna consulta, y la política de plataforma no lo mira.
 *
 * El mecanismo es el de `shared/idempotency`, el mismo que los otros tres caminos: `claim()`
 * delante, `complete()` cuando la respuesta es verdad. Aquí había una segunda
 * implementación —`replayOf` y `remember`— y arrastraba los tres defectos que el mecanismo
 * compartido ya había cerrado: la reserva al final, el `ON CONFLICT DO NOTHING` sin mirar
 * `rowCount`, y la lectura sin `expires_at > now()`, que servía una contraseña temporal de
 * hace diez días y dejaba la clave atascada para siempre.
 */
function claimOf(
  actor: PlatformActor,
  record: IdempotencyRecord,
  unfinished: string,
): { record: IdempotencyRecord; accountId: string; practiceId: null; unfinished: string } {
  return { record, accountId: actor.subject, practiceId: null, unfinished };
}

/**
 * UNA SOLA HUELLA DEL CUERPO EN TODO EL SERVICIO, la de `shared/idempotency`: aquí había una
 * segunda implementación que NO ordenaba las claves, así que el mismo cuerpo serializado en
 * otro orden era «otra petición» en la consola y la misma en la app. Se re-exporta en vez de
 * cambiar los imports de quien ya la usaba.
 */
export { fingerprintOf } from '../../../shared/idempotency/idempotency-key';
