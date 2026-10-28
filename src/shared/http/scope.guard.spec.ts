// El guardia de alcance, que es lo que hace cumplible la contraseña temporal.
//
// La prueba que importa es la última de la primera tanda: UNA RUTA QUE NO ESTÁ EN LA TABLA
// SE DENIEGA. `sesion.md` lo pide así —lista blanca, no lista negra— porque con una lista
// negra la ruta que alguien añada mañana nace abierta para la sesión restringida, y
// entonces «mientras la contraseña siga siendo la temporal, no se abre ninguna otra
// pantalla» deja de ser verdad sin que nadie lo note.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig, type Config } from '../config/config';
import { ContractError } from '../contract/error-catalog';
import type { Claims, Scope } from '../contract/session';
import { Tokens } from '../security/tokens';
import { ROUTE_POLICIES, policyFor } from './route-policy';
import { ScopeGuard } from './scope.guard';
import type { RequestWithContext } from './request-context';

const carpeta = mkdtempSync(join(tmpdir(), 'medskin-guardia-'));
const cfg: Config = loadConfig({
  ...process.env,
  NODE_ENV: 'development',
  JWT_PRIVATE_KEY_PATH: join(carpeta, 'jwt.key'),
  JWT_PUBLIC_KEY_PATH: join(carpeta, 'jwt.pub'),
});

const CUENTA = '11111111-1111-4111-8111-111111111111';
const CONSULTA = '22222222-2222-4222-8222-222222222222';
const SESION = '33333333-3333-4333-8333-333333333333';

let tokens: Tokens;
let guardia: ScopeGuard;

beforeAll(async () => {
  tokens = await Tokens.fromFiles(cfg);
  guardia = new ScopeGuard(tokens);
});

afterAll(() => rmSync(carpeta, { recursive: true, force: true }));

function peticion(metodo: string, ruta: string, autorizacion?: string): RequestWithContext {
  return {
    method: metodo,
    url: ruta,
    ip: '201.131.0.9',
    headers: autorizacion ? { authorization: autorizacion } : {},
    routeOptions: { url: ruta },
  } as unknown as RequestWithContext;
}

function contexto(req: RequestWithContext) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as Parameters<ScopeGuard['canActivate']>[0];
}

async function comoPaciente(alcance: Scope): Promise<string> {
  const claims: Claims = {
    sub: CUENTA,
    sid: SESION,
    rol: 'paciente',
    alcance,
    region: 'latam',
    permisos: [],
  };
  return `Bearer ${(await tokens.sign(claims)).token}`;
}

/** El token de recuperación, que NO lleva rol, ni sesión, ni inquilino. */
async function conCodigo(): Promise<string> {
  const { token } = await tokens.signRecovery({
    sub: CUENTA,
    alcance: 'recuperacion',
    region: 'latam',
  });
  return `Bearer ${token}`;
}

async function comoDoctora(alcance: Scope, conConsulta = true): Promise<string> {
  const claims: Claims = {
    sub: CUENTA,
    sid: SESION,
    rol: 'doctora',
    alcance,
    region: 'latam',
    ...(conConsulta ? { practice: CONSULTA } : {}),
    permisos: ['pacientes:leer'],
  };
  return `Bearer ${(await tokens.sign(claims)).token}`;
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

describe('GuardiaDeAlcance · la lista blanca', () => {
  it('los tres sin `Authorization` pasan y dejan `caller` en nulo', async () => {
    for (const ruta of ['/v1/acceso', '/v1/recuperacion', '/v1/recuperacion/codigo']) {
      const req = peticion('POST', ruta);
      expect(await guardia.canActivate(contexto(req)), ruta).toBe(true);
      expect(req.medskin?.caller, ruta).toBeNull();
      expect(req.medskin?.recovery, ruta).toBeNull();
    }
  });

  it('una ruta NO listada se deniega aunque el token sea perfecto', async () => {
    const error = await denegar(
      'GET',
      '/v1/pacientes',
      await comoDoctora('completo'),
    );
    // Falla cerrada y con su causa registrable: la frase no está en ningún contrato y queda
    // anotada para `producto`.
    expect(error.code).toBe('fallo_de_servicio');
    expect(error.status).toBe(500);
  });

  it('cada ruta de la tabla declara alcances o es anónima, y su frase de 500', () => {
    for (const [ruta, politica] of Object.entries(ROUTE_POLICIES)) {
      expect(politica.failurePhrase.length, ruta).toBeGreaterThan(20);
      const abierta = politica.anonymous === true || (politica.scopes ?? []).length > 0;
      expect(abierta, ruta).toBe(true);
    }
  });

  it('policyFor no inventa nada para un método distinto', () => {
    expect(policyFor('PUT', '/v1/acceso')).toBeNull();
    expect(policyFor('POST', '/v1/acceso')).not.toBeNull();
  });
});

describe('GuardiaDeAlcance · el alcance restringido', () => {
  it('`contrasena_temporal` NO abre GET /v1/acceso/sesiones: 403 contrasena_temporal_pendiente', async () => {
    const error = await denegar(
      'GET',
      '/v1/acceso/sesiones',
      await comoPaciente('contrasena_temporal'),
    );
    expect(error.code).toBe('contrasena_temporal_pendiente');
    expect(error.status).toBe(403);
  });

  it('`contrasena_temporal` SÍ abre POST /v1/acceso/contrasena-nueva', async () => {
    const req = peticion(
      'POST',
      '/v1/acceso/contrasena-nueva',
      await comoPaciente('contrasena_temporal'),
    );
    expect(await guardia.canActivate(contexto(req))).toBe(true);
    expect(req.medskin?.caller?.scope).toBe('contrasena_temporal');
  });

  it('`recuperacion` abre contrasena-nueva, y además DELETE /v1/acceso, y nada más', async () => {
    const autorizacion = await conCodigo();

    const req = peticion('POST', '/v1/acceso/contrasena-nueva', autorizacion);
    expect(await guardia.canActivate(contexto(req))).toBe(true);
    // No deja `caller`: no hay sesión ni rol que colgar. Deja `recovery`.
    expect(req.medskin?.caller).toBeNull();
    expect(req.medskin?.recovery).toEqual({
      via: 'recuperacion',
      accountId: CUENTA,
      region: 'latam',
    });

    // `sesion.md`, 27 de octubre: cerrar la propia sesión lo abre cualquier alcance,
    // porque es la única salida de «Crea tu contraseña», que no tiene atrás.
    const salir = peticion('DELETE', '/v1/acceso', autorizacion);
    expect(await guardia.canActivate(contexto(salir))).toBe(true);

    const error = await denegar('GET', '/v1/acceso/sesiones', autorizacion);
    expect(error.code).toBe('token_sin_alcance');
  });

  it('un token de recuperación CON rol no se atiende: esa forma no existe', async () => {
    // El contrato es explícito —«el token no lleva rol»— porque el cuerpo de un JWT lo lee
    // el cliente: un `rol` aquí le diría a quien acertó seis dígitos si la cuenta es de
    // doctora o de paciente, y sería un oráculo mejor que el que el acceso cierra.
    const error = await denegar(
      'POST',
      '/v1/acceso/contrasena-nueva',
      await comoPaciente('recuperacion'),
    );
    expect(error.code).toBe('token_no_valido');
  });

  it('un token `completo` en contrasena-nueva es 401 token_sin_alcance', async () => {
    const error = await denegar(
      'POST',
      '/v1/acceso/contrasena-nueva',
      await comoPaciente('completo'),
    );
    expect(error.code).toBe('token_sin_alcance');
  });

  it('DELETE /v1/acceso lo abre cualquier alcance: nadie se queda dentro contra su voluntad', async () => {
    for (const alcance of ['contrasena_temporal', 'completo'] as Scope[]) {
      const req = peticion('DELETE', '/v1/acceso', await comoPaciente(alcance));
      expect(await guardia.canActivate(contexto(req)), alcance).toBe(true);
    }
    const conRecuperacion = peticion('DELETE', '/v1/acceso', await conCodigo());
    expect(await guardia.canActivate(contexto(conRecuperacion))).toBe(true);
  });
});

describe('GuardiaDeAlcance · el portador y la coherencia del token', () => {
  it('sin cabecera, con otro esquema o vacío: token_no_valido', async () => {
    expect((await denegar('DELETE', '/v1/acceso')).code).toBe('token_no_valido');
    expect((await denegar('DELETE', '/v1/acceso', 'Basic abc')).code).toBe('token_no_valido');
    expect((await denegar('DELETE', '/v1/acceso', 'Bearer   ')).code).toBe('token_no_valido');
  });

  it('un token de doctora SIN `practice` no se atiende: no se improvisa un inquilino', async () => {
    const error = await denegar('DELETE', '/v1/acceso', await comoDoctora('completo', false));
    expect(error.code).toBe('token_no_valido');
  });

  it('`caller` sale del token: cuenta, sesión, rol, inquilino y permisos', async () => {
    const req = peticion('GET', '/v1/acceso/sesiones', await comoDoctora('completo'));
    await guardia.canActivate(contexto(req));

    expect(req.medskin?.caller).toEqual({
      accountId: CUENTA,
      sessionId: SESION,
      role: 'doctora',
      accountRole: 'practitioner',
      scope: 'completo',
      region: 'latam',
      practiceId: CONSULTA,
      permissions: ['pacientes:leer'],
    });
  });
});
