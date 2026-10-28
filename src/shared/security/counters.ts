// Los contadores de ritmo · `_convenciones.md` · «Los contadores».
//
// No son filas, y la razón no es el rendimiento: es que tienen que poder contar para un
// correo que NO tiene cuenta. Si solo contaran para los correos reales, `intentos_restantes`
// bajaría solo para ellos y el contador sería el oráculo que la respuesta idéntica cierra.
//
// Tres reglas, las tres del contrato:
//   1. se incrementa exista o no la cuenta;
//   2. la clave lleva el HMAC del correo, NUNCA el correo (un volcado de Redis no es un
//      padrón de pacientes de clínicas de estética), y HMAC y no un hash desnudo porque el
//      espacio de los correos es enumerable;
//   3. un fallo de Redis NO abre la puerta: lanza, y el endpoint responde 500.

import { createHmac } from 'node:crypto';

import type { Redis } from 'ioredis';

import { config } from '../config/config';

export type Count = { hits: number; expiresAt: Date | null };

export class Counters {
  private readonly key: Buffer;

  constructor(
    private readonly redis: Redis,
    hmacKey: string = config().SERVICE_HMAC_KEY,
  ) {
    this.key = Buffer.from(hmacKey, 'utf8');
  }

  /** El identificador que entra en una clave: HMAC-SHA256 con la llave del servicio. */
  fingerprint(value: string): string {
    return createHmac('sha256', this.key).update(value.trim().toLowerCase()).digest('hex');
  }

  /** Lee sin tocar. Un error de Redis se propaga: el límite falla hacia el lado incómodo. */
  async peek(name: string): Promise<Count> {
    const result = await this.redis.multi().get(name).pttl(name).exec();
    if (result === null) throw new Error('Redis abortó la transacción del contador.');
    return this.toCount(Number(result[0]?.[1] ?? 0), Number(result[1]?.[1] ?? -2));
  }

  /**
   * Incrementa y fija la ventana solo en el primer incremento: una ventana que se renueva
   * en cada intento no caduca nunca y convierte una pausa de 15 minutos en una perpetua.
   */
  async increment(name: string, windowSeconds: number): Promise<Count> {
    const result = await this.redis
      .multi()
      .incr(name)
      .expire(name, windowSeconds, 'NX')
      .pttl(name)
      .exec();
    if (result === null) throw new Error('Redis abortó la transacción del contador.');
    return this.toCount(Number(result[0]?.[1] ?? 0), Number(result[2]?.[1] ?? -2));
  }

  async forget(...names: string[]): Promise<void> {
    if (names.length > 0) await this.redis.del(...names);
  }

  private toCount(hits: number, ttlMs: number): Count {
    return {
      hits: Number.isFinite(hits) ? hits : 0,
      expiresAt: ttlMs > 0 ? new Date(Date.now() + ttlMs) : null,
    };
  }
}

/**
 * Las claves del tramo, escritas una sola vez. Cada una es la del contrato, literal: si
 * alguien las reescribe en otro sitio, dos endpoints cuentan en dos cubos distintos y el
 * límite deja de ser un límite.
 */
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

  // El de `PATCH /v1/cuentas/mia/contrasena`: «5 fallos de `actual` en 15 min». No está
  // en la tabla de `_convenciones.md` y el contrato lo exige. Va por `cuenta_id` y no por
  // correo porque aquí quien llama ya está dentro: hay fila de cuenta segura que contar.
  passwordChangeByAccount: (accountId: string) => `cuenta:contrasena:intentos:${accountId}`,
} as const;
