// El token, contra las llaves de verdad. Lo que se fija aquí:
//   · las reclamaciones que `sesion.md` enumera, y `practice` SOLO para doctora y equipo;
//   · un token tocado no se acepta (y «no se acepta» es `token_no_valido`, no un 500);
//   · un token caducado de alcance restringido es `410 plazo_vencido` y no
//     `401 token_caducado`, porque el plazo de la contraseña temporal ES la vida del token;
//   · el resumen del refresco es determinista (hay un índice único sobre esa columna) y no
//     se parece al refresco (un volcado de la base no da sesiones vivas).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContractError } from '../contract/error-catalog';
import type { Claims } from '../contract/session';
import { loadConfig, type Config } from '../config/config';
import { Tokens } from './tokens';

const carpeta = mkdtempSync(join(tmpdir(), 'medskin-llaves-'));

const cfg: Config = loadConfig({
  ...process.env,
  NODE_ENV: 'development',
  JWT_PRIVATE_KEY_PATH: join(carpeta, 'jwt.key'),
  JWT_PUBLIC_KEY_PATH: join(carpeta, 'jwt.pub'),
});

const DOCTORA: Claims = {
  sub: '11111111-1111-4111-8111-111111111111',
  sid: '33333333-3333-4333-8333-333333333333',
  rol: 'doctora',
  alcance: 'completo',
  region: 'latam',
  practice: '22222222-2222-4222-8222-222222222222',
  permisos: ['pacientes:crear', 'pacientes:leer'],
};

let tokens: Tokens;

beforeAll(async () => {
  // Genera el par de desarrollo si no existe, que es lo que hace al arrancar.
  tokens = await Tokens.fromFiles(cfg);
});

afterAll(() => {
  rmSync(carpeta, { recursive: true, force: true });
});

async function errorDe(trabajo: () => Promise<unknown>): Promise<ContractError> {
  try {
    await trabajo();
  } catch (fallo) {
    if (fallo instanceof ContractError) return fallo;
    throw fallo;
  }
  throw new Error('se esperaba un ErrorDeContrato y no se lanzó ninguno');
}

describe('Tokens · firmar y verificar', () => {
  it('devuelve las reclamaciones de sesion.md, `practice` incluida', async () => {
    const { token, expiresAt } = await tokens.sign(DOCTORA);
    const leido = await tokens.verify(token);

    expect(leido.sub).toBe(DOCTORA.sub);
    expect(leido.sid).toBe(DOCTORA.sid);
    expect(leido.rol).toBe('doctora');
    expect(leido.alcance).toBe('completo');
    expect(leido.region).toBe('latam');
    expect(leido.practice).toBe(DOCTORA.practice);
    expect(leido.permisos).toEqual(DOCTORA.permisos);
    // 15 minutos, `sesion.md` · «La forma del token».
    expect(leido.exp - leido.iat).toBe(15 * 60);
    expect(expiresAt.getTime()).toBe(leido.exp * 1000);
  });

  it('una paciente viaja SIN `practice`: no es de ningún inquilino', async () => {
    const { token } = await tokens.sign({
      ...DOCTORA,
      rol: 'paciente',
      practice: undefined,
      permisos: [],
    });
    const leido = await tokens.verify(token);
    expect(leido.practice).toBeUndefined();
  });

  it('lleva `kid` en la cabecera: con rotación cada 90 días hace falta', async () => {
    const { token } = await tokens.sign(DOCTORA);
    const cabecera = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString()) as {
      alg: string;
      kid?: string;
    };
    expect(cabecera.alg).toBe('EdDSA');
    expect(cabecera.kid).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it('un token tocado es token_no_valido, no un 500', async () => {
    const { token } = await tokens.sign(DOCTORA);
    const partes = token.split('.');
    const tocado = `${partes[0]}.${partes[1]}.${'A'.repeat((partes[2] ?? '').length)}`;

    const error = await errorDe(() => tokens.verify(tocado));
    expect(error.code).toBe('token_no_valido');
    expect(error.status).toBe(401);
  });

  it('basura en vez de un token también es token_no_valido', async () => {
    expect((await errorDe(() => tokens.verify('no-es-un-token'))).code).toBe('token_no_valido');
    expect((await errorDe(() => tokens.verify(''))).code).toBe('token_no_valido');
  });

  it('un token caducado de alcance completo es 401 token_caducado', async () => {
    const token = await caducado('completo');
    const error = await errorDe(() => tokens.verify(token));
    expect(error.code).toBe('token_caducado');
  });

  it('un token caducado de alcance restringido es 410 plazo_vencido', async () => {
    // El plazo de 15 min de `contrasena-nueva` ES la vida del token, así que es este caso
    // el que tiene que decir «Se pasó el tiempo. Vuelve a entrar con la contraseña que te
    // mandamos» y no «Tu sesión se cerró».
    const tokenTemporal = await caducado('contrasena_temporal');
    const tokenRecuperacion = await caducado('recuperacion');
    const temporal = await errorDe(() => tokens.verify(tokenTemporal));
    const recuperacion = await errorDe(() => tokens.verify(tokenRecuperacion));

    expect(temporal.code).toBe('plazo_vencido');
    expect(temporal.status).toBe(410);
    expect(recuperacion.code).toBe('plazo_vencido');
  });

  it('un token sin `permisos` no se acepta: la forma es contrato', async () => {
    const sinPermisos = await new SignJWT({
      sid: DOCTORA.sid,
      rol: 'doctora',
      alcance: 'completo',
      region: 'latam',
    })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(DOCTORA.sub)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(await llavePrivada());

    expect((await errorDe(() => tokens.verify(sinPermisos))).code).toBe('token_no_valido');
  });
});

describe('Tokens · el refresco', () => {
  it('es opaco, no es un JWT y su resumen no se parece a él', () => {
    const { refresh, digest } = tokens.mintRefresh();
    expect(refresh.startsWith('rfr_')).toBe(true);
    expect(refresh.split('.')).toHaveLength(1);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(refresh.slice(4, 20));
  });

  it('el resumen es DETERMINISTA: hay un índice único sobre esa columna', () => {
    const { refresh, digest } = tokens.mintRefresh();
    expect(tokens.digestRefresh(refresh)).toBe(digest);
  });

  it('dos refrescos seguidos no se repiten', () => {
    const vistos = new Set(Array.from({ length: 50 }, () => tokens.mintRefresh().refresh));
    expect(vistos.size).toBe(50);
  });
});

// --- Ayudas -----------------------------------------------------------------------------

async function llavePrivada() {
  const { importPKCS8 } = await import('jose');
  const { readFileSync } = await import('node:fs');
  return importPKCS8(readFileSync(cfg.JWT_PRIVATE_KEY_PATH, 'utf8'), 'Ed25519');
}

/** Un token con la firma BUENA y el `exp` pasado: es el caso que hay que distinguir. */
async function caducado(alcance: string): Promise<string> {
  const hace = Math.floor(Date.now() / 1000) - 3600;
  return new SignJWT({
    sid: DOCTORA.sid,
    rol: 'paciente',
    alcance,
    region: 'latam',
    permisos: [],
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(DOCTORA.sub)
    .setIssuedAt(hace)
    .setExpirationTime(hace + 900)
    .sign(await llavePrivada());
}
