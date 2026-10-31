// EL TOKEN DE PLATAFORMA · `plataforma-acceso.md`. La puerta de los cinco endpoints de
// consola.
//
// ESTE ARCHIVO FIRMABA NADA Y AHORA FIRMA, decidido el 30 de octubre de 2026
// (`plataforma-acceso.md` · «La entrada de la consola»). La cabecera anterior decía que era
// «la única frontera de autenticación del backend que NO acuña nada», y dejó de ser verdad:
// un comentario que explica una propiedad que el archivo ya no tiene es peor que ninguno.
//
// Lo que lo obligó: el servicio de identidad de plataforma no existe y no tiene fecha. Sin
// alguien que firme, los cinco endpoints de consola son inalcanzables y no hay forma de dar
// de alta la primera consulta. Así que la identidad de plataforma pasa a vivir DENTRO de la
// región, contra la tabla `platform_account` (migración 0068).
//
// Lo que acota esa concesión, y está medido en el contrato:
//   · La privada solo se carga si `PLATFORM_JWT_PRIVATE_KEY_PATH` está puesta. Un despliegue
//     que no quiere firmar no firma, y `sign()` lanza en vez de inventarse una llave.
//   · El `aud` que se firma es SIEMPRE `cfg.REGION`, nunca nada que venga del cuerpo. Un
//     despliegue no puede emitirse permisos sobre otra región.
//   · Los permisos se validan contra `PLATFORM_PERMISSIONS` antes de firmar: emitir un token
//     que el verificador va a rechazar entero sería fabricar el fallo que esa regla previene.
//
// De ahí las dos diferencias que quedan con `security/tokens.ts`, que es el de las sesiones:
//   1. La llave es OTRA —el par de plataforma del despliegue— y por eso el `kid` también es
//      otro. Un token de sesión no abre la consola y un token de consola no abre la app: no
//      comparten llave.
//   2. No hay `alcance` ni `practice`: lo que autoriza es la lista cerrada de `permisos`, y
//      la consulta de cada petición sale de la RUTA.
//
// Sin NestJS, sin Fastify y sin Drizzle: esto se verifica igual desde una cola.

import { readFileSync } from 'node:fs';

import {
  decodeProtectedHeader,
  calculateJwkThumbprint,
  errors as joseErrors,
  exportJWK,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
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
  'plataforma:consultas:crear',
  'plataforma:consultas:leer',
  // Aquí estaba `plataforma:licencias:decidir`, y se fue con la revisión manual el 30 de
  // octubre de 2026: MedSkin no verifica licencias, así que no hay decisión que autorizar.
  // Se BORRA de la lista en vez de quedarse sin ruta que lo pida, porque esta lista es
  // cerrada y lo que no está aquí no se puede firmar: un permiso concedido que nadie usa es
  // el que alguien reutiliza en seis meses sin leer para qué era.
  'plataforma:acceso:reenviar',
  'plataforma:pausa:levantar',
  // `GET /v1/platform/accounts?correo=`, nuevo el 31 de octubre de 2026. PROPIO y no
  // `plataforma:consultas:leer`: quien mira el padrón responde «qué consultas hay», y esto
  // responde «esta persona tiene cuenta en MedSkin» — otro oráculo y sobre otra clase de
  // sujeto, porque una cuenta puede ser de una paciente. Reusar el de consultas habría
  // concedido la segunda pregunta a todo el que tenía la primera sin que nadie lo decidiera.
  'plataforma:cuentas:buscar',
  // Los tres de pacientes, decididos por el dueño el 31 de octubre de 2026. SEPARADOS y no
  // uno solo, y esa separación es la única razón por la que puede existir una cuenta de
  // soporte que administra y NO lee expedientes. Con un permiso único, «quien reenvía un
  // acceso puede leer alergias» sería verdad para siempre y nadie lo habría decidido.
  'plataforma:pacientes:leer',
  'plataforma:pacientes:crear',
  // El más caro de los tres, y por eso es propio: abre la historia clínica y NADA MÁS.
  'plataforma:historia:leer',
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
 *   el endpoint lleva una consulta, sale de la RUTA y se comprueba que existe.
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
   * `PLATFORM_JWT_PUBLIC_KEYS_EXTRA` y existen para la ventana de la rotación.
   *
   * `signing` es el par con el que se FIRMA, y es opcional: `undefined` cuando el despliegue
   * no pone `PLATFORM_JWT_PRIVATE_KEY_PATH`. Su `kid` es la huella de la pública del
   * despliegue —la primera de `keys`—, así que lo que este proceso firma lo verifica este
   * mismo proceso por construcción, sin que nadie mantenga un número a mano.
   */
  private constructor(
    private readonly keys: ReadonlyMap<string, CryptoKey>,
    private readonly region: Region,
    private readonly signing: { readonly key: CryptoKey; readonly kid: string } | undefined,
  ) {}

  /**
   * Las llaves del despliegue: la PÚBLICA siempre —con la que se verifica—, y la PRIVADA
   * solo si la configuración la nombra. Esa condición es la que decide si este despliegue
   * puede emitir tokens de consola o únicamente aceptarlos.
   *
   * En `development` se genera el par si falta, porque sin él no hay forma de probar la
   * consola en la máquina de nadie. Fuera de `development` no se genera nada: si la ruta
   * está puesta y el archivo no existe, el arranque falla en vez de inventarse una llave
   * (OWASP A02).
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

    // El `kid` de la firma es el de la PRIMERA pública, que es la del despliegue. Tomarlo de
    // ahí y no recalcularlo desde la privada es lo que garantiza que `verify()` encuentre la
    // llave: las dos miran el mismo mapa.
    const signingKid = [...keys.keys()][0];
    const signing =
      cfg.PLATFORM_JWT_PRIVATE_KEY_PATH !== undefined && signingKid !== undefined
        ? {
            key: await importPKCS8(readFileSync(cfg.PLATFORM_JWT_PRIVATE_KEY_PATH, 'utf8'), 'Ed25519'),
            kid: signingKid,
          }
        : undefined;

    return new PlatformTokens(keys, cfg.REGION, signing);
  }

  /**
   * ACUÑA EL TOKEN DE CONSOLA · `POST /v1/platform/access`.
   *
   * Lo que NO sale de aquí y por eso no se puede falsear desde el cuerpo de una petición:
   * el `aud`, que es siempre la región del despliegue, y el `exp`, que es la constante del
   * contrato. Lo único que entra son los tres campos de la fila de `platform_account`.
   *
   * Y se valida antes de firmar, porque lo contrario es fabricar el fallo que la regla de la
   * lista cerrada previene: un `permisos` con una cadena desconocida hace que `verify()`
   * rechace el token ENTERO, así que emitirlo sería entregarle a la consola una credencial
   * que no vale, con un 200. Lo mismo el `sub` y la `etiqueta`: lo que esta función emite
   * tiene que pasar por `read()`, y esa es la prueba bloqueante de la fase.
   */
  async sign(caller: {
    subject: string;
    label: string;
    permissions: readonly PlatformPermission[];
  }): Promise<{ token: string; expiresAt: Date }> {
    if (this.signing === undefined) {
      throw new Error(
        'este despliegue no firma tokens de consola: falta PLATFORM_JWT_PRIVATE_KEY_PATH',
      );
    }
    if (!UUID.test(caller.subject)) {
      throw new Error('platform sign: el sub tiene que ser un uuid');
    }
    const label = caller.label.trim();
    if (label === '' || label.length > LABEL_MAX) {
      throw new Error('platform sign: etiqueta vacia o demasiado larga');
    }
    const known = new Set<string>(PLATFORM_PERMISSIONS);
    for (const permission of caller.permissions) {
      if (!known.has(permission)) {
        throw new Error(`platform sign: permiso desconocido ${permission}`);
      }
    }
    if (caller.permissions.length === 0) {
      throw new Error('platform sign: una cuenta sin permisos no puede entrar');
    }

    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + PLATFORM_TOKEN_LIFETIME_SECONDS;
    const token = await new SignJWT({ etiqueta: label, permisos: [...caller.permissions] })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.signing.kid })
      .setIssuer(PLATFORM_ISSUER)
      .setAudience(this.region)
      .setSubject(caller.subject)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.signing.key);
    return { token, expiresAt: new Date(expiresAt * 1000) };
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
