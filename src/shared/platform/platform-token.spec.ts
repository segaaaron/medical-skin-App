// LA PUERTA DE LA CONSOLA. Esta es la frontera de autenticación del backend que no acuña
// nada: lo único que hace es decir no, así que lo que hay que probar es cada no.
//
// Las dos que importan y que el dueño pidió por nombre:
//   · un token que NO está firmado por la llave del servicio de plataforma no pasa, aunque
//     traiga todas las reclamaciones perfectas y el `kid` de la buena;
//   · un permiso que la ruta pide y el token no trae no pasa, y sale `403 sin_permiso` con
//     la frase de la consola.
//
// El guardia se prueba aquí y no en `scope.guard.spec.ts` porque quien tiene la llave privada
// con la que se acuñan estos tokens es este archivo: el servicio que firma de verdad vive
// fuera de la región.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  type CryptoKey,
} from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig, type Config } from '../config/config';
import { ContractError } from '../contract/error-catalog';
import type { RequestWithContext } from '../http/request-context';
import { ScopeGuard } from '../http/scope.guard';
import { Tokens } from '../security/tokens';
import {
  PLATFORM_ISSUER,
  PLATFORM_PERMISSIONS,
  PlatformTokens,
  type PlatformPermission,
} from './platform-token';

const carpeta = mkdtempSync(join(tmpdir(), 'medskin-plataforma-'));
const PRIVADA = join(carpeta, 'plataforma.key');
const PUBLICA = join(carpeta, 'plataforma.pub');

/**
 * Configuración de desarrollo con las llaves en una carpeta temporal: `fromFiles()` genera
 * el par de plataforma la primera vez, y de la privada sale el token que firmaríamos si
 * fuéramos el servicio de plataforma. La región del despliegue es `latam`.
 */
const cfg: Config = loadConfig({
  ...process.env,
  NODE_ENV: 'development',
  REGION: 'latam',
  JWT_PRIVATE_KEY_PATH: join(carpeta, 'jwt.key'),
  JWT_PUBLIC_KEY_PATH: join(carpeta, 'jwt.pub'),
  PLATFORM_JWT_PRIVATE_KEY_PATH: PRIVADA,
  PLATFORM_JWT_PUBLIC_KEY_PATH: PUBLICA,
});

// El `sub` es un UUID (decisión del 28 de octubre): es lo que se fija en `medskin.account_id`
// y lo que viaja a `license.reviewed_by` y a `access_audit.actor_account_id`, que son `uuid`.
const SUB = '44444444-4444-4444-8444-444444444444';
const ETIQUETA = 'Andrea del equipo de soporte';

let plataforma: PlatformTokens;
let llavePrivada: CryptoKey;
let kid: string;
let guardia: ScopeGuard;

beforeAll(async () => {
  // `fromFiles()` genera el par de desarrollo la primera vez: de ahí sale la privada con la
  // que este archivo hace de servicio de plataforma, y el `kid` que el verificador espera,
  // que es la huella de su pública.
  plataforma = await PlatformTokens.fromFiles(cfg);
  llavePrivada = await importPKCS8(readFileSync(PRIVADA, 'utf8'), 'Ed25519');
  kid = await calculateJwkThumbprint(
    await exportJWK(await importSPKI(readFileSync(PUBLICA, 'utf8'), 'Ed25519')),
  );
  guardia = new ScopeGuard(await Tokens.fromFiles(cfg), plataforma);
});

afterAll(() => rmSync(carpeta, { recursive: true, force: true }));

type Partes = {
  kid?: string;
  clave?: CryptoKey;
  iss?: string;
  aud?: string;
  sub?: string;
  etiqueta?: unknown;
  permisos?: unknown;
  /** Segundos que se le suman al `exp`. Negativo: caducado. */
  vida?: number;
  /** Segundos que se le restan al `iat`. */
  edad?: number;
};

async function acunar(partes: Partes = {}): Promise<string> {
  const ahora = Math.floor(Date.now() / 1000);
  const emitido = ahora - (partes.edad ?? 0);
  return new SignJWT({
    etiqueta: 'etiqueta' in partes ? partes.etiqueta : ETIQUETA,
    permisos: 'permisos' in partes ? partes.permisos : [...PLATFORM_PERMISSIONS],
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: partes.kid ?? kid })
    .setIssuer(partes.iss ?? PLATFORM_ISSUER)
    .setAudience(partes.aud ?? 'latam')
    .setSubject(partes.sub ?? SUB)
    .setIssuedAt(emitido)
    .setExpirationTime(ahora + (partes.vida ?? 15 * 60))
    .sign(partes.clave ?? llavePrivada);
}

async function rechazo(token: string): Promise<ContractError> {
  try {
    await plataforma.verify(token);
  } catch (fallo) {
    if (fallo instanceof ContractError) return fallo;
    throw fallo;
  }
  throw new Error('el token pasó la verificación y tenía que ser rechazado');
}

describe('PlatformTokens · lo que pasa', () => {
  it('un token del servicio de plataforma deja `sub`, `etiqueta` y sus permisos', async () => {
    const quien = await plataforma.verify(await acunar());
    expect(quien).toEqual({
      via: 'plataforma',
      subject: SUB,
      label: ETIQUETA,
      region: 'latam',
      permissions: [...PLATFORM_PERMISSIONS],
    });
  });

  it('un token sin permisos es válido y no abre nada', async () => {
    const quien = await plataforma.verify(await acunar({ permisos: [] }));
    expect(quien.permissions).toEqual([]);
  });
});

describe('PlatformTokens · la firma y el `kid`', () => {
  it('OTRA LLAVE NO PASA, aunque el `kid` y las reclamaciones sean las buenas', async () => {
    // El caso que justifica que este archivo exista: cualquiera puede acuñar un JWT con
    // `iss: medskin-plataforma`, el `kid` correcto y los cinco permisos. Lo que no puede es
    // firmarlo con una llave que esta región acepte.
    const ajena = await generateKeyPair('Ed25519', { extractable: true });
    const error = await rechazo(await acunar({ clave: ajena.privateKey }));
    expect(error.code).toBe('token_de_plataforma_no_valido');
    expect(error.status).toBe(401);
    expect(error.userMessage).toBe('Tu sesión de consola no es válida. Vuelve a entrar.');
  });

  it('un `kid` desconocido no pasa ni con la firma buena', async () => {
    const error = await rechazo(await acunar({ kid: 'el-kid-del-ano-que-viene' }));
    expect(error.code).toBe('token_de_plataforma_no_valido');
  });

  it('el token de SESIÓN de esta misma API no abre la consola: es otra llave', async () => {
    const sesion = await Tokens.fromFiles(cfg);
    const { token } = await sesion.sign({
      sub: '11111111-1111-4111-8111-111111111111',
      sid: '33333333-3333-4333-8333-333333333333',
      rol: 'doctora',
      alcance: 'completo',
      region: 'latam',
      practice: '22222222-2222-4222-8222-222222222222',
      permisos: [],
    });
    expect((await rechazo(token)).code).toBe('token_de_plataforma_no_valido');
  });

  it('una cadena que no es un JWT no pasa', async () => {
    expect((await rechazo('no-es-un-token')).code).toBe('token_de_plataforma_no_valido');
  });
});

describe('PlatformTokens · las reclamaciones', () => {
  it('`iss` que no es el servicio de plataforma: 401', async () => {
    expect((await rechazo(await acunar({ iss: 'medskin-api' }))).code).toBe(
      'token_de_plataforma_no_valido',
    );
  });

  it('`exp` pasado: 401 token_de_plataforma_caducado, y sin frase', async () => {
    const error = await rechazo(await acunar({ vida: -30 }));
    expect(error.code).toBe('token_de_plataforma_caducado');
    expect(error.status).toBe(401);
    // «Nada. La consola pide otro token y repite la petición.»
    expect(error.userMessage).toBe('');
  });

  it('un token más viejo que los 15 minutos del contrato no pasa aunque su `exp` sea largo', async () => {
    // El plazo es del contrato, no de quien firma: un `exp` de un año no compra una vida de
    // un año. 16 minutos de antigüedad y `exp` dentro de una hora, y sale CADUCADO —que es
    // lo que es— así que la consola pide otro token y repite, sin sacar a nadie de la
    // pantalla por un error de quien firma.
    const error = await rechazo(await acunar({ edad: 16 * 60, vida: 60 * 60 }));
    expect(error.code).toBe('token_de_plataforma_caducado');
  });

  it('`aud` de otra región: 403 region_no_corresponde, y dice a cuál ir', async () => {
    const error = await rechazo(await acunar({ aud: 'eu' }));
    expect(error.code).toBe('region_no_corresponde');
    expect(error.status).toBe(403);
    expect(error.userMessage).toBe('Ese token es de otra región. Abre la consola de eu.');
    expect(error.body().error.datos).toEqual({ region: 'eu' });
  });

  it('`aud` que no es ninguna de las tres regiones: 401, no 403', async () => {
    // Una audiencia inventada no es «otra región»: es una reclamación que no cuadra con nada,
    // y mandarla al 403 pondría texto del token en una frase.
    expect((await rechazo(await acunar({ aud: 'bo-1' }))).code).toBe(
      'token_de_plataforma_no_valido',
    );
  });

  it('UN `sub` QUE NO ES UN UUID NO PASA: no llega a la base a reventar', async () => {
    // El `sub` es lo único del token que entra en la base —`medskin.account_id`,
    // `license.reviewed_by`, `access_audit.actor_account_id`, las tres `uuid`—, así que la
    // forma se comprueba en la puerta. Un `usr_plt_…` es un token de otra versión del
    // sistema, no una petición que esta región pueda atender.
    expect((await rechazo(await acunar({ sub: 'usr_plt_01HQZZ8K3M4N5P6Q7R8S9T0V' }))).code).toBe(
      'token_de_plataforma_no_valido',
    );
    expect((await rechazo(await acunar({ sub: '' }))).code).toBe('token_de_plataforma_no_valido');
    // Un uuid con basura pegada tampoco: el patrón está anclado por los dos lados.
    expect((await rechazo(await acunar({ sub: `${SUB} ` }))).code).toBe(
      'token_de_plataforma_no_valido',
    );
  });

  it('sin `etiqueta` no pasa: la auditoría la necesita y no se inventa', async () => {
    expect((await rechazo(await acunar({ etiqueta: undefined }))).code).toBe(
      'token_de_plataforma_no_valido',
    );
    expect((await rechazo(await acunar({ etiqueta: '   ' }))).code).toBe(
      'token_de_plataforma_no_valido',
    );
  });

  it('UN PERMISO DESCONOCIDO RECHAZA EL TOKEN ENTERO, no solo ese permiso', async () => {
    // `plataforma-acceso.md`: «no se ignora el permiso raro y se atienden los demás, porque
    // un token con permisos que este backend no entiende es un token de otra versión del
    // sistema».
    const error = await rechazo(
      await acunar({ permisos: ['plataforma:inquilinos:leer', 'plataforma:todo'] }),
    );
    expect(error.code).toBe('token_de_plataforma_no_valido');
  });

  it('`permisos` que no es una lista, o con algo que no es cadena: 401', async () => {
    expect((await rechazo(await acunar({ permisos: 'plataforma:inquilinos:leer' }))).code).toBe(
      'token_de_plataforma_no_valido',
    );
    expect((await rechazo(await acunar({ permisos: [7] }))).code).toBe(
      'token_de_plataforma_no_valido',
    );
  });
});

// ---------------------------------------------------------------------------------------
// El guardia sobre las rutas de consola: el permiso de la RUTA contra el del TOKEN.
// ---------------------------------------------------------------------------------------

function peticion(metodo: string, ruta: string, autorizacion?: string): RequestWithContext {
  return {
    method: metodo,
    url: ruta,
    ip: '201.131.0.9',
    headers: autorizacion === undefined ? {} : { authorization: autorizacion },
    routeOptions: { url: ruta },
  } as unknown as RequestWithContext;
}

function contexto(req: RequestWithContext) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as Parameters<ScopeGuard['canActivate']>[0];
}

async function denegar(
  metodo: string,
  ruta: string,
  autorizacion?: string,
): Promise<ContractError> {
  try {
    await guardia.canActivate(contexto(peticion(metodo, ruta, autorizacion)));
  } catch (fallo) {
    if (fallo instanceof ContractError) return fallo;
    throw fallo;
  }
  throw new Error('el guardia dejó pasar la petición y tenía que denegarla');
}

const CONSOLA: Readonly<Record<string, PlatformPermission>> = {
  'POST /v1/plataforma/inquilinos': 'plataforma:inquilinos:crear',
  'GET /v1/plataforma/inquilinos/:id': 'plataforma:inquilinos:leer',
  'POST /v1/plataforma/inquilinos/:id/licencia/decision': 'plataforma:licencias:decidir',
  'POST /v1/plataforma/cuentas/:cuenta_id/acceso/reenviar': 'plataforma:acceso:reenviar',
  'DELETE /v1/plataforma/cuentas/:cuenta_id/pausa': 'plataforma:pausa:levantar',
};

describe('ScopeGuard · las cinco rutas de la consola', () => {
  it('cada ruta abre con SU permiso y deja `platform`, sin `caller` ni `recovery`', async () => {
    for (const [clave, permiso] of Object.entries(CONSOLA)) {
      const [metodo, ruta] = clave.split(' ') as [string, string];
      const req = peticion(metodo, ruta, `Bearer ${await acunar({ permisos: [permiso] })}`);

      expect(await guardia.canActivate(contexto(req)), clave).toBe(true);
      expect(req.medskin?.platform?.subject, clave).toBe(SUB);
      expect(req.medskin?.platform?.label, clave).toBe(ETIQUETA);
      expect(req.medskin?.caller, clave).toBeNull();
      expect(req.medskin?.recovery, clave).toBeNull();
    }
  });

  it('EL PERMISO QUE LA RUTA PIDE Y EL TOKEN NO TRAE: 403 sin_permiso', async () => {
    for (const [clave, permiso] of Object.entries(CONSOLA)) {
      const [metodo, ruta] = clave.split(' ') as [string, string];
      // Todos los permisos menos el que esta ruta pide: ni la suma de los otros cuatro abre.
      const otros = PLATFORM_PERMISSIONS.filter((p) => p !== permiso);
      const error = await denegar(metodo, ruta, `Bearer ${await acunar({ permisos: otros })}`);

      expect(error.code, clave).toBe('sin_permiso');
      expect(error.status, clave).toBe(403);
      expect(error.userMessage, clave).toBe(
        'No tienes permiso para esto. Pídelo al administrador de la consola.',
      );
    }
  });

  it('sin cabecera, con otro esquema o vacía: token_de_plataforma_no_valido', async () => {
    expect((await denegar('POST', '/v1/plataforma/inquilinos')).code).toBe(
      'token_de_plataforma_no_valido',
    );
    expect((await denegar('POST', '/v1/plataforma/inquilinos', 'Basic abc')).code).toBe(
      'token_de_plataforma_no_valido',
    );
    expect((await denegar('POST', '/v1/plataforma/inquilinos', 'Bearer   ')).code).toBe(
      'token_de_plataforma_no_valido',
    );
  });

  it('un token de plataforma NO abre una ruta de la app: 401 token_no_valido', async () => {
    // La frontera en los dos sentidos. Aquí el código es el de la app porque quien lo lee es
    // la app: un token de consola en `GET /v1/acceso/sesiones` es una sesión que no existe.
    const error = await denegar(
      'GET',
      '/v1/acceso/sesiones',
      `Bearer ${await acunar()}`,
    );
    expect(error.code).toBe('token_no_valido');
  });

  it('`POST /v1/sesion/suplantacion` no está en la tabla: no se sirve ni con el permiso', async () => {
    // `plataforma:suplantar` es un permiso conocido —está en la tabla del contrato— y sigue
    // siendo `propuesto`: sin entrada en `route-policy.ts` la ruta falla cerrada.
    const error = await denegar(
      'POST',
      '/v1/sesion/suplantacion',
      `Bearer ${await acunar({ permisos: ['plataforma:suplantar'] })}`,
    );
    expect(error.code).toBe('fallo_de_servicio');
    expect(error.status).toBe(500);
  });
});
