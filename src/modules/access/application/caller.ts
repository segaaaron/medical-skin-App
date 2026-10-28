// Quién llama, resuelto del TOKEN y de nada más. Ningún caso de uso recibe un `cuenta_id`,
// un `practice_id` ni un `rol` del cuerpo o de la URL: la autorización es el contexto, y
// un identificador que viene del cliente no es una autorización (OWASP A01).

import type { AccountRole, Region, Role, Scope } from '../../../shared/contract/session';

export type Caller = {
  accountId: string;
  sessionId: string;
  role: Role;
  accountRole: AccountRole;
  scope: Scope;
  region: Region;
  /** Solo doctora y equipo. Nulo para una paciente: no es de ningún inquilino. */
  practiceId: string | null;
  permissions: readonly string[];
};

/**
 * Quien llega con un token de alcance `recuperacion`. Es a propósito MUCHO más pobre que
 * `Caller`: acertar un código de seis dígitos autoriza una pantalla, no una sesión.
 *
 * No hay `role`, no hay `practiceId` y no hay `sessionId` porque el token no los lleva
 * (`RecoveryClaims`): el rol sería el oráculo que `recuperacion.md` cierra, y la sesión
 * todavía no existe. Los tres se conocen al guardar la contraseña, y los devuelve la base
 * en esa misma transacción.
 */
export type RecoveryCaller = {
  via: 'recuperacion';
  accountId: string;
  region: Region;
};
