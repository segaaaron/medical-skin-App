// Los puertos de `sesion.md`. Viven en el dominio y este archivo no importa NestJS, ni
// Fastify, ni Drizzle, ni `pg`: el caso de uso se prueba sin levantar nada.

import type {
  AccountRole,
  Claims,
  PractitionerRole,
  Scope,
} from '../../../shared/contract/session';

/** Quién pregunta, resuelto del TOKEN y de nada más (OWASP A01). */
export type SessionOwner = {
  accountId: string;
  /** `sid` del token. La fila se busca por él BAJO la política de `session`. */
  sessionId: string;
  practiceId: string | null;
  accountRole: AccountRole;
};

/**
 * Lo que `GET /v1/session` necesita saber de la base, y NADA MÁS: su obligación de
 * rendimiento es parte del contrato —«si pasa de 3 s aparece la barra»— y por eso no
 * devuelve pacientes, ni citas, ni nada que haya que buscar.
 */
export type SessionSnapshot = {
  /** `account.status`. Distinto de `activa` es el `403 cuenta_suspendida`. */
  accountStatus: string;
  /** No nulo es el `401 sesion_revocada`: «la sesión se cerró en otro sitio». */
  revokedAt: Date | null;
  /** Nulo cuando la sesión no tiene refresco, que es el caso del alcance restringido. */
  refreshExpiresAt: Date | null;
  /** Nulo para una paciente: no es de ninguna consulta (§12.2.1). */
  practice: { id: string; name: string } | null;
  /** «¿Declaró su matrícula?». Era su `status`, que se fue con la revisión manual (0072). */
  licenseDeclared: boolean;
  firstDayDone: boolean;
  /**
   * `practitioner.permissions`, que admite nulo y nulo significa «los de su rol». La
   * resolución la hace el servidor y nunca la app (`_convenciones.md`).
   */
  permissions: readonly string[] | null;
};

export interface SessionSnapshotPort {
  /**
   * Nulo cuando `id = sid` no es una fila de ESTA cuenta: la política de `session` decide,
   * no un `if` nuestro, y un `sid` de otra cuenta no devuelve fila.
   */
  read(owner: SessionOwner): Promise<SessionSnapshot | null>;
}

// ---------------------------------------------------------------------------------------
// `POST /v1/session/refresh` · lo que devuelve `medskin_session_refresh()` (migración
// 0018), que es la que rota, detecta el reuso Y resuelve la ventana de gracia de 20 s.
// Ninguna de esas tres reglas se vuelve a escribir en TypeScript.
// ---------------------------------------------------------------------------------------

/** Los cinco veredictos de la función, tal cual. */
export type RefreshVerdict = 'rotated' | 'reused' | 'revoked' | 'expired' | 'invalid';

/**
 * El veredicto completo. Todo lo que no es `rotated` llega con los campos de la cuenta en
 * nulo —la función no los devuelve, y es correcto: un refresco que no vale no autoriza a
 * saber de quién era—, así que quien lo lee resuelve el 401 y no mira nada más.
 */
export type RotatedRefresh = {
  verdict: RefreshVerdict;
  sessionId: string | null;
  accountId: string | null;
  /** Se copia de la FILA de la sesión, nunca del cuerpo: si no, sería cambiar de consulta. */
  practiceId: string | null;
  scope: Scope | null;
  /** `account.role`: el rol de autenticación, que no es el `rol` que viaja al cliente. */
  accountRole: AccountRole | null;
  /** `practitioner.role` de la consulta de ESA sesión, y solo si la fila está activa. */
  practitionerRole: PractitionerRole | null;
  permissions: readonly string[] | null;
  accountStatus: string | null;
  passwordIsTemporary: boolean;
  licenseDeclared: boolean;
  firstDayDone: boolean;
  refreshExpiresAt: Date | null;
  /** Entró por la ventana de 20 s. No sale en la respuesta: se mide, no se cuenta al cliente. */
  graced: boolean;
};

export interface RefreshPort {
  /**
   * `medskin_session_refresh()` con `app_anonymous`: cuando llega esta petición no hay
   * sesión que leer, y por eso no se fija ningún contexto.
   *
   * `withinTransaction` corre DENTRO de la transacción de la rotación, con el veredicto ya
   * en mano. Si lanza, el `ROLLBACK` deshace la rotación y **el refresco que llegó sigue
   * valiendo**. Es lo que hace cumplible el `429`: su frase promete «espera y reintenta
   * con retroceso», y eso solo es verdad si el intento denegado no se gastó el refresco.
   */
  rotate(p: {
    digest: string;
    newDigest: string;
    /**
     * Las dos vidas del contrato en SEGUNDOS, y la función elige con el rol en la mano
     * (migración 0020): paciente 30 días, doctora y equipo 12 h. El número viaja desde
     * aquí para que no esté duplicado en la base; la base le pone la cota, que es lo que
     * convierte un cambio de orden de los dos argumentos en un fallo a gritos en vez de
     * en un refresco de 30 días para una doctora.
     */
    patientSeconds: number;
    practitionerSeconds: number;
    withinTransaction: (verdict: RotatedRefresh) => Promise<void>;
  }): Promise<RotatedRefresh>;
}

/**
 * El límite del `429` y la medida de la gracia, los dos sobre Redis.
 *
 * `countRefresh` se llama DENTRO de la transacción de la rotación a propósito: así el
 * refresco denegado no se gasta, y un fallo de Redis tampoco regala una rotación. Un
 * límite que falla hacia el lado cómodo no es un límite (`_convenciones.md`).
 */
export interface RefreshLimitsPort {
  /** Lanza `429 demasiados_refrescos` al pasar de 60 en una hora para ese `sid`. */
  countRefresh(sessionId: string, graced: boolean): Promise<void>;
}

/**
 * El acuñador, visto desde este endpoint. Es el `TokenPort` del acceso **más**
 * `digestRefresh`, que el refresco necesita y el acceso no: ahí el refresco se acuña
 * —y el resumen sale con él—, aquí llega uno de fuera y hay que resumirlo para buscarlo.
 *
 * Puerto propio y no un método más en el del acceso: añadírselo obligaría a cambiar todos
 * sus dobles de prueba para una firma que ninguno de sus casos de uso llama (OWASP A01 no
 * entra aquí, pero el principio de interfaces pequeñas sí).
 */
export interface RefreshTokenPort {
  sign(claims: Claims): Promise<{ token: string; expiresAt: Date }>;
  mintRefresh(): { refresh: string; digest: string };
  /** HMAC-SHA256 determinista: hay un índice único sobre la columna y hay que buscarla. */
  digestRefresh(refresh: string): string;
}
