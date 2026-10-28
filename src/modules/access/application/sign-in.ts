// POST /v1/acceso · entrar. El único endpoint de autenticación del producto.
//
// EL ORDEN DE LAS COMPROBACIONES ES PARTE DEL CONTRATO (`acceso.md` · «El orden de las
// comprobaciones, que es parte del contrato») y es la diferencia entre cerrar y abrir el
// único oráculo del producto:
//
//   1. forma del cuerpo
//   2. la PAUSA, antes de verificar nada y exista o no la cuenta
//   3. el verificado de Argon2id SIEMPRE: contra el hash real, o contra el señuelo
//   4. si no coincide → 401 `acceso_no_coincide`, y AQUÍ TERMINA
//   5. solo si coincide → suspensión, temporal caducada, y el 200
//
// Hecho al revés, una petición con la contraseña inventada distingue un correo con cuenta
// de uno sin cuenta, y eso es dato de salud. `sign-in.spec.ts` fija el orden.

import { z } from 'zod';

import {
  ContractError,
  FAILURE_PHRASES,
  ServiceFailure,
} from '../../../shared/contract/error-catalog';
import type { NextStep, Region, Role, Scope } from '../../../shared/contract/session';
import { resolveNextStep } from '../domain/next-step';
import type {
  AccessPausePort,
  ClockPort,
  CredentialPort,
  Device,
  PasswordHasher,
  SessionPort,
  TokenPort,
} from '../domain/ports';
import { resolvePermissions, resolveRole } from '../domain/role';

/** Lo que `acceso.md` promete de la pausa: 5 intentos → 15 minutos. */
export const PAUSE_MINUTES = 15;

/** `sesion.md`: paciente 30 días · doctora y equipo 12 h. */
export const REFRESH_LIFETIME_MS = {
  patient: 30 * 24 * 60 * 60 * 1000,
  practitioner: 12 * 60 * 60 * 1000,
} as const;

// Paso 1 · la forma del cuerpo. Un campo `rol` se IGNORA SIN AVISAR: si el servidor
// devolviera un error por él, el error mismo documentaría que alguna vez existió.
const bodySchema = z.object({
  correo: z.string().optional(),
  contrasena: z.string().optional(),
});

export type SignInResponse = {
  token: string;
  token_caduca_en: string;
  refresco: string | null;
  refresco_caduca_en?: string;
  region: Region;
  rol: Role;
  siguiente_paso: NextStep;
  sesion_id: string;
};

export type SignInRequest = {
  body: unknown;
  ip: string;
  device: Device;
};

export class SignIn {
  constructor(
    private readonly credentials: CredentialPort,
    private readonly passwords: PasswordHasher,
    private readonly pause: AccessPausePort,
    private readonly sessions: SessionPort,
    private readonly tokens: TokenPort,
    private readonly clock: ClockPort,
  ) {}

  async run(request: SignInRequest): Promise<SignInResponse> {
    const { email, password } = this.readBody(request.body);

    // --- 2 · la pausa. Se devuelve ANTES de verificar nada, y se devuelve igual para un
    // correo que no existe: el contador vive fuera de la tabla `account` para que pueda.
    const before = await this.pause.peek(email, request.ip);
    if (before.paused) throw this.pausedError(before.pausedUntil);

    // --- 3 · el verificado, siempre. El hash es el real o el del señuelo, y la función de
    // la base garantiza que nunca falta: sin él no hay «mismo tiempo».
    const credential = await this.credentials.read(email);
    const matched = await this.passwords.verify(credential.hash, password);

    // --- 4 · si no coincide, aquí termina. No se consulta el estado de la cuenta, ni el
    // de la contraseña temporal, ni nada más.
    if (!matched || credential.accountId === null || credential.accountRole === null) {
      await this.credentials.recordAttempt(email, false);
      const after = await this.pause.recordFailure(email, request.ip);
      if (after.paused) throw this.pausedError(after.pausedUntil);
      throw this.mismatchError(after.attemptsLeft);
    }

    // --- 5 · solo si coincide. Las tres respuestas de aquí confirman que el correo tiene
    // cuenta, y solo las ve quien ya demostró saber la contraseña.
    if (credential.accountStatus !== 'activa') throw new ContractError('cuenta_suspendida');

    const now = this.clock.now();
    if (credential.isTemporary) {
      const expires = credential.tempExpiresAt;
      if (expires !== null && expires.getTime() <= now.getTime()) {
        throw new ContractError('contrasena_temporal_caducada', {
          caduco_en: expires.toISOString(),
        });
      }
      // No hay comprobación de «temporal ya usada», y es la decisión 27 del 27 de
      // octubre: `medskin_set_final_password()` pone `is_temporary = false` en la misma
      // sentencia que marca `temp_used_at`, así que entrar con la temporal vieja no
      // coincide con el hash y cae en `acceso_no_coincide` dos pasos más arriba. El
      // código salió del catálogo en vez de conservar el hash de la temporal 72 h para
      // mejorar una frase: eso es guardar una credencial muerta.
    }

    const role = resolveRole(credential.accountRole, credential.practitionerRole);
    if (role === null || credential.region === null) {
      // Una cuenta `practitioner` sin fila de consulta activa no tiene `rol` que devolver,
      // y no se inventa uno: es una inconsistencia del servidor, y va a `service_failure`
      // con su causa real.
      throw new ServiceFailure(
        FAILURE_PHRASES.signIn,
        new Error(`cuenta ${credential.accountId} sin rol de consulta ni region que devolver`),
      );
    }

    await this.credentials.recordAttempt(email, true);
    await this.pause.clear(email, request.ip);

    // «Ninguna otra pantalla se abre»: el alcance restringido autoriza dos endpoints, y
    // esa sesión no se puede prolongar, solo terminar eligiendo la contraseña.
    const scope: Scope = credential.isTemporary ? 'contrasena_temporal' : 'completo';
    const refresh = scope === 'completo' ? this.tokens.mintRefresh() : null;
    const lifetime =
      role === 'paciente' ? REFRESH_LIFETIME_MS.patient : REFRESH_LIFETIME_MS.practitioner;
    const refreshExpiresAt = refresh ? new Date(now.getTime() + lifetime) : null;

    const opened = await this.sessions.open({
      accountId: credential.accountId,
      accountRole: credential.accountRole,
      practiceId: credential.practiceId,
      scope,
      refreshDigest: refresh?.digest ?? null,
      refreshExpiresAt,
      device: request.device,
      region: credential.region,
      actorLabel: null,
    });

    const { token, expiresAt } = await this.tokens.sign({
      sub: credential.accountId,
      sid: opened.sessionId,
      rol: role,
      alcance: scope,
      region: credential.region,
      ...(credential.practiceId ? { practice: credential.practiceId } : {}),
      permisos: resolvePermissions(role, credential.permissions ?? null),
    });

    return {
      token,
      token_caduca_en: expiresAt.toISOString(),
      refresco: refresh?.refresh ?? null,
      ...(refreshExpiresAt ? { refresco_caduca_en: refreshExpiresAt.toISOString() } : {}),
      region: credential.region,
      rol: role,
      siguiente_paso: resolveNextStep(role, {
        passwordIsTemporary: credential.isTemporary,
        licenseStatus: opened.licenseStatus,
        firstDayDone: opened.firstDayDone,
      }),
      sesion_id: opened.sessionId,
    };
  }

  private readBody(input: unknown): { email: string; password: string } {
    const parsed = bodySchema.safeParse(input ?? {});
    const email = (parsed.success ? parsed.data.correo : undefined) ?? '';
    const password = (parsed.success ? parsed.data.contrasena : undefined) ?? '';
    if (email.trim() === '') throw new ContractError('correo_vacio');
    if (password === '') throw new ContractError('contrasena_vacia');
    // El correo se normaliza aquí y no en la base: la columna es `citext`, pero la clave
    // del contador de Redis es un HMAC de esta cadena y «A@b.com» y «a@b.com» tienen que
    // contar en el mismo sitio.
    return { email: email.trim().toLowerCase(), password };
  }

  /** La frase lleva la HORA, no «en 15 minutos»: la pausa puede haber empezado hace rato. */
  private pausedError(pausedUntil: Date | null): ContractError {
    const until = pausedUntil ?? new Date(this.clock.now().getTime() + PAUSE_MINUTES * 60_000);
    return new ContractError(
      'acceso_en_pausa',
      { pausa_hasta: until.toISOString() },
      `Demasiados intentos. Puedes volver a entrar a las ${this.clock.localTime(until)}.`,
    );
  }

  /** Dos piezas, dos trabajos: `mensaje` para los campos, `datos.aviso` para el snackbar. */
  private mismatchError(attemptsLeft: number): ContractError {
    // «Te quedan 1 intentos» no se le escribe a nadie: el contrato escribe el caso plural
    // y concordar el singular es interpolar bien, no cambiar la frase.
    const intentos = attemptsLeft === 1 ? '1 intento' : `${attemptsLeft} intentos`;
    return new ContractError('acceso_no_coincide', {
      // Decisión 19: los dos campos que se encienden viajan en `datos.campos`, porque
      // `campo` es uno y este es el único error del tramo con dos.
      campos: ['correo', 'contrasena'],
      intentos_restantes: attemptsLeft,
      pausa_minutos: PAUSE_MINUTES,
      aviso: `Te quedan ${intentos} antes de una pausa de ${PAUSE_MINUTES} minutos.`,
    });
  }
}
