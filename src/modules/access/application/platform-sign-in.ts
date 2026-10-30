// POST /v1/platform/access · entrar a la consola interna.
//
// EL MISMO ORDEN QUE `POST /v1/access`, y por la misma razón (`plataforma-acceso.md` · «La
// entrada de la consola» · Reglas de negocio):
//
//   1. forma del cuerpo
//   2. la PAUSA, antes de verificar nada y exista o no la fila
//   3. el verificado de Argon2id SIEMPRE: contra el hash real, o contra el señuelo
//   4. si no coincide → 401 `acceso_no_coincide`, y AQUÍ TERMINA
//   5. solo si coincide → `status`, y la firma
//
// Y aquí el oráculo importa más que en la app, no menos: este es el **único** endpoint de
// consola alcanzable sin token, así que es el único que un desconocido puede golpear desde
// internet. Un 401 que distinguiera «ese correo no existe» de «esa contraseña está mal»
// serviría la lista de los correos del equipo de MedSkin a quien pregunte. Es un padrón.
//
// Va en el módulo `access` y no en uno nuevo porque reusa cuatro piezas que ya están aquí:
// el `PasswordHasher` de Argon2id, el hash señuelo, los contadores de `rate_counter` y la
// escalera de la pausa. Un módulo aparte sería una copia de las cuatro.

import { z } from 'zod';

import type { Config } from '../../../shared/config/config';
import {
  ContractError,
  PLATFORM_SUSPENDED_MESSAGE,
} from '../../../shared/contract/error-catalog';
import {
  PLATFORM_PERMISSIONS,
  type PlatformPermission,
  type PlatformTokens,
} from '../../../shared/platform/platform-token';
import type { AccessPausePort, ClockPort, PasswordHasher } from '../domain/ports';
import type {
  PlatformCredentialPort,
  PlatformSignInResponse,
} from '../domain/platform-credential';
import { PAUSE_MINUTES } from './sign-in';

// Sin `permisos` y sin `region`: los dos salen del servidor. Un cuerpo que los traiga se
// ignora sin avisar, por la misma razón que el `rol` de `POST /v1/access` — un error que los
// nombrara documentaría que alguna vez se aceptaron.
const bodySchema = z.object({
  correo: z.string().optional(),
  contrasena: z.string().optional(),
});

export type PlatformSignInRequest = {
  body: unknown;
  ip: string;
};

export class PlatformSignIn {
  constructor(
    private readonly credentials: PlatformCredentialPort,
    private readonly passwords: PasswordHasher,
    private readonly pause: AccessPausePort,
    private readonly tokens: PlatformTokens,
    private readonly clock: ClockPort,
    private readonly cfg: Config,
  ) {}

  async run(request: PlatformSignInRequest): Promise<PlatformSignInResponse> {
    const { email, password } = this.readBody(request.body);

    // --- 2 · la pausa. Los contadores son los de `rate_counter`, con el HMAC del correo y
    // nunca el correo, porque tienen que contar para un correo que no tiene fila.
    const before = await this.pause.peek(email, request.ip);
    if (before.paused) throw this.pausedError(before.pausedUntil);

    // --- 3 · el verificado, siempre. Real o señuelo, Argon2id en los dos casos y el mismo
    // coste: sin eso el «no existe» se mide con un cronómetro.
    const credential = await this.credentials.read(email);
    // SIN `who`, y no por el camino del señuelo: `who.accountRole` solo admite
    // `practitioner` o `paciente`, y una cuenta de consola no es ninguna de las dos.
    // Rellenarlo para que el tipo cuadre escribiría un actor FALSO en `service_failure`, que
    // es la tabla que existe para poder reconstruir quién hizo qué. Lo que se pierde: si un
    // `password_hash` de `platform_account` quedara ilegible, el aviso no dice de quién. Lo
    // que se gana: la bitácora no miente. El `access_audit` de `medskin_platform_attempt` sí
    // lleva el `id` y la `label`, que es donde esa información corresponde.
    const matched = await this.passwords.verify(credential.hash, password);

    // --- 4 · si no coincide, aquí termina. No se mira `status` ni nada más.
    if (!matched || credential.platformAccountId === null) {
      await this.credentials.recordAttempt(email, false);
      const after = await this.pause.recordFailure(email, request.ip);
      if (after.paused) throw this.pausedError(after.pausedUntil);
      throw this.mismatchError(after.attemptsLeft);
    }

    // --- 5 · solo si coincide. Esta respuesta confirma que el correo tiene cuenta, y solo
    // la ve quien ya demostró saber la contraseña.
    if (credential.status !== 'activa') {
      throw new ContractError('cuenta_suspendida', undefined, PLATFORM_SUSPENDED_MESSAGE);
    }

    await this.credentials.recordAttempt(email, true);
    await this.pause.clear(email, request.ip);

    // Una sola validación y un solo resultado: firmar con una lista y responder con otra
    // sería dibujar botones que el token no autoriza.
    const permisos = checkedPermissions(credential.permissions);

    const { token, expiresAt } = await this.tokens.sign({
      subject: credential.platformAccountId,
      label: credential.label ?? '',
      permissions: permisos,
    });

    return {
      token,
      caduca_en: expiresAt.toISOString(),
      etiqueta: credential.label ?? '',
      region: this.cfg.REGION,
      region_etiqueta: this.cfg.REGION_ETIQUETA,
      permisos,
    };
  }

  private readBody(input: unknown): { email: string; password: string } {
    const parsed = bodySchema.safeParse(input ?? {});
    const email = (parsed.success ? parsed.data.correo : undefined) ?? '';
    const password = (parsed.success ? parsed.data.contrasena : undefined) ?? '';
    if (email.trim() === '') throw new ContractError('correo_vacio');
    if (password === '') throw new ContractError('contrasena_vacia');
    // Se normaliza aquí y no en la base: la columna es `citext`, pero la clave del contador
    // es un HMAC de esta cadena y «A@b.com» y «a@b.com» tienen que contar en el mismo sitio.
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

  /** Idéntico al de la app: dos piezas, dos trabajos. Y un solo código para los dos casos. */
  private mismatchError(attemptsLeft: number): ContractError {
    const intentos = attemptsLeft === 1 ? '1 intento' : `${attemptsLeft} intentos`;
    return new ContractError('acceso_no_coincide', {
      campos: ['correo', 'contrasena'],
      intentos_restantes: attemptsLeft,
      pausa_minutos: PAUSE_MINUTES,
      aviso: `Te quedan ${intentos} antes de una pausa de ${PAUSE_MINUTES} minutos.`,
    });
  }
}

/**
 * «Un permiso de la fila que no esté en la lista cerrada no se firma: el endpoint responde
 * 500.» La fila está mal y hay que arreglarla, no servirla a medias — emitir un token que el
 * guardia va a rechazar entero sería fabricar el fallo que esa regla previene.
 *
 * Lanza un `Error` desnudo a propósito: lo recoge el filtro, que lo convierte en el
 * `500 fallo_de_servicio` con la frase de esta ruta y deja la causa real en
 * `service_failure`. Un `ContractError` aquí sería decirle a la consola algo que no puede
 * arreglar.
 */
function checkedPermissions(permissions: readonly string[] | null): readonly PlatformPermission[] {
  if (permissions === null || permissions.length === 0) {
    throw new Error('platform_account sin permisos: una fila que no dice qué puede hacer');
  }
  const known = new Set<string>(PLATFORM_PERMISSIONS);
  for (const permission of permissions) {
    if (!known.has(permission)) {
      throw new Error(`platform_account con permiso desconocido: ${permission}`);
    }
  }
  return permissions as readonly PlatformPermission[];
}
