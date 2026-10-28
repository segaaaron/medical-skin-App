// Idempotencia · `_convenciones.md` · Idempotencia.
//
// `(Idempotency-Key, cuenta que llama, cuerpo hasheado)` durante 24 h, y la repetición
// devuelve LA RESPUESTA COMPLETA, contraseña temporal incluida. Esa última parte es una
// decisión escrita del 27 de octubre y no una omisión: «una sola vez» significa que
// ninguna LECTURA posterior la trae, no que el reintento de la misma petición se quede sin
// ella. Devolverla mutilada rompería justo el caso que la idempotencia existe para cubrir:
// la app mandó el alta, perdió la respuesta y no tiene la contraseña que tiene que entregar.
//
// Mismo `Idempotency-Key` con cuerpo distinto → `409 clave_idempotencia_reutilizada`.
//
// En Redis y no en la tabla `idempotency_key`: lo que vence solo no necesita una fila que
// alguien tenga que barrer.

import { createHash } from 'node:crypto';

import type { Redis } from 'ioredis';

import { ContractError } from '../contract/error-catalog';

export const LIFETIME_SECONDS = 24 * 60 * 60;

type Stored = { fingerprint: string; status: number; response: unknown };

export type Replay = { status: number; response: unknown };

export class IdempotencyStore {
  constructor(private readonly redis: Redis) {}

  /**
   * La respuesta original si esta misma petición ya se atendió; `null` si es nueva.
   * Lanza `409` si la clave ya se usó con OTRO cuerpo.
   */
  async replay(p: { key: string; accountId: string; body: unknown }): Promise<Replay | null> {
    const stored = await this.redis.get(this.nameOf(p.key, p.accountId));
    if (stored === null) return null;

    const previous = JSON.parse(stored) as Stored;
    if (previous.fingerprint !== this.fingerprint(p.body)) {
      throw new ContractError('clave_idempotencia_reutilizada');
    }
    return { status: previous.status, response: previous.response };
  }

  async remember(p: {
    key: string;
    accountId: string;
    body: unknown;
    status: number;
    response: unknown;
  }): Promise<void> {
    const stored: Stored = {
      fingerprint: this.fingerprint(p.body),
      status: p.status,
      response: p.response,
    };
    await this.redis.set(
      this.nameOf(p.key, p.accountId),
      JSON.stringify(stored),
      'EX',
      LIFETIME_SECONDS,
    );
  }

  /**
   * La clave lleva la cuenta que llama: dos consultas distintas con el mismo uuid v4 —que
   * es improbable pero no imposible— no se pisan, y una clave robada no sirve en otra
   * cuenta.
   */
  private nameOf(key: string, accountId: string): string {
    return `idem:${accountId}:${key}`;
  }

  /** El cuerpo hasheado, con las claves en orden para que el mismo cuerpo dé la misma huella. */
  private fingerprint(body: unknown): string {
    return createHash('sha256').update(stableJson(body)).digest('hex');
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
  return `{${entries.join(',')}}`;
}
