// El token · `sesion.md` · «La forma del token»: JWT firmado con EdDSA (Ed25519), con
// `kid`, 15 minutos de vida. El refresco NO es un JWT: es una cadena opaca y lo que se
// guarda es su resumen.
//
// Por qué 15 minutos y no una hora: «revocar una sesión desde sesiones activas revoca su
// refresco en el acto; el token de acceso que ya esté emitido muere en 15 min como máximo,
// y es el motivo de que vivan 15 min».

import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  calculateJwkThumbprint,
  errors as joseErrors,
  exportJWK,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JWTPayload,
} from 'jose';

import { config, type Config } from '../config/config';
import { ContractError } from '../contract/error-catalog';
import type { Scope } from '../contract/session';
import type { Claims, RecoveryClaims, Region, Role } from '../contract/session';

const ALGORITHM = 'Ed25519';
export const TOKEN_LIFETIME_SECONDS = 15 * 60;

/**
 * `recuperacion.md`: el token de alcance `recuperacion` «vive 5 minutos». Es el único del
 * tramo que no vive 15: no acompaña a una sesión, solo autoriza una pantalla.
 */
export const RECOVERY_TOKEN_LIFETIME_SECONDS = 5 * 60;

/**
 * Lo que sale de `verify()`. `sid`, `rol` y `practice` son OPCIONALES porque el token de
 * recuperación no los lleva (`RecoveryClaims`), y quien llama decide qué exige: el guardia
 * los pide para todo alcance que no sea `recuperacion`, y los prohíbe para ese.
 */
export type VerifiedClaims = {
  sub: string;
  alcance: Scope;
  region: Region;
  permisos: readonly string[];
  iat: number;
  exp: number;
  sid?: string;
  rol?: Role;
  practice?: string;
};

/**
 * Genera el par de desarrollo si no existe. Solo en `development`: en producción las
 * llaves las pone el despliegue, y un proceso que se las inventa al arrancar firmaría
 * tokens que nadie más puede verificar (OWASP A02).
 */
export async function ensureKeyPair(cfg: Config = config()): Promise<void> {
  await ensureEd25519Pair(cfg.JWT_PRIVATE_KEY_PATH, cfg.JWT_PUBLIC_KEY_PATH, cfg.NODE_ENV);
}

/**
 * El par de desarrollo, por rutas. Lo usan DOS pares con la misma regla y distinta llave: el
 * de las sesiones y el del servicio de plataforma (`platform/platform-token.ts`), que en
 * desarrollo tampoco existe porque el servicio que firma vive fuera de la región.
 */
export async function ensureEd25519Pair(
  privateKeyPath: string,
  publicKeyPath: string,
  nodeEnv: Config['NODE_ENV'],
): Promise<void> {
  if (existsSync(privateKeyPath) && existsSync(publicKeyPath)) return;
  if (nodeEnv !== 'development') {
    throw new Error(
      `Faltan las llaves del token (${privateKeyPath}, ${publicKeyPath}) y fuera de development no se generan.`,
    );
  }

  const { privateKey, publicKey } = await generateKeyPair(ALGORITHM, { extractable: true });
  mkdirSync(dirname(privateKeyPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(publicKeyPath), { recursive: true, mode: 0o700 });
  writeFileSync(privateKeyPath, await exportPKCS8(privateKey), { mode: 0o600 });
  writeFileSync(publicKeyPath, await exportSPKI(publicKey), { mode: 0o644 });
  chmodSync(privateKeyPath, 0o600);
}

export class Tokens {
  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly publicKey: CryptoKey,
    private readonly kid: string,
    private readonly hmacKey: Buffer,
  ) {}

  static async fromFiles(cfg: Config = config()): Promise<Tokens> {
    await ensureKeyPair(cfg);
    const privateKey = await importPKCS8(readFileSync(cfg.JWT_PRIVATE_KEY_PATH, 'utf8'), ALGORITHM);
    const publicKey = await importSPKI(readFileSync(cfg.JWT_PUBLIC_KEY_PATH, 'utf8'), ALGORITHM);
    // El `kid` es la huella de la llave pública: con rotación cada 90 días, el verificador
    // sabe cuál usar sin que nadie tenga que mantener un número a mano.
    const kid = await calculateJwkThumbprint(await exportJWK(publicKey));
    return new Tokens(privateKey, publicKey, kid, Buffer.from(cfg.SERVICE_HMAC_KEY, 'utf8'));
  }

  async sign(claims: Claims): Promise<{ token: string; expiresAt: Date }> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + TOKEN_LIFETIME_SECONDS;
    const token = await new SignJWT({
      sid: claims.sid,
      rol: claims.rol,
      alcance: claims.alcance,
      region: claims.region,
      ...(claims.practice ? { practice: claims.practice } : {}),
      permisos: claims.permisos,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.kid })
      .setSubject(claims.sub)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.privateKey);
    return { token, expiresAt: new Date(expiresAt * 1000) };
  }

  /**
   * El token de recuperación: `sub`, `alcance` y `region`, y NADA MÁS. Sin `rol`, sin
   * `sid`, sin `practice` y con `permisos` vacío — ver `RecoveryClaims`. Firmarlo aparte y
   * no con un `sign()` de reclamaciones parciales es lo que hace imposible colarle un rol
   * por descuido: la firma no tiene por dónde recibirlo.
   */
  async signRecovery(claims: RecoveryClaims): Promise<{ token: string; expiresAt: Date }> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + RECOVERY_TOKEN_LIFETIME_SECONDS;
    const token = await new SignJWT({ alcance: claims.alcance, region: claims.region, permisos: [] })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.kid })
      .setSubject(claims.sub)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.privateKey);
    return { token, expiresAt: new Date(expiresAt * 1000) };
  }

  /**
   * Verifica la firma primero y las reclamaciones después, que es el orden de `jose`. De
   * ahí sale una distinción que los contratos necesitan: cuando el token está CADUCADO la
   * firma ya se comprobó, así que su contenido es auténtico y se puede usar para elegir
   * entre `401 token_caducado` y el `410 plazo_vencido` de los alcances restringidos.
   */
  async verify(token: string): Promise<VerifiedClaims> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, { algorithms: ['EdDSA'] });
      return this.read(payload);
    } catch (failure) {
      if (failure instanceof ContractError) throw failure;
      if (failure instanceof joseErrors.JWTExpired) {
        const expired = this.read(failure.payload);
        // Un alcance restringido tiene su propio plazo y su propia frase: «Se pasó el
        // tiempo. Vuelve a entrar con la contraseña que te mandamos.» Los dos plazos son
        // los mismos 15 minutos a propósito: el token ES el plazo.
        if (expired.alcance === 'contrasena_temporal' || expired.alcance === 'recuperacion') {
          throw new ContractError('plazo_vencido');
        }
        throw new ContractError('token_caducado');
      }
      // Firma mala, `kid` desconocido, cadena rota, algoritmo que no es EdDSA.
      throw new ContractError('token_no_valido');
    }
  }

  /**
   * El refresco: cadena opaca de 32 bytes y su resumen DETERMINISTA. Determinista y no
   * Argon2id porque hay un índice único sobre la columna, y un hash con sal nueva en cada
   * cálculo no se podría buscar. HMAC con la llave del servicio y no un hash desnudo: lo
   * que se guarda no sirve sin la llave, que no está en la base.
   */
  mintRefresh(): { refresh: string; digest: string } {
    const refresh = `rfr_${randomBytes(32).toString('base64url')}`;
    return { refresh, digest: this.digestRefresh(refresh) };
  }

  digestRefresh(refresh: string): string {
    return createHmac('sha256', this.hmacKey).update(refresh).digest('hex');
  }

  private read(payload: JWTPayload): VerifiedClaims {
    const { sub, sid, rol, alcance, region, practice, permisos, iat, exp } = payload as JWTPayload &
      Partial<Claims>;

    // Lo que TODO token lleva. `sid` y `rol` no están aquí: el de recuperación no los
    // trae, y es el guardia el que decide qué exige por alcance.
    if (
      typeof sub !== 'string' ||
      typeof alcance !== 'string' ||
      typeof region !== 'string' ||
      typeof iat !== 'number' ||
      typeof exp !== 'number' ||
      !Array.isArray(permisos)
    ) {
      throw new ContractError('token_no_valido');
    }

    return {
      sub,
      alcance,
      region,
      ...(typeof sid === 'string' ? { sid } : {}),
      ...(typeof rol === 'string' ? { rol } : {}),
      ...(typeof practice === 'string' ? { practice } : {}),
      permisos: permisos.filter((p): p is string => typeof p === 'string'),
      iat,
      exp,
    };
  }
}
