// Los contadores de ritmo · `_convenciones.md` · «Los contadores».
//
// No son filas del dominio, y la razón no es el rendimiento: tienen que poder contar para un
// correo que NO tiene cuenta. Si solo contaran para los correos reales, `intentos_restantes`
// bajaría solo para ellos y el contador sería el oráculo que la respuesta idéntica cierra.
//
// Tres reglas, las tres del contrato:
//   1. se incrementa exista o no la cuenta;
//   2. la clave lleva el HMAC del correo, NUNCA el correo (un volcado de esta tabla no es un
//      padrón de pacientes de clínicas de estética), y HMAC y no un hash desnudo porque el
//      espacio de los correos es enumerable;
//   3. un fallo NO abre la puerta: lanza, y el endpoint responde 500.
//
// VIVÍAN EN REDIS Y AHORA VIVEN EN POSTGRES (0067). Era lo último que quedaba allí después de
// pasar las colas al backend de PostgreSQL de BullMQ 6, y mantener un servicio entero para cinco
// operaciones sobre claves con caducidad no se sostenía. Lo que no cambia es la semántica: la
// ventana se fija en el PRIMER incremento —una que se renueva en cada intento no caduca nunca y
// convierte una pausa de quince minutos en perpetua— y lo caducado se lee como ausente.
//
// Se entra por funciones y no por la tabla: un intento de acceso ocurre antes de saber de quién
// es, así que no hay inquilino que poner en el contexto y la tabla no se lee directamente.

import { createHmac } from 'node:crypto';

import type { Pool } from 'pg';

import { config } from '../config/config';
import { withTenantContext } from '../db/tenant-context';

export type Count = { hits: number; expiresAt: Date | null };

type Fila = { hits: number; expires_at: Date };

export class Counters {
  private readonly key: Buffer;

  constructor(
    private readonly pool: Pool,
    hmacKey: string = config().SERVICE_HMAC_KEY,
  ) {
    this.key = Buffer.from(hmacKey, 'utf8');
  }

  /** El identificador que entra en una clave: HMAC-SHA256 con la llave del servicio. */
  fingerprint(value: string): string {
    return createHmac('sha256', this.key).update(value.trim().toLowerCase()).digest('hex');
  }

  /** Lee sin tocar. Un error de la base se propaga: el límite falla hacia el lado incómodo. */
  async peek(name: string): Promise<Count> {
    const rows = await this.query<Fila>('select * from medskin_counter_peek($1)', [name]);
    return this.toCount(rows[0]);
  }

  /**
   * Incrementa y fija la ventana solo en el primer incremento: una ventana que se renueva
   * en cada intento no caduca nunca y convierte una pausa de 15 minutos en una perpetua.
   */
  async increment(name: string, windowSeconds: number): Promise<Count> {
    const rows = await this.query<Fila>('select * from medskin_counter_increment($1, $2)', [
      name,
      windowSeconds,
    ]);
    return this.toCount(rows[0]);
  }

  /**
   * Una marca con su propia caducidad, no un contador: solo importa si está o no está. Se
   * reescribe en cada llamada —al contrario que `increment()`, que fija la ventana una
   * sola vez— porque lo que marca es «esto vale hasta tal hora», y pedir otro código
   * mueve esa hora.
   */
  async mark(name: string, seconds: number): Promise<void> {
    await this.query('select medskin_counter_mark($1, $2)', [name, seconds]);
  }

  async has(name: string): Promise<boolean> {
    const rows = await this.query<{ medskin_counter_has: boolean }>(
      'select medskin_counter_has($1)',
      [name],
    );
    return rows[0]?.medskin_counter_has === true;
  }

  async forget(...names: string[]): Promise<void> {
    if (names.length === 0) return;
    await this.query('select medskin_counter_forget($1::text[])', [names]);
  }

  /** Lo caducado, que en Redis borraba el propio servidor. Lo llama el barrido de la hora. */
  async purgeExpired(limit = 10_000): Promise<number> {
    const rows = await this.query<{ medskin_counter_purge: number | null }>(
      'select medskin_counter_purge($1)',
      [limit],
    );
    return rows[0]?.medskin_counter_purge ?? 0;
  }

  private async query<T extends object>(sql: string, params: unknown[]): Promise<T[]> {
    return withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<T>(sql, params);
      return rows;
    });
  }

  /** Sin fila es «no existe»: lo caducado ya lo descartó la consulta. */
  private toCount(row: Fila | undefined): Count {
    if (row === undefined) return { hits: 0, expiresAt: null };
    return { hits: Number(row.hits), expiresAt: row.expires_at };
  }
}

export const COUNTER_KEYS = {
  signInByEmail: (fingerprint: string) => `acceso:intentos:${fingerprint}`,
  signInByIp: (ip: string) => `acceso:intentos:ip:${ip}`,

  // Los dos de `recuperacion.md` que la tabla escribe.
  recoveryRequestsByEmail: (fingerprint: string) => `recuperacion:pedidos:${fingerprint}`,
  recoveryAttemptsByEmail: (fingerprint: string) => `recuperacion:intentos:${fingerprint}`,

  // Los dos por IP de `recuperacion.md`. La tabla de `_convenciones.md` no los nombra,
  // pero los dos endpoints los exigen por texto: «más de 20 por IP» en el 429
  // `demasiados_codigos` y «más de 20 intentos por IP en 10 min» en el 429
  // `demasiados_intentos`. El nombre sigue la forma del acceso (`…:ip:<ip>`) para que no
  // haya dos convenciones de clave. Anotado para `producto`: faltan en esa tabla.
  recoveryRequestsByIp: (ip: string) => `recuperacion:pedidos:ip:${ip}`,
  recoveryAttemptsByIp: (ip: string) => `recuperacion:intentos:ip:${ip}`,

  /** `cuentas.md` · 429 `demasiados_reenvios`: «más de 3 en una hora para la misma cuenta». */
  accessResendsByAccount: (accountId: string) => `acceso:reenvios:${accountId}`,

  // El de `PATCH /v1/accounts/mine/password`: «5 fallos de `actual` en 15 min». No está
  // en la tabla de `_convenciones.md` y el contrato lo exige. Va por `cuenta_id` y no por
  // correo porque aquí quien llama ya está dentro: hay fila de cuenta segura que contar.
  passwordChangeByAccount: (accountId: string) => `cuenta:contrasena:intentos:${accountId}`,

  /**
   * `cuentas.md` · 429 `demasiadas_altas`: «más de 60 altas en una hora». No está en la
   * tabla de `_convenciones.md` y el contrato lo exige. Va por CONSULTA y no por cuenta: lo
   * que acota es el ritmo de altas de una consulta, que es la misma cuota la pida la doctora
   * o su asistente. Anotado para `producto`: falta en esa tabla.
   */
  patientCreationsByPractice: (practiceId: string) => `pacientes:altas:${practiceId}`,

  /**
   * La marca de «hay un código vivo para este correo», con la misma vida que el código.
   * No es un límite: es lo que permite que un correo SIN cuenta reciba los mismos dos 410
   * que uno con cuenta. Sin ella, el código de estado diría si el correo existe.
   */
  recoveryCodeIsLive: (fingerprint: string) => `recuperacion:vive:${fingerprint}`,
} as const;
