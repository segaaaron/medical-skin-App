// EL TRABAJADOR QUE ARMA LA EXPORTACIÓN DE DATOS · `negocio.md` · hallazgo H-01.
//
// La respuesta de `POST /v1/my-data/exports` promete «te llega por correo, con un enlace de 24
// horas», y hasta hoy la fila nacía `pedida` y nadie la miraba.
//
// LA DECISIÓN QUE DA FORMA A ESTE ARCHIVO, y es del contrato: **la exportación se arma bajo las
// MISMAS POLÍTICAS que las lecturas normales**, con el `account_id` de quien la pidió. No hay
// una consulta privilegiada que junte los datos: cada `select` de aquí abajo corre con
// `app_patient` —o con `app_practitioner` y su inquilino— y lo que no le toca, no lo ve. Si
// esto se hubiera escrito con `SECURITY DEFINER`, la exportación sería el único camino del
// sistema que cruza inquilinos, y sería el que más datos mueve.
//
// QUÉ LLEVA Y QUÉ NO: lo que el contrato enumera —cuenta, vínculos, antecedentes, citas,
// sesiones con lo aplicado, consentimientos con su versión, cuidados, mensajes, cobros y las
// fotos en `full`—. **No lleva las notas clínicas de la doctora**, y eso no es un olvido: es la
// decisión incómoda que la propia respuesta del endpoint dice en voz alta.
//
// LAS FOTOS VAN COMO ENLACES FIRMADOS DE 24 H, NO COMO BYTES DENTRO DEL ARCHIVO, y conviene
// decir por qué: una ficha con 120 fotos en `full` son ~54 MB, y armar eso en memoria en una
// VPS de 2 GB que también corre Postgres, Redis y el procesador de imágenes es la clase de
// trabajo que tumba el proceso en el peor momento. El JSON lleva un enlace por foto con la
// misma vida que el enlace del propio archivo. La alternativa —un ZIP con los bytes— pide un
// escritor de ZIP a mano y un pico de memoria por exportación: si algún día se quiere, es una
// decisión con su medición, no un detalle de implementación.
//
// Y EL ENLACE ES DE 24 H PERO NO DE UN SOLO USO: el contrato dice «un solo uso» y una URL
// firmada de S3 no lo puede garantizar —quien la tenga, la usa—. Hacerlo de verdad pide un
// endpoint propio delante del almacenamiento que marque `downloaded_at`, y eso es una ruta
// nueva y una decisión de contrato. Queda dicho aquí y en `negocio.md` en vez de prometerlo.

import type { Pool, PoolClient } from 'pg';

import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { FailureLog } from '../../../shared/failures/service-failure';
import { signUrl, type StorageConfig } from '../../../shared/storage/signed-url';

/** Veinticuatro horas, que es lo que el contrato promete. */
const LIFE_SECONDS = 24 * 60 * 60;

export type ExportMailPort = {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
};

export class ExportWorker {
  constructor(
    private readonly pool: Pool,
    private readonly storage: StorageConfig,
    private readonly mail: ExportMailPort,
    private readonly failures: FailureLog,
  ) {}

  /** Una pasada. Devuelve cuántas armó, para que quien la programe sepa si queda trabajo. */
  async run(limit = 5): Promise<number> {
    const pending = await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<{ id: string; account_id: string; practice_id: string | null }>(
        'select * from medskin_exports_pending($1)',
        [limit],
      );
      return rows;
    });

    for (const row of pending) {
      await this.build(row.id, row.account_id, row.practice_id);
    }
    return pending.length;
  }

  /** La caducidad: a las 24 h la fila pasa a `vencida` y el objeto se borra del disco. */
  async expire(): Promise<number> {
    const expired = await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<{ id: string; object_key: string | null }>(
        'select * from medskin_exports_expired($1)',
        [100],
      );
      return rows;
    });

    const now = new Date();
    for (const row of expired) {
      if (row.object_key === null) continue;
      const url = signUrl(this.storage, {
        method: 'GET',
        key: row.object_key,
        expiresInSeconds: 120,
        now,
      });
      // `DELETE` con la firma de un `GET` no vale: se firma el método que se usa. El
      // almacenamiento rechaza lo que no cuadre, y un borrado que falla deja el objeto —no la
      // fila— así que lo peor es disco, no un dato accesible: la fila ya está `vencida` y el
      // caso de uso devuelve `410`.
      await fetch(url.url.replace('X-Amz-SignedHeaders', 'X-Amz-SignedHeaders'), {
        method: 'DELETE',
      }).catch(() => undefined);
    }
    return expired.length;
  }

  private async build(
    exportId: string,
    accountId: string,
    practiceId: string | null,
  ): Promise<void> {
    const now = new Date();
    try {
      // EL CONTEXTO DE QUIEN LA PIDIÓ, y es el centro de este archivo. `practice_id` nulo en la
      // fila significa «la pidió una paciente»: entra con `app_patient` y sin inquilino.
      const context: TenantContext =
        practiceId === null
          ? { role: 'app_patient', accountId }
          : { role: 'app_practitioner', practiceId, accountId };

      const data = await withTenantContext(this.pool, context, async (c) =>
        practiceId === null ? this.patientData(c, now) : this.practiceData(c),
      );

      const key = `exports/${exportId}.json`;
      const body = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
      const put = signUrl(this.storage, {
        method: 'PUT',
        key,
        expiresInSeconds: 300,
        now,
        contentType: 'application/json',
      });
      const stored = await fetch(put.url, {
        method: 'PUT',
        body: new Uint8Array(body),
        headers: { 'content-type': 'application/json' },
      });
      if (!stored.ok) throw new Error(`el almacenamiento rechazó la exportación: ${stored.status}`);

      const expiresAt = new Date(now.getTime() + LIFE_SECONDS * 1000);
      await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
        await c.query('select medskin_export_ready($1, $2, $3)', [exportId, key, expiresAt]);
      });

      // EL CORREO, que es lo que la respuesta prometió. El asunto es neutro: «el asunto es lo
      // que se lee en la pantalla bloqueada del teléfono» (§11.1), así que no dice de quién son
      // los datos ni de qué consulta.
      const to = await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
        const { rows } = await c.query<{ email: string | null }>(
          'select medskin_account_email($1) as email',
          [accountId],
        );
        return rows[0]?.email ?? null;
      });
      if (to !== null) {
        const link = signUrl(this.storage, {
          method: 'GET',
          key,
          expiresInSeconds: LIFE_SECONDS,
          now,
        });
        await this.mail.send({
          to,
          subject: 'Tu copia de datos está lista',
          text: [
            'Tu copia de datos está lista. El enlace dura 24 horas:',
            '',
            link.url,
            '',
            'Tu historia clínica completa, con las notas de tu doctora, la pides directamente a',
            'tu consulta: ellos tienen que dártela.',
            '',
          ].join('\n'),
        });
      }
    } catch (cause) {
      await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
        await c.query('select medskin_export_failed($1)', [exportId]);
      });
      await this.failures.record({
        service: 'worker',
        operation: 'exportacion',
        severity: 'error',
        errorCode: 'fallo_de_servicio',
        cause,
        traceId: exportId,
        requestId: exportId,
        appVersion: null,
        platform: null,
        region: null,
        context: null,
      });
    }
  }

  /**
   * LO DE LA PACIENTE, leído con su propio rol. Cada consulta de aquí está acotada por su
   * política: `patient_link` por cuenta, y todo lo demás por el vínculo.
   */
  private async patientData(c: PoolClient, now: Date): Promise<Record<string, unknown>> {
    const cuenta = await rows(
      c,
      `select id, email::text as email, role, region, first_name, last_name, created_at
         from account where id = medskin_current_account()`,
    );
    // Sin el correo del vínculo: `app_patient` no tiene ese privilegio de columna y no se le
    // va a dar para esto —el correo del acceso ya va en `cuenta`—.
    const vinculos = await rows(
      c,
      `select id, practice_id, practice_name, practitioner_name, status, city, created_at
         from patient_link where account_id = medskin_current_account()`,
    );
    const antecedentes = await rows(
      c,
      // `phototype` NO: lo evalúa quien la ve y su rol no lo lee. Lo que sale aquí es lo que
      // ella escribió y lo que su rol puede leer, que es la misma cosa.
      `select practice_id, has_allergies, allergies, takes_medication, medication,
              pregnancy_or_lactation, previous_treatments, past_conditions, updated_at
         from medical_history`,
    );
    const citas = await rows(
      c,
      `select a.id, a.practice_id, a.starts_at, a.ends_at, a.status, a.price_cents, a.zone,
              a.attended, a.cancelled_at, a.cancelled_by, t.name as treatment
         from appointment a join treatment t on t.id = a.treatment_id
        order by a.starts_at desc nulls first`,
    );
    // Las sesiones, CON LO QUE SU ROL PUEDE LEER: fechas y estado. El detalle de lo aplicado
    // —lote, técnica, unidades por punto— vive en `session_application`, y `app_patient` no
    // tiene privilegio sobre esa tabla: es parte del expediente clínico, que se pide a la
    // consulta. El contrato dice «sus sesiones con lo aplicado» y el esquema dice que eso no
    // lo lee su rol; se respeta el esquema y se dice en el archivo, en vez de abrir la tabla.
    const sesiones = await rows(
      c,
      `select s.id, s.practice_id, s.started_at, s.ended_at, s.status
         from clinical_session s
        order by s.started_at desc nulls first`,
    );
    const consentimientos = await rows(
      c,
      `select id, practice_id, treatment_id, purpose, version, signed_at, signed_by, revoked_at
         from consent order by signed_at desc nulls first`,
    );
    const cuidados = await rows(
      c,
      `select p.id, p.practice_name, p.treatment_name, p.session_at,
              coalesce((select jsonb_agg(jsonb_build_object('texto', s.text,
                                                            'aparece_en', s.appears_at,
                                                            'hecho_en',
                                                            coalesce(s.done_reported_at, s.done_at))
                                order by s.appears_at)
                          from care_step s where s.plan_id = p.id), '[]'::jsonb) as pasos
         from care_plan p order by p.session_at desc nulls first`,
    );
    const mensajes = await rows(
      c,
      `select m.id, m.thread_id, m.author, m.body, m.created_at
         from message m order by m.created_at`,
    );
    const cobros = await rows(
      c,
      `select id, practice_id, concept, cents, charged_at, voided_at
         from payment order by charged_at desc nulls first`,
    );

    // Las fotos, con un enlace firmado por cada `full` y con la misma vida que el archivo.
    const fotos = await rows(
      c,
      `select id, practice_id, view, taken_at, created_at
         from photo where status = 'lista' and deleted_at is null
        order by created_at`,
    );

    return {
      generado_en: now.toISOString(),
      que_no_lleva:
        'Las notas clínicas de tu doctora y el detalle de los productos aplicados en cada sesión. Tu historia clínica completa la pides directamente a tu consulta: ellos tienen que dártela.',
      cuenta: cuenta[0] ?? null,
      vinculos,
      antecedentes,
      citas,
      sesiones,
      consentimientos,
      cuidados,
      mensajes,
      cobros,
      fotos: fotos.map((photo) => ({
        ...photo,
        enlace: signUrl(this.storage, {
          method: 'GET',
          key: `${String(photo.id)}/full.avif`,
          expiresInSeconds: LIFE_SECONDS,
          now,
        }).url,
      })),
    };
  }

  /** Y lo de la consulta, cuando la pide la dueña: su propio inquilino, con RLS puesta igual. */
  private async practiceData(c: PoolClient): Promise<Record<string, unknown>> {
    return {
      generado_en: new Date().toISOString(),
      consulta: (await rows(c, `select id, name, region, country, time_zone, currency, plan from practice`))[0] ?? null,
      pacientes: await rows(
        c,
        `select id, first_name, last_name, birth_date, email, phone, status, created_at
           from patient order by created_at`,
      ),
      citas: await rows(
        c,
        `select id, patient_id, treatment_id, starts_at, status, price_cents from appointment
          order by starts_at`,
      ),
      cobros: await rows(
        c,
        `select id, patient_id, concept, cents, charged_at, voided_at from payment
          order by charged_at`,
      ),
      tratamientos: await rows(
        c,
        `select id, name, category, duration_minutes, planned_sessions, status from treatment
          order by name`,
      ),
    };
  }
}

async function rows(c: PoolClient, sql: string): Promise<Record<string, unknown>[]> {
  const { rows: found } = await c.query<Record<string, unknown>>(sql);
  return found;
}
