// El repositorio de los endpoints de consola de `consultas.md`: el alta, la ficha y la
// búsqueda.
//
// TENÍA DOS MÁS HASTA HOY: `decide()`, la decisión de la licencia revisada a mano, y
// `listLicenses()`, la bandeja de lo que esperaba. Se fueron el 30 de octubre de 2026 con la
// revisión manual, que el dueño descartó: MedSkin no es una asociación médica ni un inspector
// de salud, así que no verifica licencias y no hay nada que decidir ni bandeja que servir.
//
// `app_platform` y `withTenantContext()`, como todo lo demás. El contexto que se fija es
// `medskin.account_id` = el `sub` del token de plataforma, y eso **no crea ninguna fila en
// `account`**: es lo que la política de `idempotency_key` compara
// (`account_id = medskin_current_account()`) y lo que viaja a la bitácora. `practice_id` NO
// se fija: la consola cruza consultas a propósito y sus políticas son
// `current_user = 'app_platform'`, no por consulta.
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
  IdempotencyRecord,
  NewOwner,
  NewPractice,
  PlatformActor,
  Served,
  TenantAdmissionPort,
  TenantFile,
  TenantFilePort,
  TenantRow,
} from '../domain/platform-ports';
import type { ConsoleSearch } from '../domain/console-search';
import type { ConsoleLicenseDraft } from '../domain/rules';

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
  practice_country: string | null;
  specialty: string | null;
  license_number: string | null;
  license_declared_at: Date | null;
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

export class PlatformRepository implements TenantAdmissionPort, TenantFilePort {
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
    license: ConsoleLicenseDraft | null;
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
        // vínculo `practice.owner_account_id` y LA FILA DE `license` vacía: las
        // cinco piezas del mismo acto, dentro de la función (0015). El correo va `citext`:
        // con `text` la comparación se vuelve sensible a mayúsculas en silencio.
        const { rows: admitted } = await c.query<{ verdict: string; account_id: string | null }>(
          `select verdict, account_id
             from medskin_create_practice_owner($1, $2::citext, $3, $4, $5, $6, $7)`,
          [
            practice.id,
            p.owner.email,
            p.owner.firstName,
            p.owner.lastName,
            p.owner.hash,
            p.owner.expiresAt,
            p.owner.phone,
          ],
        );
        const row = admitted[0];
        if (row === undefined)
          throw new Error('medskin_create_practice_owner no devolvió veredicto');
        if (row.verdict !== 'created' || row.account_id === null) {
          throw new AdmissionRejected(row.verdict as Exclude<AdmissionVerdict, 'created'>);
        }

        // LOS TRES DATOS DE LA LICENCIA QUE RECOGIÓ LA CONSOLA, si los recogió. Van aquí y
        // no dentro de `medskin_create_practice_owner` para no cambiar la firma de una
        // función que ya usan la semilla y las pruebas: la fila existe desde la línea de
        // arriba, así que esto la completa.
        //
        // `declared_at` SÍ se pone, y es lo que esta escritura promete: lo que la consola
        // anotó en el alta es una declaración del doctor —se la dio por teléfono o en el
        // formulario— y tiene su fecha. Sin ella, la ficha diría que no declaró nada mientras
        // enseña su matrícula.
        if (p.license !== null) {
          await c.query(
            `update license
                set practice_country = $2, specialty = $3, license_number = $4,
                    declared_at = now(), updated_at = now()
              where practice_id = $1`,
            [practice.id, p.license.practiceCountry, p.license.specialty, p.license.licenseNumber],
          );
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
                l.practice_country, l.specialty, l.license_number,
                l.declared_at as license_declared_at
           from practice p
           left join license l on l.practice_id = p.id
          where p.id = $1`,
        [p.practiceId, this.timeZone],
      );
      const row = rows[0];
      if (row === undefined) return null;

      // Los tres números de la consola. La función existe porque este rol no alcanza
      // `patient` ni `session.practice_id`, y de ella no sale un nombre, un correo ni una
      // fecha de nacimiento: no hay `WHERE` que pasarle más que la consulta.
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
          practiceCountry: row.practice_country,
          specialty: row.specialty,
          licenseNumber: row.license_number,
          // Nulo mientras nadie haya declarado nada —`updated_at` no serviría: es `NOT NULL
          // DEFAULT now()`— y también si la consulta no tiene fila de licencia, que es por lo
          // que el `left join` se queda.
          declaredAt: row.license_declared_at,
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
  // GET /v1/platform/tenants · buscar
  //
  // `q` busca en el nombre de la consulta Y en el correo de la dueña: quien busca teclea
  // «paz» o «andrea.paz@», y pedirle que sepa cuál de los dos campos mira sería un formulario
  // con dos cajas para una sola pregunta.
  //
  // El cursor compara TUPLAS —`(a, b) < ($1, $2)`— y no dos condiciones con `OR`: la tupla usa
  // el índice, el `OR` no, y la versión con `OR` escrita a mano se equivoca en el empate.
  // -------------------------------------------------------------------------------------
  async searchTenants(p: {
    actor: PlatformActor;
    search: ConsoleSearch;
  }): Promise<readonly TenantRow[]> {
    return withTenantContext(this.pool, contextOf(p.actor), async (c) => {
      const { rows } = await c.query<TenantSearchRow>(
        // Ya no se une a `license`: el `?licencia=` filtraba por los cuatro estados de la
        // revisión y la columna `licencia` del renglón los devolvía. Un `JOIN` que no aporta
        // ninguna columna es una tabla más en el plan por nada.
        `select p.id, p.name, p.region, p.plan, p.created_at,
                (p.created_at at time zone $1)::date::text as created_on,
                a.email
           from practice p
           left join account a on a.id = p.owner_account_id
          where ($2::text is null
                 or p.name ilike '%' || $2 || '%'
                 or a.email ilike '%' || $2 || '%')
            and ($3::timestamptz is null or (p.created_at, p.id) < ($3, $4::uuid))
          order by p.created_at desc, p.id desc
          limit $5`,
        [
          this.timeZone,
          p.search.query,
          p.search.cursor?.at ?? null,
          p.search.cursor?.id ?? null,
          // Una de más: si viene, hay página siguiente. Contar aparte sería una segunda
          // consulta sobre la misma tabla para saber algo que esta ya sabe.
          p.search.perPage + 1,
        ],
      );

      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        region: row.region,
        createdOn: row.created_on,
        plan: row.plan,
        ownerEmail: row.email,
        createdAt: row.created_at,
      }));
    });
  }

}

type TenantSearchRow = {
  id: string;
  name: string;
  region: string;
  plan: string;
  created_at: Date;
  created_on: string;
  email: string | null;
};



/**
 * `app_platform` con `medskin.account_id` = el `sub` del token, y **sin** `practice_id`: la
 * consola lee cruzando consultas a propósito y sus políticas no son por consulta.
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
