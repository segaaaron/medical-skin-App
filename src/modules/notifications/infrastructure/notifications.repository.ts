// La bandeja de salida contra la base. TODO por funciones y con `app_anonymous`, igual que el
// trabajador de fotos y el barrido de idempotencia: un trabajo no tiene petición, así que no
// tiene consulta que fijar, y `medskin_access` es NOLOGIN y el rol de la aplicación no puede
// convertirse en él —lo cual es la garantía, no una molestia—. Lo que el trabajo tiene es
// `EXECUTE` sobre las funciones de la 0045, y nada más.

import type { Pool } from 'pg';

import { withTenantContext } from '../../../shared/db/tenant-context';
import type { Kind } from '../domain/notification';
import type {
  AppointmentToRemind,
  DeviceRow,
  EnqueueDraft,
  OutboxPort,
  PatientToReturn,
} from '../domain/ports';
import type { Channel, Notification } from '../domain/notification';

export class NotificationsRepository implements OutboxPort {
  constructor(private readonly pool: Pool) {}

  async enqueueAsJob(draft: EnqueueDraft): Promise<boolean> {
    return withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<{ id: string | null }>(
        'select medskin_notify_job($1, $2, $3, $4, $5, $6::jsonb, $7, $8) as id',
        [
          draft.practiceId,
          draft.accountId,
          draft.kind,
          draft.channel,
          draft.subjectKey,
          JSON.stringify(draft.data),
          draft.dedupeKey,
          draft.sendAfter,
        ],
      );
      // Nulo significa «ya estaba encolado», que es el trabajo repetible funcionando.
      return rows[0]?.id != null;
    });
  }

  async due(limit: number, maxAttempts: number): Promise<readonly Notification[]> {
    return withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<{
        id: string;
        practice_id: string;
        account_id: string;
        kind: string;
        channel: string;
        subject_key: string;
        data: Record<string, unknown>;
        attempts: number;
      }>('select * from medskin_notifications_due($1, $2)', [limit, maxAttempts]);
      return rows.map((row) => ({
        id: row.id,
        practiceId: row.practice_id,
        accountId: row.account_id,
        kind: row.kind as Kind,
        channel: row.channel as Channel,
        subjectKey: row.subject_key,
        data: row.data ?? {},
        attempts: row.attempts,
      }));
    });
  }

  async devicesOf(accountId: string): Promise<readonly DeviceRow[]> {
    return withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<{ id: string; token: string; platform: string }>(
        'select * from medskin_devices_of($1)',
        [accountId],
      );
      return rows.map((row) => ({
        id: row.id,
        token: row.token,
        platform: row.platform as 'ios' | 'android',
      }));
    });
  }

  async emailOf(accountId: string): Promise<string | null> {
    return withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<{ email: string | null }>(
        'select medskin_account_email($1) as email',
        [accountId],
      );
      return rows[0]?.email ?? null;
    });
  }

  async sent(id: string): Promise<void> {
    await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      await c.query('select medskin_notification_sent($1)', [id]);
    });
  }

  async failed(id: string, reason: string, maxAttempts: number): Promise<number> {
    return withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<{ attempts: number }>(
        'select medskin_notification_failed($1, $2, $3) as attempts',
        [id, reason.slice(0, 500), maxAttempts],
      );
      return rows[0]?.attempts ?? 0;
    });
  }

  async dropped(id: string, reason: string): Promise<void> {
    await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      await c.query('select medskin_notification_dropped($1, $2)', [id, reason.slice(0, 500)]);
    });
  }

  async postpone(id: string, minutes: number): Promise<void> {
    await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      await c.query('select medskin_notification_postpone($1, $2)', [id, minutes]);
    });
  }

  async deviceFailed(deviceId: string): Promise<void> {
    await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      await c.query('select medskin_device_failed($1)', [deviceId]);
    });
  }

  async deviceGone(deviceId: string): Promise<void> {
    await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      await c.query('select medskin_device_gone($1)', [deviceId]);
    });
  }

  async sweepStaleDevices(days: number, limit: number): Promise<number> {
    return withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<{ n: number }>('select medskin_devices_stale($1, $2) as n', [
        days,
        limit,
      ]);
      return rows[0]?.n ?? 0;
    });
  }

  async purgeSent(days: number, limit: number): Promise<number> {
    return withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<{ n: number }>(
        'select medskin_notifications_purge($1, $2) as n',
        [days, limit],
      );
      return rows[0]?.n ?? 0;
    });
  }

  async appointmentsToRemind(
    hours: number,
    windowMinutes: number,
  ): Promise<readonly AppointmentToRemind[]> {
    return withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<{
        appointment_id: string;
        practice_id: string;
        account_id: string;
        email: string;
        starts_at: Date;
        requires_consent: boolean;
        has_consent: boolean;
      }>('select * from medskin_appointments_to_remind($1, $2)', [hours, windowMinutes]);
      return rows.map((row) => ({
        appointmentId: row.appointment_id,
        practiceId: row.practice_id,
        accountId: row.account_id,
        email: row.email,
        startsAt: row.starts_at,
        requiresConsent: row.requires_consent,
        hasConsent: row.has_consent,
      }));
    });
  }

  async patientsToReturn(limit: number): Promise<readonly PatientToReturn[]> {
    return withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<{
        practice_id: string;
        account_id: string;
        email: string;
        treatment_id: string;
        due_on: string;
      }>(
        // LA FECHA SE PIDE YA COMO TEXTO, y no es cosmética: `node-postgres` convierte una
        // columna `date` en un `Date` de JavaScript a medianoche LOCAL, así que el
        // `String(...).slice(0, 10)` que había aquí daba **`"Sat Nov 2"`**. Y eso es lo que
        // viajaba en el `data` del aviso —la app espera una fecha—, lo que entraba en la clave de
        // deduplicación, y lo que la consulta comparaba para excluir a quien ya fue avisada: o
        // sea que el arreglo del `LIMIT 200` de la 0063 **no excluía a nadie**. Lo cazó la prueba
        // que mira la consulta en vez de fiarse de que `callBack()` devuelva 0, que es lo mismo
        // tanto si la exclusión funciona como si lo único que para el aviso es la deduplicación.
        `select practice_id, account_id, email, treatment_id,
                to_char(due_on, 'YYYY-MM-DD') as due_on
           from medskin_patients_to_return($1)`,
        [limit],
      );
      return rows.map((row) => ({
        practiceId: row.practice_id,
        accountId: row.account_id,
        email: row.email,
        treatmentId: row.treatment_id,
        dueOn: row.due_on,
      }));
    });
  }
}
