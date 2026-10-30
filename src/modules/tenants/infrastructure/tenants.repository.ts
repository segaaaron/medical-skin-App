// El repositorio de `consultas.md` · los dos endpoints de la doctora.
//
// La ÚNICA puerta a la base es `withTenantContext()`: abre la transacción, adopta
// `app_practitioner` con `SET LOCAL ROLE` y fija los dos contextos con `set_config(…, true)`.
// Ni un `pool.query()` y ni un `SET` de sesión — detrás del pooler en modo transacción se lo
// lleva el siguiente cliente, y eso es una fuga entre doctoras.
//
// TRES COSAS QUE NO SE ESCRIBEN AQUÍ, Y ES EL DISEÑO:
//   1. `practice` se lee SIN `where id = …`: su política es sobre `id`
//      (`id = medskin_current_practice()`), que además es la clave primaria. Filtrar otra
//      vez daría a entender que la base no lo hace.
//   2. El recuento del plan va `where status = 'activa'` y sin nombrar la consulta: lo pone
//      la política de `patient`, y así entra por `patient_practice_status_idx` —medido por
//      `datos-senior` con el rol de verdad: `Index Only Scan`, `Heap Fetches: 0`, 0,076 ms
//      con 400 fichas propias y 4.000 de la consulta de al lado (§1.12 del napkin: un plan
//      medido sin RLS no es el plan de esta aplicación).
//   3. `license.status` no se escribe: la doctora no tiene ese `GRANT` de columna. La
//      transición la valida `medskin_license_to_review()`, que además deja su auditoría.
//
// Y las columnas se nombran UNA POR UNA, nunca `select *`: un privilegio de columna se
// comprueba ANTES que la política, así que una columna de más —`internal_note`— no falla al
// compilar, muere con «permiso denegado» en la pantalla real.
//
// `plan_renews_on::text` y no la columna cruda, por el mismo motivo que en el borrado de la
// cuenta: es una `date`, y `pg` la convierte en un instante de medianoche local que se mueve
// un día entero al pasarla a ISO. `renueva_en` es una fecha de calendario, no un momento.

import type { Pool, PoolClient } from 'pg';

import { FAILURE_PHRASES } from '../../../shared/contract/error-catalog';
import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import { claim, complete, release } from '../../../shared/idempotency/idempotency-rows';
import type {
  LicenseSubmissionPort,
  RememberedResponse,
  PracticeOwner,
  PracticeSnapshot,
  Submission,
  SubmissionVerdict,
  OwnPracticePort,
} from '../domain/ports';

/** «Más de 5 envíos en 24 h» (`consultas.md` · 429 `demasiados_envios`). */
export const SUBMISSIONS_PER_DAY = 5;

/** La acción con la que `medskin_license_to_review()` firma cada envío en la bitácora. */
const SUBMIT_ACTION = 'license.to_review';

type PracticeRow = {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  logo_url: string | null;
  region: string;
  time_zone: string;
  currency: string;
  plan: string;
  patient_limit: number;
  plan_renews_on: string | null;
  first_day_practice_data: boolean;
  first_day_schedule: boolean;
  first_day_first_treatment: boolean;
  first_day_dismissed: boolean;
  license_status: string;
  submitted_at: Date | null;
  response_estimated_at: Date | null;
  rejection_reason: string | null;
};

/** Las cuatro columnas de `medskin_license_to_review()` (migración 0002), en su orden. */
type SubmissionRow = {
  verdict: string;
  status: string | null;
  submitted_at: Date | null;
  response_estimated_at: Date | null;
};

export class TenantsRepository implements OwnPracticePort, LicenseSubmissionPort {
  constructor(private readonly pool: Pool) {}

  async read(owner: PracticeOwner): Promise<PracticeSnapshot | null> {
    // El consulta va ESCRITO en las dos lecturas aunque las políticas ya lo pongan, por la
    // regla del repositorio: una consulta cuyo alcance depende solo de RLS deja de estar
    // acotada el día que algo corra con BYPASSRLS, y un `limit 1` sin `order by` elegiría
    // entonces una fila cualquiera en silencio. El comentario va FUERA de la plantilla:
    // dentro, las comillas invertidas la cierran y esbuild muere antes de correr (napkin 5.1).
    return withTenantContext(this.pool, contextOf(owner), async (c) => {
      const { rows } = await c.query<PracticeRow>(
        `select p.id, p.name, p.address, p.city, p.phone, p.logo_url,
                p.region, p.time_zone, p.currency,
                p.plan, p.patient_limit, to_char(p.plan_renews_on, 'YYYY-MM-DD') as plan_renews_on,
                p.first_day_practice_data, p.first_day_schedule,
                p.first_day_first_treatment, p.first_day_dismissed,
                l.status as license_status, l.submitted_at, l.response_estimated_at,
                l.rejection_reason
           from practice p
           join license l on l.practice_id = p.id
          where p.id = medskin_current_practice()
          limit 1`,
      );
      const row = rows[0];
      // Sin fila no hay consulta legible para este contexto, o le falta la licencia que la
      // 0015 garantiza. El `join` y no un `left join` a propósito: una consulta sin su
      // licencia no se puede pintar —`licencia.estado` manda la pantalla entera— y servirla
      // con nulos sería inventar un estado. Quien llama lo convierte en 500 con su causa.
      if (row === undefined) return null;

      return { ...snapshot(row), activePatients: await this.countActivePatients(c) };
    });
  }

  /**
   * El recuento del plan, exactamente como lo cuenta la consola por
   * `medskin_platform_practice_stats()`: `status = 'activa'`. **Las fichas archivadas no
   * cuentan contra `limite_pacientes`** (decisión 38) y los dos lectores usan el mismo
   * recuento, porque si se separan la pantalla dice «148 de 300» y la lista muestra otra
   * cosa.
   */
  // Con la consulta escrito, además, la consulta entra por
  // patient_practice_status_idx (practice_id, status, …) sin depender del predicado de la
  // política para acotar.
  private async countActivePatients(c: PoolClient): Promise<number> {
    const { rows } = await c.query<{ patients: string }>(
      `select count(*) as patients from patient
        where practice_id = medskin_current_practice() and status = 'activa'`,
    );
    return Number(rows[0]?.patients ?? 0);
  }

  // -------------------------------------------------------------------------------------
  // POST /v1/tenants/mine/license · una transacción, tres pasos y en este orden.
  // -------------------------------------------------------------------------------------

  async submit(p: {
    owner: PracticeOwner;
    form: {
      practiceCountry: string;
      specialty: string;
      licenseNumber: string;
      credentialKey: string;
    };
    responseEstimatedAt: Date;
    idempotency: IdempotencyRecord;
    respond: (submission: Submission) => RememberedResponse;
  }): Promise<{ submission: Submission; replay: { status: number; response: unknown } | null }> {
    return withTenantContext(this.pool, contextOf(p.owner), async (c) => {
      // 0 · RECLAMAR LA CLAVE, ANTES DE ESCRIBIR NADA. En `idempotency_key` y en ESTA
      // transacción: la fila y lo que describe se escriben juntas o no se escribe ninguna.
      // Antes vivía en Redis y se escribía después del `COMMIT`, así que un parpadeo entre
      // las dos devolvía un 500 cuya frase era falsa —el caso ya estaba abierto— y el
      // reintento recibía `409 licencia_en_revision`. Y va DELANTE porque la clave primaria
      // es lo que serializa dos envíos idénticos a la vez.
      const replay = await claim<unknown>(c, {
        record: p.idempotency,
        accountId: p.owner.accountId,
        practiceId: p.owner.practiceId,
        unfinished: FAILURE_PHRASES.submitLicense,
      });
      if (replay !== null) return { submission: empty('already_in_review'), replay };

      // 1 · EL LÍMITE PRIMERO, y dentro de la transacción: si se pasa, nada se escribió y
      // «espera a que la revisemos» es verdad. Se cuenta sobre `access_audit` y no sobre
      // Redis (decisión 39): el dato ya existe con su índice y un contador aparte para un
      // acto que ocurre cinco veces al año es un segundo estado que puede desacordarse con
      // la bitácora. Sin nombrar la consulta: lo pone la política, y así la consulta entra
      // por `access_audit_practice_idx (practice_id, occurred_at DESC)`.
      const { rows: counted } = await c.query<{ sent: string }>(
        `select count(*) as sent
           from access_audit
          where action = $1 and occurred_at > now() - interval '24 hours'`,
        [SUBMIT_ACTION],
      );
      if (Number(counted[0]?.sent ?? 0) >= SUBMISSIONS_PER_DAY) {
        await release(c, { record: p.idempotency, accountId: p.owner.accountId });
        return { submission: empty('too_many'), replay: null };
      }

      // 2 · Las seis columnas del formulario bajo SU política, que solo deja escribir
      // mientras el estado es `sin_enviar` o `rechazada`: el acotado no está en este `where`
      // y es correcto que no esté. Cero filas aquí NO se interpreta —no falla y no es un
      // error del contrato—: lo que dice qué pasó es el veredicto de la función, que
      // distingue `already_in_review` de `already_verified`.
      await c.query(
        `update license
            set practice_country = $2, specialty = $3, license_number = $4,
                credential_key = $5, declaration_accepted = true, terms_accepted = true,
                updated_at = now()
          where practice_id = $1`,
        [
          p.owner.practiceId,
          p.form.practiceCountry,
          p.form.specialty,
          p.form.licenseNumber,
          p.form.credentialKey,
        ],
      );

      // 3 · La transición. No recibe ni la cuenta ni la consulta —las toma del contexto, así
      // que no hay nada que forjar— y comprueba que quien llama es la dueña.
      const { rows } = await c.query<SubmissionRow>('select * from medskin_license_to_review($1)', [
        p.responseEstimatedAt,
      ]);
      const row = rows[0];
      if (row === undefined) {
        await release(c, { record: p.idempotency, accountId: p.owner.accountId });
        return { submission: empty('invalid_transition'), replay: null };
      }

      const submission: Submission = {
        verdict: row.verdict as SubmissionVerdict,
        status: row.status,
        submittedAt: row.submitted_at,
        responseEstimatedAt: row.response_estimated_at,
      };

      // 4 · La respuesta de la clave, en esta misma transacción: aquí no hay nada después del
      // `COMMIT` que pueda cambiarla. Solo si hay respuesta que repetir —lo decide quien sabe
      // su forma—; si no, la reserva se suelta y el reintento vuelve a intentarlo de verdad,
      // que es lo que un `403`, un `409` o un `429` necesitan.
      const remembered = p.respond(submission);
      if (remembered === null) {
        await release(c, { record: p.idempotency, accountId: p.owner.accountId });
      } else {
        await complete(c, {
          record: p.idempotency,
          accountId: p.owner.accountId,
          status: remembered.status,
          response: remembered.response,
        });
      }

      return { submission, replay: null };
    });
  }
}

/**
 * `app_practitioner` con los dos contextos. Doctora y equipo son el mismo rol de base: un
 * privilegio de Postgres es por rol y no por endpoint (§1.9 del napkin), y lo que sostiene
 * la frontera de «solo la dueña» es que la función no recibe la cuenta.
 */
function contextOf(owner: PracticeOwner): TenantContext {
  return {
    role: 'app_practitioner',
    accountId: owner.accountId,
    practiceId: owner.practiceId,
  };
}

function empty(verdict: SubmissionVerdict): Submission {
  return { verdict, status: null, submittedAt: null, responseEstimatedAt: null };
}

function snapshot(row: PracticeRow): Omit<PracticeSnapshot, 'activePatients'> {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    city: row.city,
    phone: row.phone,
    logoUrl: row.logo_url,
    region: row.region,
    timeZone: row.time_zone,
    currency: row.currency,
    plan: row.plan,
    patientLimit: row.patient_limit,
    planRenewsOn: row.plan_renews_on,
    license: {
      status: row.license_status,
      submittedAt: row.submitted_at,
      responseEstimatedAt: row.response_estimated_at,
      rejectionReason: row.rejection_reason,
    },
    firstDay: {
      practiceData: row.first_day_practice_data,
      schedule: row.first_day_schedule,
      firstTreatment: row.first_day_first_treatment,
      dismissed: row.first_day_dismissed,
    },
  };
}
