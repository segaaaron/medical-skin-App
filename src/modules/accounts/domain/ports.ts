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

// ---------------------------------------------------------------------------------------
// El acceso de SU paciente · `POST /v1/cuentas/{cuenta_id}/acceso`.
//
// La autorización no es un `if` del código: es la política de `patient_link` sobre
// `practice_id` más la función `SECURITY DEFINER` que empieza buscando ese vínculo. Un
// `cuenta_id` de otra consulta no devuelve fila, y esa es la respuesta.
// ---------------------------------------------------------------------------------------

/** Lo que hace falta para escribir el mensaje, y nada más. Ni un dato clínico. */
export type PatientForDelivery = {
  firstName: string;
  email: string;
  phone: string | null;
  /** El nombre con el que la doctora se presenta: «Dra. Andrea Paz». */
  practitionerName: string;
};

export type ResendOutcome = 'acceso_renovado' | 'ya_eligio_su_contrasena' | 'paciente_no_existe';

export interface PatientAccessPort {
  /**
   * La ficha de esa cuenta en ESTA consulta, bajo la política de `patient_link`. `null`
   * cuando no hay vínculo, que es la misma respuesta que un `cuenta_id` inventado.
   */
  forDelivery(owner: AccountOwner, accountId: string): Promise<PatientForDelivery | null>;

  /**
   * `medskin_resend_patient_access()`: acuña la temporal nueva, mata la anterior y marca
   * el envío. Devuelve el veredicto, nunca la fila.
   */
  resend(p: {
    owner: AccountOwner;
    accountId: string;
    hash: string;
    expiresAt: Date;
    via: string;
  }): Promise<{ outcome: ResendOutcome; expiresAt: Date | null }>;
}

/** El contador del `429 demasiados_reenvios`: «más de 3 en una hora para la misma cuenta». */
export interface ResendLimitPort {
  count(accountId: string): Promise<{ tooMany: boolean }>;
}
