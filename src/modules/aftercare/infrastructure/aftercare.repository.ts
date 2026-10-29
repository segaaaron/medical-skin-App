// Los cuidados, el hilo, los dispositivos y los avisos.
//
// EL PLAN SE COPIA AL FIRMAR Y NO SE RECALCULA: `care_step.text` y `appears_at` son copias del
// protocolo del día de la firma. Cambiar el protocolo después no mueve lo que ya se le mandó,
// «y una paciente no ve cambiar instrucciones que ya cumplió».

import type { Pool, PoolClient } from 'pg';

import { FAILURE_PHRASES, ServiceFailure } from '../../../shared/contract/error-catalog';
import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import { claim, complete, release } from '../../../shared/idempotency/idempotency-rows';
import type {
  AftercareCaller,
  AftercarePort,
  CarePlanRow,
  MessageRow,
  ThreadRow,
} from '../domain/ports';

function contextOf(caller: AftercareCaller): TenantContext {
  if (caller.isPatient) return { role: 'app_patient', accountId: caller.accountId };
  return { role: 'app_practitioner', practiceId: caller.practiceId, accountId: caller.accountId };
}

export class AftercareRepository implements AftercarePort {
  constructor(private readonly pool: Pool) {}

  async plans(caller: AftercareCaller, patientId: string | null): Promise<readonly CarePlanRow[]> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query<Record<string, unknown>>(
        `select p.id, p.practice_name, p.treatment_name, p.session_at,
                coalesce((select jsonb_agg(jsonb_build_object(
                            'id', s.id, 'appearsAt', s.appears_at, 'text', s.text,
                            'doneAt', coalesce(s.done_reported_at, s.done_at))
                            order by s.appears_at)
                            from care_step s where s.plan_id = p.id), '[]'::jsonb) as steps
           from care_plan p
          where ($1::uuid is null or p.patient_id = $1)
          order by p.session_at desc`,
        [patientId],
      );
      return rows.map(mapPlan);
    });
  }

  async markStep(
    caller: AftercareCaller,
    stepId: string,
    p: { doneAt: Date; now: Date },
  ): Promise<{ outcome: 'done' | 'no_step' | 'future' }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query<{ appears_at: Date; done_at: Date | null }>(
        `select appears_at, done_at from care_step where id = $1`,
        [stepId],
      );
      const step = rows[0];
      if (step === undefined) return { outcome: 'no_step' };
      // «Ese cuidado todavía no toca.»
      if (step.appears_at > p.now) return { outcome: 'future' };
      // Idempotente: marcar lo marcado deja lo mismo, y NO se desmarca nunca.
      if (step.done_at !== null) return { outcome: 'done' };

      await c.query(
        // El instante que vale es el que la app registró, no el de la llegada: se puede marcar
        // sin conexión y la bandeja de salida lo manda cuando vuelve la señal.
        `update care_step set done_at = now(), done_reported_at = $2 where id = $1`,
        [stepId, p.doneAt],
      );
      return { outcome: 'done' };
    });
  }

  async trafficLight(
    caller: AftercareCaller,
    sessionId: string,
  ): Promise<readonly { day: number; normal: string; callIf: string }[] | null> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // El semáforo es DEL TRATAMIENTO, no de la paciente: se escribe una vez y sirve para
      // todas. Se llega por la sesión para que solo lo vea quien tuvo esa sesión.
      const { rows } = await c.query<{ day: number; normal: string; call_if: string }>(
        `select t.day, t.normal, t.call_if
           from care_plan p
           join clinical_session s on s.id = p.session_id
           join appointment a on a.id = s.appointment_id
           join treatment_traffic_light t on t.treatment_id = a.treatment_id
          where p.session_id = $1
          order by t.day`,
        [sessionId],
      );
      if (rows.length === 0) return null;
      return rows.map((row) => ({ day: row.day, normal: row.normal, callIf: row.call_if }));
    });
  }

  async reportIncident(
    caller: AftercareCaller,
    p: {
      sessionId: string;
      what: string;
      since: string | null;
      perceived: string;
      photoIds: readonly string[];
    },
    idempotency: IdempotencyRecord,
    render: (answer: {
      id: string;
      practitioner: string | null;
      phone: string | null;
      notified: boolean;
    }) => unknown,
  ): Promise<{
    outcome: 'received' | 'no_session';
    id: string | null;
    practitioner: string | null;
    phone: string | null;
    notified: boolean;
    replay: unknown;
  }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // LA RESERVA ANTES DE ESCRIBIR NADA. El contrato declara `Idempotency-Key` en este
      // `POST` y el tramo 7 no la leia: «la paciente reporta con mala senal, la respuesta se
      // pierde y la app reintenta —que es lo que el diseno le pide—», y quedaban dos
      // incidencias identicas en la pantalla de la urgencia.
      const replay = await claim<unknown>(c, {
        record: idempotency,
        accountId: caller.accountId,
        practiceId: caller.isPatient ? null : caller.practiceId,
        unfinished: 'No pudimos registrar lo que nos contaste, y puede que sí se haya registrado.',
      });
      if (replay !== null) {
        return {
          outcome: 'received',
          id: null,
          practitioner: null,
          phone: null,
          notified: false,
          replay: replay.response,
        };
      }

      // El `practice_id` sale de LA SESIÓN, nunca del cuerpo.
      const { rows: sessions } = await c.query<{
        practice_id: string;
        patient_id: string;
        practitioner_name: string;
        phone: string | null;
      }>(
        // El teléfono por la función de la 0041: `app_patient` no lee `practice`, y la
        // respuesta de una incidencia LO LLEVA SIEMPRE.
        `select s.practice_id, s.patient_id, l.practitioner_name,
                medskin_patient_practice_phone(s.practice_id) as phone
           from clinical_session s
           join patient_link l on l.patient_id = s.patient_id
          where s.id = $1`,
        [p.sessionId],
      );
      const session = sessions[0];
      if (session === undefined) {
        await release(c, { record: idempotency, accountId: caller.accountId });
        return {
          outcome: 'no_session',
          id: null,
          practitioner: null,
          phone: null,
          notified: false,
          replay: null,
        };
      }

      const { rows } = await c.query<{ id: string }>(
        `insert into incident (practice_id, patient_id, session_id, what, since, perceived)
         values ($1, $2, $3, $4, $5::date, $6) returning id`,
        [session.practice_id, session.patient_id, p.sessionId, p.what, p.since, p.perceived],
      );
      const id = rows[0]!.id;

      for (const photoId of p.photoIds) {
        await c.query(
          `insert into incident_photo (incident_id, photo_id, practice_id)
           values ($1, $2, $3) on conflict do nothing`,
          [id, photoId, session.practice_id],
        );
      }

      // EL AVISO A LA CONSULTA, EN LA MISMA TRANSACCIÓN QUE LA INCIDENCIA. Esto es lo que
      // convierte en verdad la frase que lee la paciente —«Tu doctora lo recibió y te va a
      // responder por el chat»—, que hasta hoy no la respaldaba una sola línea de código.
      //
      // Ni el texto de lo que reportó ni la gravedad viajan en el aviso: el push lleva el
      // identificador y la frase neutra, y la doctora abre la app para leerlo (§11.1).
      //
      // La función resuelve la cuenta de la consulta: `app_patient` no lee `practice`. Y
      // DEVUELVE NULO SI NO HAY A QUIÉN AVISAR: `practice.owner_account_id` es una columna
      // nullable desde el tramo 1, así que una consulta sin dueña registrada no recibe nada.
      // Si no se encoló, la respuesta NO puede decir «tu doctora lo recibió»: ese es el
      // defecto original de este endpoint, con otra condición de entrada.
      const { rows: queued } = await c.query<{ id: string | null }>(
        `select medskin_notify_practice($1, 'incidencia', 'push', 'incidencia',
                                        jsonb_build_object('incidencia_id', $2::text,
                                                           'paciente_id', $3::text),
                                        $4, now()) as id`,
        [session.practice_id, id, session.patient_id, `incidencia:${id}`],
      );

      const answer = {
        outcome: 'received' as const,
        id,
        practitioner: session.practitioner_name,
        phone: session.phone,
        notified: queued[0]?.id != null,
      };
      await complete(c, {
        record: idempotency,
        accountId: caller.accountId,
        status: 201,
        response: render(answer),
      });
      return { ...answer, replay: null };
    });
  }

  async thread(
    caller: AftercareCaller,
    p: { patientId: string; practiceId: string },
    create: boolean,
  ): Promise<ThreadRow | 'revoked' | null> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows: links } = await c.query<{ status: string }>(
        `select status from patient_link where patient_id = $1 and practice_id = $2`,
        [p.patientId, p.practiceId],
      );
      // «Ese chat está cerrado»: un vínculo revocado no tiene hilo.
      if (links[0]?.status === 'revocada') return 'revoked';

      // UN `GET` NO ESCRIBE. Leer el hilo lo CREABA, y una lectura que inserta es una lectura
      // que no se puede repetir en una replica ni cachear, y una fila que aparece porque
      // alguien miró. Lo crea el `POST`, que es el que tiene algo que guardar.
      if (!create) {
        const { rows } = await c.query<{ id: string; closed_at: Date | null }>(
          `select id, closed_at from message_thread
            where practice_id = $2 and patient_id = $1`,
          [p.patientId, p.practiceId],
        );
        const found = rows[0];
        return found === undefined ? null : { id: found.id, closedAt: found.closed_at };
      }

      const { rows } = await c.query<{ id: string; closed_at: Date | null }>(
        `insert into message_thread (practice_id, patient_id) values ($2, $1)
         on conflict (practice_id, patient_id) do update set practice_id = excluded.practice_id
         returning id, closed_at`,
        [p.patientId, p.practiceId],
      );
      return { id: rows[0]!.id, closedAt: rows[0]!.closed_at };
    });
  }

  async messages(
    caller: AftercareCaller,
    threadId: string,
    before: Date | null,
  ): Promise<readonly MessageRow[]> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query<Record<string, unknown>>(
        `select id, author, body, created_at, read_at from message
          where thread_id = $1 and ($2::timestamptz is null or created_at < $2)
          order by created_at desc limit 50`,
        [threadId, before],
      );
      return rows.map((row) => ({
        id: row.id as string,
        author: row.author as string,
        body: row.body as string,
        createdAt: row.created_at as Date,
        readAt: (row.read_at as Date | null) ?? null,
      }));
    });
  }

  async send(
    caller: AftercareCaller,
    threadId: string,
    body: string,
    idempotency: IdempotencyRecord,
  ): Promise<{ outcome: 'sent' | 'too_many'; id: string | null; replay: unknown }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // Igual que la incidencia: sin clave, un reintento duplicaba el mensaje en el hilo.
      const replay = await claim<unknown>(c, {
        record: idempotency,
        accountId: caller.accountId,
        practiceId: caller.isPatient ? null : caller.practiceId,
        unfinished: 'No pudimos enviar tu mensaje, y puede que sí se haya enviado.',
      });
      if (replay !== null) return { outcome: 'sent', id: null, replay: replay.response };

      // «Un hilo no es un canal de soporte en vivo»: 30 por hora y por hilo, en los DOS
      // sentidos. Se cuenta en la base y no en Redis porque el límite es del hilo, no del
      // correo ni de la IP, y la fila ya está aquí.
      const { rows: recent } = await c.query<{ n: string }>(
        `select count(*)::text as n from message
          where thread_id = $1 and created_at > now() - interval '1 hour'`,
        [threadId],
      );
      if (Number(recent[0]?.n ?? 0) >= 30) {
        await release(c, { record: idempotency, accountId: caller.accountId });
        return { outcome: 'too_many', id: null, replay: null };
      }

      const { rows } = await c.query<{ id: string }>(
        `insert into message (practice_id, thread_id, author, author_account_id, body)
         select t.practice_id, t.id, $2, $3, $4 from message_thread t where t.id = $1
         returning id`,
        [threadId, caller.isPatient ? 'paciente' : 'consulta', caller.accountId, body],
      );
      // SI NO SE INSERTÓ NADA, NO SE ENVIÓ NADA. El `insert … select from message_thread`
      // no afecta ninguna fila si el hilo no existe o la política no lo ve, y
      // `rows[0]?.id ?? null` convertía ese dato ausente en `{ enviado: true, id: null }` —y
      // peor: ese cuerpo se guardaba en la clave de idempotencia, así que el reintento de las
      // 24 horas también afirmaba que se había enviado—. La frase del 500 de este endpoint es
      // la del contrato: el mensaje está guardado en el teléfono y se reintenta.
      const id = rows[0]?.id ?? null;
      if (id === null) {
        await release(c, { record: idempotency, accountId: caller.accountId });
        // La frase sale del catálogo y no se copia aquí: dos copias de la misma frase de
        // usuario es cómo se desincronizan.
        throw new ServiceFailure(
          FAILURE_PHRASES.sendMessage,
          new Error(`el hilo ${threadId} no admitió el mensaje`),
        );
      }

      await c.query(`update message_thread set last_message_at = now() where id = $1`, [threadId]);
      // «Tienes un mensaje», sin el texto: el de un mensaje clínico no viaja a una pantalla de
      // bloqueo. Va a la otra parte del hilo, y el identificador del mensaje es la clave de
      // deduplicación, así que un reintento no manda dos avisos.
      if (id !== null) {
        if (caller.isPatient) {
          await c.query(
            `select medskin_notify_practice(t.practice_id, 'mensaje', 'push', 'mensaje',
                                            jsonb_build_object('hilo_id', t.id::text),
                                            $2, now())
               from message_thread t where t.id = $1`,
            [threadId, `mensaje:${id}`],
          );
        } else {
          await c.query(
            `select medskin_notify_patient(t.practice_id, t.patient_id, 'mensaje', 'push',
                                           'mensaje',
                                           jsonb_build_object('hilo_id', t.id::text),
                                           $2, now())
               from message_thread t where t.id = $1`,
            [threadId, `mensaje:${id}`],
          );
        }
      }
      await complete(c, {
        record: idempotency,
        accountId: caller.accountId,
        status: 201,
        response: { id, enviado: true },
      });
      return { outcome: 'sent', id, replay: null };
    });
  }

  async registerDevice(
    caller: AftercareCaller,
    p: { deviceId: string; token: string; platform: string; appVersion: string | null; permission: string },
  ): Promise<void> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // Un token POR DISPOSITIVO: volver a registrar el mismo lo refresca y no lo duplica, y
      // los contadores de fallo vuelven a cero porque es un token nuevo.
      await c.query(
        `insert into device (account_id, device_id, token, platform, app_version, permission)
         values (medskin_current_account(), $1, $2, $3, $4, $5)
         on conflict (account_id, device_id) do update
            set token = excluded.token, platform = excluded.platform,
                app_version = excluded.app_version, permission = excluded.permission,
                failures = 0, last_seen_at = now()`,
        [p.deviceId, p.token, p.platform, p.appVersion, p.permission],
      );
    });
  }

  async forgetDevice(caller: AftercareCaller, deviceId: string): Promise<boolean> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rowCount } = await c.query(`delete from device where device_id = $1`, [deviceId]);
      return rowCount === 1;
    });
  }

  async preferences(
    caller: AftercareCaller,
  ): Promise<{ appointments: boolean; care: boolean; promotions: boolean; quietFrom: string | null; quietTo: string | null }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => this.readPrefs(c));
  }

  async savePreferences(
    caller: AftercareCaller,
    p: { appointments?: boolean; care?: boolean; promotions?: boolean; quietFrom?: string | null; quietTo?: string | null },
  ): Promise<{ appointments: boolean; care: boolean; promotions: boolean; quietFrom: string | null; quietTo: string | null }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      await c.query(
        `insert into alert_preference (account_id, appointment_reminders, care_reminders,
                                       promotions, quiet_from, quiet_to)
         values (medskin_current_account(), coalesce($1, true), coalesce($2, true),
                 coalesce($3, true), $4::time, $5::time)
         on conflict (account_id) do update
            set appointment_reminders = coalesce($1, alert_preference.appointment_reminders),
                care_reminders = coalesce($2, alert_preference.care_reminders),
                promotions = coalesce($3, alert_preference.promotions),
                quiet_from = coalesce($4::time, alert_preference.quiet_from),
                quiet_to = coalesce($5::time, alert_preference.quiet_to),
                updated_at = now()`,
        [
          p.appointments ?? null,
          p.care ?? null,
          p.promotions ?? null,
          p.quietFrom ?? null,
          p.quietTo ?? null,
        ],
      );
      return this.readPrefs(c);
    });
  }

  /** El vínculo de la paciente: su inquilino y su ficha salen de ahí, nunca del cuerpo. */
  async linkedPatient(
    accountId: string,
    practiceId: string,
  ): Promise<{ patientId: string } | 'invitada' | 'revocada' | null> {
    return withTenantContext(this.pool, { role: 'app_patient', accountId }, async (c) => {
      const { rows } = await c.query<{ patient_id: string; status: string }>(
        `select patient_id, status from patient_link where practice_id = $1`,
        [practiceId],
      );
      const link = rows[0];
      if (link === undefined) return null;
      if (link.status === 'revocada') return 'revocada';
      if (link.status !== 'vinculada') return 'invitada';
      return { patientId: link.patient_id };
    });
  }

  private async readPrefs(c: PoolClient): Promise<{
    appointments: boolean;
    care: boolean;
    promotions: boolean;
    quietFrom: string | null;
    quietTo: string | null;
  }> {
    const { rows } = await c.query<{
      appointment_reminders: boolean;
      care_reminders: boolean;
      promotions: boolean;
      quiet_from: string | null;
      quiet_to: string | null;
    }>(
      `select appointment_reminders, care_reminders, promotions,
              quiet_from::text as quiet_from, quiet_to::text as quiet_to
         from alert_preference where account_id = medskin_current_account()`,
    );
    const row = rows[0];
    // Sin fila, todo encendido: quien no eligió nada recibe lo que su app le prometió.
    return {
      appointments: row?.appointment_reminders ?? true,
      care: row?.care_reminders ?? true,
      promotions: row?.promotions ?? true,
      quietFrom: row?.quiet_from?.slice(0, 5) ?? null,
      quietTo: row?.quiet_to?.slice(0, 5) ?? null,
    };
  }
}

function mapPlan(row: Record<string, unknown>): CarePlanRow {
  return {
    id: row.id as string,
    practiceName: row.practice_name as string,
    treatmentName: row.treatment_name as string,
    sessionAt: row.session_at as Date,
    steps: (row.steps as { id: string; appearsAt: string; text: string; doneAt: string | null }[]).map(
      (step) => ({
        id: step.id,
        appearsAt: new Date(step.appearsAt),
        text: step.text,
        doneAt: step.doneAt === null ? null : new Date(step.doneAt),
      }),
    ),
  };
}
