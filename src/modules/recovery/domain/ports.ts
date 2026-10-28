// Los puertos de la recuperación. Viven en el dominio; las implementaciones, en
// infraestructura. Sin NestJS, sin Fastify, sin `pg` y sin BullMQ.
//
// Puertos PEQUEÑOS (principio I): el caso de uso que pide un código no conoce la función
// que compara, y el trabajador que escribe el correo no conoce los contadores.

import type { CodeVerdict } from './code';

// ---------------------------------------------------------------------------------------
// Las tres funciones `SECURITY DEFINER` de la `0002`, que son la única vía a
// `recovery_code`: ningún rol de aplicación tiene un `SELECT` sobre esa tabla.
// ---------------------------------------------------------------------------------------

export type LiveCode = {
  verdict: CodeVerdict;
  /**
   * Nulo cuando el correo no tiene cuenta. NO sale nunca en una respuesta: decide si hay
   * algo que firmar, y nada más.
   */
  accountId: string | null;
  /** El hash real o el del señuelo. Nunca nulo: sin él no hay «mismo tiempo». */
  codeHash: string;
  expiresAt: Date;
  attemptsLeft: number;
  /** `intentos` | `codigo_nuevo` | `usado`. Solo cuando `verdict` es `voided`. */
  voidedReason: string | null;
};

export interface RecoveryCodePort {
  /**
   * `medskin_recovery_mint()`. Devuelve si había cuenta activa y ESTRENADA que acuñar.
   * Ese booleano no sale del servidor: decide si hay correo que escribir.
   */
  mint(p: { email: string; codeHash: string; expiresAt: Date }): Promise<boolean>;

  /** `medskin_recovery_live()`: el código vigente, o el señuelo. Nunca gasta un intento. */
  live(email: string): Promise<LiveCode>;

  /**
   * `medskin_recovery_miss()`: gasta un intento y anula el código al quinto. Solo se llama
   * cuando el código SE COMPARÓ DE VERDAD: el 500 de este endpoint promete que «el código
   * sigue valiendo», y un intento que se gasta por un fallo del servidor lo desmentiría.
   */
  miss(email: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// Los contadores. En Redis y no en filas, porque tienen que contar para un correo que no
// tiene cuenta (`_convenciones.md` · «Los contadores»). Un fallo de Redis NO abre la
// puerta: quien implementa lanza, y el endpoint responde 500.
// ---------------------------------------------------------------------------------------

export type RequestRoom = { tooMany: boolean };

export interface RecoveryLimitsPort {
  /**
   * Cuenta una petición de código, por correo y por IP, y dice si se pasó. Deja además la
   * marca de «hay un código vivo» y OLVIDA los intentos del código anterior: el código
   * nuevo empieza con sus cinco.
   */
  countRequest(p: { email: string; ip: string; expiresAt: Date }): Promise<RequestRoom>;

  /** Cuenta un intento por IP. `tooMany` es el `429 demasiados_intentos`. */
  countAttemptByIp(ip: string): Promise<RequestRoom>;

  /** Lo que Redis sabe de este correo antes de comparar nada. */
  historyOf(email: string): Promise<{
    attemptsSpent: number;
    codeIsLive: boolean;
    codeWasAsked: boolean;
  }>;

  /** Gasta un intento del contador por correo y devuelve cuántos quedan. */
  recordMiss(email: string): Promise<number>;

  /** El código se usó: sus contadores de intento ya no significan nada. */
  clearAttempts(email: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// La cola. Lo que se encola es A QUIÉN escribirle, nunca QUÉ escribirle: el código en
// claro no viaja en el trabajo (`recuperacion.md`). Lo acuña el trabajador.
// ---------------------------------------------------------------------------------------

export type RecoveryMailJob = {
  email: string;
  /** El mismo instante que el 202 ya le dijo a la app. El trabajador no lo recalcula. */
  expiresAt: Date;
};

export interface RecoveryQueuePort {
  enqueue(job: RecoveryMailJob): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// Lo que el trabajador necesita para escribir. El puerto es el de `shared/mail`, y aquí
// solo se nombra la plantilla: el asunto y el cuerpo son contrato.
// ---------------------------------------------------------------------------------------

export interface RecoveryMailPort {
  sendCode(p: { email: string; code: string; expiresAt: Date }): Promise<void>;
}
