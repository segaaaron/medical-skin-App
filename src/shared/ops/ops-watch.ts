// Vigilancia de lo que falla en silencio: avisos que no salen, fotos que no avanzan, el disco
// de las maestras y los push sin credencial. Cada hallazgo deja una fila en `service_failure`
// (con su causa), como mucho una vez por hora y por tipo, para no inundar el registro.

import type { Pool } from 'pg';

import { withTenantContext } from '../db/tenant-context';
import type { FailureLog } from '../failures/service-failure';
import { Periodic } from './periodic';

export const WATCH_INTERVAL_MS = 5 * 60_000;
const REPEAT_ALERT_MS = 60 * 60_000;
/** Un aviso con más de 30 min de retraso, o una foto 15 min en `procesando`, ya es un problema. */
const OVERDUE_SECONDS = 30 * 60;
const STUCK_SECONDS = 15 * 60;

export type WatchOptions = {
  /** Cuántos canales de push tienen credencial. Con 0, los push se encolan y no salen. */
  pushChannels: number;
  /** Tope de bytes de maestras que se considera lleno; nulo si no hay tope configurado. */
  storageAlertBytes: number | null;
  /** Solo en producción faltan canales de push como alarma: en desarrollo es lo normal. */
  production: boolean;
};

type Snapshot = {
  notifications_overdue: string;
  photos_stuck: string;
  photos_total: string;
  master_bytes: string;
};

export class OpsWatch {
  private readonly lastAlert = new Map<string, number>();
  private periodic: Periodic | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly failures: Pick<FailureLog, 'record'>,
    private readonly options: WatchOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /** Arranca el bucle y hace la primera comprobación ya, no dentro de cinco minutos. */
  start(): void {
    void this.check();
    this.periodic = new Periodic(WATCH_INTERVAL_MS, () => this.check());
  }

  onApplicationShutdown(): void {
    this.periodic?.stop();
  }

  /** Una pasada. No lanza: un fallo de la propia vigilancia se registra como un hallazgo más. */
  async check(): Promise<void> {
    try {
      const snap = await withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
        const { rows } = await c.query<Snapshot>('select * from medskin_ops_snapshot($1, $2)', [
          OVERDUE_SECONDS,
          STUCK_SECONDS,
        ]);
        return rows[0];
      });
      if (snap === undefined) return;

      const overdue = Number(snap.notifications_overdue);
      const stuck = Number(snap.photos_stuck);
      const bytes = Number(snap.master_bytes);

      if (overdue > 0) {
        await this.alert(
          'avisos_atrasados',
          `${overdue} aviso(s) con más de 30 min de retraso sin salir.`,
        );
      }
      if (stuck > 0) {
        await this.alert(
          'fotos_detenidas',
          `${stuck} foto(s) llevan más de 15 min en «procesando».`,
        );
      }
      const { storageAlertBytes } = this.options;
      if (storageAlertBytes !== null && bytes >= storageAlertBytes) {
        await this.alert(
          'almacenamiento_lleno',
          `Las maestras ocupan ${bytes} bytes (${snap.photos_total} fotos); el tope es ${storageAlertBytes}.`,
        );
      }
      if (this.options.production && this.options.pushChannels === 0) {
        await this.alert(
          'push_sin_configurar',
          'No hay credencial de ningún canal de push: los avisos push no salen.',
        );
      }
    } catch (cause) {
      await this.alert(
        'vigilancia_caida',
        'La comprobación de vigilancia no pudo leer la base.',
        cause,
      );
    }
  }

  private async alert(kind: string, message: string, cause?: unknown): Promise<void> {
    const at = this.now();
    const last = this.lastAlert.get(kind);
    if (last !== undefined && at - last < REPEAT_ALERT_MS) return;
    this.lastAlert.set(kind, at);
    await this.failures.record({
      service: 'worker',
      operation: `vigilancia.${kind}`,
      severity: 'error',
      errorCode: kind,
      cause: cause ?? new Error(message),
      traceId: `vigilancia-${kind}`,
      requestId: `vigilancia-${kind}`,
      appVersion: null,
      platform: null,
      region: null,
      context: null,
    });
  }
}
