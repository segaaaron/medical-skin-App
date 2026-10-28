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
