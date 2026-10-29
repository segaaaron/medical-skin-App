// EL TOKEN DE PLATAFORMA · `plataforma-acceso.md`. La puerta de los cinco endpoints de
// consola, y la única frontera de autenticación del backend que NO acuña nada:
//
//   «La identidad de la plataforma vive fuera de la región. Cada backend de región no tiene
//   cuentas de plataforma: verifica un token firmado por el servicio de plataforma y actúa
//   según sus permisos.»
//
// De ahí las tres diferencias con `security/tokens.ts`, que es el de las sesiones:
//   1. Aquí solo se VERIFICA. No hay `sign()`: no existe `POST /v1/platform/access` y el
//      contrato lo dice en «Lo que este contrato no hace». El token llega ya firmado.
//   2. La llave es OTRA —la pública del servicio de plataforma, que pone el despliegue— y
//      por eso el `kid` también es otro. Un token de sesión no abre la consola y un token de
//      consola no abre la app: no comparten llave.
//   3. No hay `alcance` ni `practice`: lo que autoriza es la lista cerrada de `permisos`, y
//      el inquilino de cada petición sale de la RUTA.
//
// Sin NestJS, sin Fastify y sin Drizzle: esto se verifica igual desde una cola.

import { readFileSync } from 'node:fs';

import {
  decodeProtectedHeader,
  calculateJwkThumbprint,
  errors as joseErrors,
  exportJWK,
  importSPKI,
  jwtVerify,
  type CryptoKey,
  type JWTPayload,
} from 'jose';

import type { Config } from '../config/config';
import { ContractError } from '../contract/error-catalog';
import type { Region } from '../contract/session';
import { ensureEd25519Pair } from '../security/tokens';

/** `plataforma-acceso.md` · «`iss`: `medskin-plataforma`». Un `iss` distinto es un 401. */
export const PLATFORM_ISSUER = 'medskin-plataforma';

/** `plataforma-acceso.md` · «15 minutos. No hay refresco en la región». */
export const PLATFORM_TOKEN_LIFETIME_SECONDS = 15 * 60;

/**
 * «Los permisos, y son todos los que hay». Lista CERRADA: «un permiso que no está en esta
 * tabla no existe» y «un token que traiga una cadena desconocida en `permisos` se rechaza
 * entero: no se ignora el permiso raro y se atienden los demás».
 *
 * `plataforma:suplantar` está en la tabla del contrato y por eso es un permiso conocido —un
 * token que lo traiga es válido—, pero **no abre nada**: `POST /v1/session/suplantacion` está
 * en `propuesto` y no existe en `route-policy.ts`. Conocido no es implementado.
 */
export const PLATFORM_PERMISSIONS = [
  'plataforma:inquilinos:crear',
  'plataforma:inquilinos:leer',
  'plataforma:licencias:decidir',
  'plataforma:acceso:reenviar',
  'plataforma:pausa:levantar',
  'plataforma:suplantar',
] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

/**
 * La frase del `403 sin_permiso` de los endpoints de consola, literal de
 * `plataforma-acceso.md`: «Los mismos cinco en los seis endpoints». El `codigo` es el mismo
 * que el de la doctora y la frase es otra, que es el patrón ya establecido en el catálogo
 * (un `codigo`, dos frases).
 */
export const PLATFORM_FORBIDDEN_MESSAGE =
  'No tienes permiso para esto. Pídelo al administrador de la consola.';

/**
 * Quien llama desde la consola. NO es un `Caller`, y no por ahorro de campos:
 *
 * · No tiene `accountId` porque no tiene fila en `account` —la identidad vive fuera de la
 *   región—, así que tampoco tiene `accountRole` ni `sessionId`.
 * · No tiene `practiceId` porque un token de plataforma no es de ninguna consulta: cuando
 *   el endpoint lleva un inquilino, sale de la RUTA y se comprueba que existe.
 *
 * `subject` y `label` son el `sub` y la `etiqueta` del token, y son lo que viaja a la
 * auditoría: «la tabla no tiene clave foránea hacia esa persona —no vive en esta región— y
 * es deliberado». `subject` es un **uuid** (ver `UUID` abajo) y es el que se fija en
 * `medskin.account_id`; `label` es el nombre legible, y ese no entra en ninguna comparación.
 */
export type PlatformCaller = {
  via: 'plataforma';
  subject: string;
  label: string;
  region: Region;
  permissions: readonly PlatformPermission[];
};

const ALGORITHMS = ['EdDSA', 'Ed25519'] as const;
const REGIONS: readonly Region[] = ['eu', 'us', 'latam'];
const LABEL_MAX = 120;

/**
 * EL `sub` ES UN UUID, decisión del dueño del 28 de octubre de 2026.
 *
 * El `sub` es lo único del token que entra en la base: viaja a `medskin.account_id` —que la
 * política de `idempotency_key` compara—, a `license.reviewed_by` y a
 * `access_audit.actor_account_id`, y las tres son `uuid`. Fijar ese contexto **no crea
 * ninguna fila en `account`**: la persona de plataforma sigue sin vivir en esta región, y por
 * eso esas columnas no tienen clave foránea.
 *
 * Se descartó lo contrario —pasar las columnas a `text`— porque deja la columna de actor de
 * la bitácora polimórfica en tipo, cuando todos los demás actores son `uuid`, y obliga a
 * reescribir una política, que es lo más caro de cambiar en esta base. El servicio que firma
 * es nuestro: puede emitir el `sub` como uuid o traducirlo antes de firmar.
 *
 * Y se comprueba AQUÍ, en la puerta: un `sub` con otra forma es un token que esta región no
 * puede atender, y decirlo con un `401` es mejor que reventar en la primera llamada a la base
 * con un 500 que no explica nada.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PlatformTokens {
  /**
   * UNA LISTA DE LLAVES Y NO UNA, y es el arreglo de un hallazgo: con una sola, rotar la llave
   * del servicio de plataforma APAGABA LA CONSOLA. La llave nueva no puede publicarse aquí y
   * empezar a usarse allá en el mismo instante —son dos procesos y dos despliegues—, y los
   * tokens de quince minutos ya emitidos con la vieja se rechazaban todos: `kid` desconocido,
   * `401`, y nadie de soporte podía entrar hasta que los dos lados coincidieran.
   *
   * La primera de la lista es la del despliegue; las demás vienen de
   * `PLATFORM_JWT_PUBLIC_KEYS_EXTRA` y existen para la ventana de la rotación. Lo que NO
   * cambia es que aquí solo viven llaves PÚBLICAS: este proceso no puede firmar un token de
   * consola ni por error.
   */
  private constructor(
    private readonly keys: ReadonlyMap<string, CryptoKey>,
    private readonly region: Region,
  ) {}

  /**
   * La llave PÚBLICA del servicio de plataforma, del despliegue. La privada no existe en
   * esta región: este proceso no puede firmar un token de consola ni por error.
   *
   * En `development` sí se genera un par local —y solo si la configuración nombra dónde—
   * porque el servicio que firma no corre en la máquina de nadie y sin eso no hay forma de
   * acuñar un token a mano para probar la consola. Fuera de `development` no se genera
   * nada, igual que las llaves de la sesión (OWASP A02).
   */
  static async fromFiles(cfg: Config): Promise<PlatformTokens> {
    if (cfg.NODE_ENV === 'development' && cfg.PLATFORM_JWT_PRIVATE_KEY_PATH !== undefined) {
      await ensureEd25519Pair(
        cfg.PLATFORM_JWT_PRIVATE_KEY_PATH,
        cfg.PLATFORM_JWT_PUBLIC_KEY_PATH,
        cfg.NODE_ENV,
      );
    }

    // La del despliegue primero, y después las de la ventana de rotación. Una ruta repetida o
    // vacía se ignora: la lista es configuración y una coma de más no es un motivo para que
    // la API no arranque.
    const paths = [
      cfg.PLATFORM_JWT_PUBLIC_KEY_PATH,
      ...(cfg.PLATFORM_JWT_PUBLIC_KEYS_EXTRA ?? '')
        .split(',')
        .map((path) => path.trim())
        .filter((path) => path !== ''),
    ];

    const keys = new Map<string, CryptoKey>();
    for (const path of paths) {
      const publicKey = await importSPKI(readFileSync(path, 'utf8'), 'Ed25519');
      // El `kid` es la huella de la llave pública, igual que en las sesiones: con rotación
      // cada 90 días el verificador sabe cuál es la suya sin que nadie mantenga un número a
      // mano.
      const kid = await calculateJwkThumbprint(await exportJWK(publicKey));
      if (!keys.has(kid)) keys.set(kid, publicKey);
    }
    return new PlatformTokens(keys, cfg.REGION);
  }

  /**
   * Denegar por defecto, y cada negativa con su código del contrato:
   *
   * · firma mala, `kid` desconocido, `iss` ajeno, cadena rota o reclamación que falta
   *   → `401 token_de_plataforma_no_valido`
   * · `exp` pasado → `401 token_de_plataforma_caducado` (la consola pide otro y repite)
   * · `aud` de otra región → `403 region_no_corresponde`
   *
   * `aud` se comprueba AQUÍ y no con la opción de `jose` a propósito: `jose` no distingue
   * una audiencia que no cuadra de una firma mala, y el contrato necesita dos respuestas
   * distintas porque la consola hace dos cosas distintas con ellas.
   */
  async verify(token: string): Promise<PlatformCaller> {
    try {
      // EL `kid` ELIGE LA LLAVE, y un `kid` que no está es un token que esta región no puede
      // atender. Se mira ANTES de verificar la firma para no verificar contra una llave que no
      // es la del token: `jose` devolvería «firma mala» y el motivo real se perdería.
      const { kid } = decodeProtectedHeader(token);
      const key = kid === undefined ? undefined : this.keys.get(kid);
      if (key === undefined) throw new ContractError('token_de_plataforma_no_valido');

      const { payload } = await jwtVerify(token, key, {
        algorithms: [...ALGORITHMS],
        issuer: PLATFORM_ISSUER,
        // `iat` y `exp` obligatorios, y `maxTokenAge` los 15 minutos del contrato: un token
        // que el servicio de plataforma firmara con un `exp` largo por error no vale más de
        // su vida escrita. El plazo es del contrato, no de quien firma. `jose` lo reporta
        // como `JWTExpired`, así que sale por `token_de_plataforma_caducado`: caducado es lo
        // que es, y la consola lo resuelve pidiendo otro token en vez de expulsar a nadie.
        requiredClaims: ['iat', 'exp', 'sub'],
        maxTokenAge: PLATFORM_TOKEN_LIFETIME_SECONDS,
      });

      return this.read(payload);
    } catch (failure) {
      if (failure instanceof ContractError) throw failure;
      if (failure instanceof joseErrors.JWTExpired) {
        throw new ContractError('token_de_plataforma_caducado');
      }
      throw new ContractError('token_de_plataforma_no_valido');
    }
  }

  private read(payload: JWTPayload): PlatformCaller {
    const { sub, aud, etiqueta, permisos } = payload as JWTPayload & {
      etiqueta?: unknown;
      permisos?: unknown;
    };

    if (
      typeof sub !== 'string' ||
      !UUID.test(sub) ||
      typeof etiqueta !== 'string' ||
      etiqueta.trim() === '' ||
      etiqueta.length > LABEL_MAX ||
      !Array.isArray(permisos)
    ) {
      throw new ContractError('token_de_plataforma_no_valido');
    }

    return {
      via: 'plataforma',
      subject: sub,
      label: etiqueta,
      region: this.checkedRegion(aud),
      permissions: checkedPermissions(permisos),
    };
  }

  /**
   * «Un token emitido para `latam` no vale en `eu`». La frase dice a qué región ir, y eso es
   * correcto aquí: quien la lee es una persona de MedSkin en una pantalla interna. La región
   * se interpola desde el token DESPUÉS de comprobarla contra la lista cerrada de tres, así
   * que lo que entra en la frase no es texto del cliente.
   */
  private checkedRegion(aud: JWTPayload['aud']): Region {
    const region = REGIONS.find((known) => known === aud);
    if (region === undefined) throw new ContractError('token_de_plataforma_no_valido');
    if (region !== this.region) {
      throw new ContractError(
        'region_no_corresponde',
        { region },
        `Ese token es de otra región. Abre la consola de ${region}.`,
      );
    }
    return region;
  }
}

/** Una cadena desconocida rechaza el token ENTERO: es un token de otra versión del sistema. */
function checkedPermissions(permisos: readonly unknown[]): readonly PlatformPermission[] {
  const known = new Set<string>(PLATFORM_PERMISSIONS);
  for (const permiso of permisos) {
    if (typeof permiso !== 'string' || !known.has(permiso)) {
      throw new ContractError('token_de_plataforma_no_valido');
    }
  }
  return permisos as readonly PlatformPermission[];
}
