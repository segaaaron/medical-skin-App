// El consentimiento informado, con comprensión verificada.
//
// LA RESPUESTA CORRECTA NO SALE DE AQUÍ NUNCA. Vive en `consent_text.answer_key`, que es una
// columna sobre la que `app_patient` **no tiene `GRANT`** (0035): su rol no puede leerla ni con
// una consulta hecha a mano. La corrección la hace el servidor al firmar, y cuando firma la
// paciente la hace con el rol de la CONSULTA —`medskin_access` a través de la función— porque
// ella no puede ver la clave.

import type { Pool } from 'pg';

import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import { claim, complete, release } from '../../../shared/idempotency/idempotency-rows';
import type { ConsentPort, ConsentText } from '../domain/ports';
import { wrongAnswers, type ConsentDraft } from '../domain/session';

type Caller = { accountId: string; practiceId: string | null; isPatient: boolean };

function contextOf(caller: Caller): TenantContext {
  if (caller.isPatient) return { role: 'app_patient', accountId: caller.accountId };
  return { role: 'app_practitioner', practiceId: caller.practiceId, accountId: caller.accountId };
}

export class ConsentsRepository implements ConsentPort {
  constructor(private readonly pool: Pool) {}

  async text(caller: Caller, treatmentId: string): Promise<ConsentText | null> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // `answer_key` NO se nombra en este `select`, y no es solo prudencia: para el rol de la
      // paciente nombrarla sería «permission denied», que es exactamente la garantía que se
      // quiere. La app no sabe la respuesta y no puede saberla.
      const { rows } = await c.query<{
        treatment_id: string;
        version: string;
        body: string;
        questions: { id: string; texto: string; opciones: string[] }[];
      }>(
        // Por `version` y no por `created_at`: esa columna no está en el `GRANT` de
        // `app_patient` y un `ORDER BY` sobre lo que no se puede leer es «permission denied»
        // igual que un `select`. La versión ES la fecha del texto, así que ordena igual.
        `select treatment_id, version, body, questions from consent_text
          where treatment_id = $1 and published order by version desc limit 1`,
        [treatmentId],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return {
        treatmentId: row.treatment_id,
        version: row.version,
        body: row.body,
        questions: row.questions,
      };
    });
  }

  async sign(
    caller: Caller,
    draft: ConsentDraft,
    idempotency: IdempotencyRecord,
  ): Promise<{
    outcome: 'signed' | 'wrong_answers' | 'stale_version' | 'already' | 'no_text';
    id: string | null;
    wrong: readonly string[];
    replay: unknown;
  }> {
    // La clave se corrige con una función `SECURITY DEFINER` porque quien firma puede ser la
    // paciente, y su rol no lee `answer_key`. La función devuelve SOLO qué preguntas falló.
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const replay = await claim<unknown>(c, {
        record: idempotency,
        accountId: caller.accountId,
        practiceId: caller.isPatient ? null : caller.practiceId,
        unfinished: 'No pudimos guardar el consentimiento, y puede que sí se haya firmado.',
      });
      if (replay !== null) {
        return { outcome: 'signed', id: null, wrong: [], replay: replay.response };
      }

      const fail = async (outcome: 'wrong_answers' | 'stale_version' | 'already' | 'no_text', wrong: readonly string[] = []) => {
        await release(c, { record: idempotency, accountId: caller.accountId });
        return { outcome, id: null, wrong, replay: null };
      };

      if (draft.treatmentId !== null) {
        const { rows } = await c.query<{ version: string; wrong: string[] }>(
          `select version, medskin_consent_wrong_answers($1, $2::jsonb) as wrong
             from consent_text
            where treatment_id = $1 and published order by version desc limit 1`,
          [draft.treatmentId, JSON.stringify(draft.answers)],
        );
        const text = rows[0];
        if (text === undefined) return fail('no_text');
        // «El texto cambió. Vuelve a leerlo»: firmar contra una versión vieja no prueba nada.
        if (text.version !== draft.version) return fail('stale_version');
        // NO ES UN MURO: la app vuelve al párrafo de la pregunta fallada.
        if (text.wrong.length > 0) return fail('wrong_answers', text.wrong);
      }

      const { rows: existing } = await c.query(
        `select 1 from consent
          where patient_id = $1 and purpose = $2 and version = $3 and revoked_at is null
            and (treatment_id is not distinct from $4)`,
        [draft.patientId, draft.purpose, draft.version, draft.treatmentId],
      );
      if (existing.length > 0) return fail('already');

      const { rows: added } = await c.query<{ id: string }>(
        `insert into consent (practice_id, patient_id, treatment_id, purpose, version, answers,
                              read_seconds, signed_by)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) returning id`,
        [
          caller.isPatient ? await this.practiceOf(c, draft.patientId) : caller.practiceId,
          draft.patientId,
          draft.treatmentId,
          draft.purpose,
          draft.version,
          JSON.stringify(draft.answers),
          draft.readSeconds,
          draft.signedBy,
        ],
      );
      const id = added[0]?.id ?? null;
      await complete(c, {
        record: idempotency,
        accountId: caller.accountId,
        status: 201,
        response: { id, estado: 'firmado', version: draft.version },
      });
      return { outcome: 'signed', id, wrong: [], replay: null };
    });
  }

  /** El consulta sale del vínculo de la paciente, nunca del cuerpo. */
  private async practiceOf(
    c: { query: (sql: string, values: unknown[]) => Promise<{ rows: { practice_id: string }[] }> },
    patientId: string,
  ): Promise<string> {
    const { rows } = await c.query(
      `select practice_id from patient_link where patient_id = $1 and status = 'vinculada'`,
      [patientId],
    );
    const found = rows[0];
    if (found === undefined) throw new Error('la paciente no tiene vínculo con esa consulta');
    return found.practice_id;
  }
}

/** La corrección vive en la base porque la clave no se puede leer desde aquí. */
export const WRONG_ANSWERS_IN_DOMAIN = wrongAnswers;
