// Los puertos de las cuentas. Dominio: sin NestJS, sin Fastify, sin `pg`.

import type { AccountRole } from '../../../shared/contract/session';

/** Quién pregunta, siempre del token. Nunca un `cuenta_id` del cuerpo ni de la URL. */
export type AccountOwner = {
  accountId: string;
  practiceId: string | null;
  accountRole: AccountRole;
  sessionId: string;
};

export interface OwnCredentialPort {
  /**
   * El hash de quien ya está dentro, por `medskin_current_credential()`. El hash NUNCA
   * sale de la base por una consulta: no hay `GRANT SELECT (hash)` para ningún rol, así
   * que la única vía es esa función `SECURITY DEFINER` declarada `STABLE` (§7.3, regla 3),
   * y la comparación es Argon2id en Node.
   */
  readMine(owner: AccountOwner): Promise<{ hash: string } | null>;

  /**
   * La contraseña nueva MÁS la revocación de las demás sesiones, en UNA transacción.
   * «Cambiar la contraseña siempre revoca las demás sesiones y deja viva solo la que lo
   * hizo», y si fueran dos llamadas, un fallo entre ellas dejaría la contraseña nueva con
   * las sesiones viejas abiertas, que es justo lo que alguien intenta cortar.
   */
  replace(p: { owner: AccountOwner; hash: string }): Promise<{ sessionsRevoked: number }>;
}

/** El contador del `429` de este endpoint: «5 fallos de `actual` en 15 min». */
export interface PasswordAttemptsPort {
  /** Lee sin tocar, antes de comparar nada. */
  spent(accountId: string): Promise<number>;
  recordFailure(accountId: string): Promise<void>;
  clear(accountId: string): Promise<void>;
}
