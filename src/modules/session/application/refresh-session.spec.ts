// `POST /v1/session/refresh`. Lo que se fija aquí es lo del BORDE, porque la rotación, el
// reuso y la ventana de gracia son de la base y `refresh-and-first-use.spec.ts` ya las
// prueba contra el motor:
//
//   · el cuerpo vacío no llega a tocar la base;
//   · los cuatro veredictos se traducen a sus cuatro 401, con sus frases distintas;
//   · el token nuevo se acuña con el `rol` de la consulta —nunca `practitioner`—, el
//     inquilino de la FILA y los permisos resueltos;
//   · la paciente recibe 30 días y la doctora 12 h;
//   · el límite se cuenta DENTRO de la transacción, y `graced` se mide y no se devuelve.

import { describe, expect, it } from 'vitest';

import { ContractError, ServiceFailure } from '../../../shared/contract/error-catalog';
import type { Claims } from '../../../shared/contract/session';
import { REFRESH_LIFETIME_MS } from '../../access/application/sign-in';
import { PERMISSIONS_BY_ROLE } from '../../access/domain/role';
import type {
  RefreshLimitsPort,
  RefreshPort,
  RefreshTokenPort,
  RefreshVerdict,
  RotatedRefresh,
} from '../domain/ports';
import { RefreshSession } from './refresh-session';

const AHORA = new Date('2026-10-28T14:31:00.000Z');
const CADUCA_TOKEN = new Date('2026-10-28T14:46:00.000Z');
const SESION = '33333333-3333-4333-8333-333333333333';
const CUENTA = '11111111-1111-4111-8111-111111111111';
const CONSULTA = '22222222-2222-4222-8222-222222222222';
// Las dos caducidades las calcula la BASE con el rol delante (migración 0020); aquí son lo
// que el doble devuelve, para comprobar que el borde pasa la que vino y no recalcula otra.
const DOCE_HORAS = new Date(AHORA.getTime() + REFRESH_LIFETIME_MS.practitioner);
const TREINTA_DIAS = new Date(AHORA.getTime() + REFRESH_LIFETIME_MS.patient);

const ROTADO: RotatedRefresh = {
  verdict: 'rotated',
  sessionId: SESION,
  accountId: CUENTA,
  practiceId: CONSULTA,
  scope: 'completo',
  accountRole: 'practitioner',
  practitionerRole: 'doctora',
  permissions: null,
  accountStatus: 'activa',
  passwordIsTemporary: false,
  licenseStatus: 'verificada',
  firstDayDone: true,
  refreshExpiresAt: DOCE_HORAS,
  graced: false,
};

const PACIENTE: RotatedRefresh = {
  ...ROTADO,
  practiceId: null,
  accountRole: 'paciente',
  practitionerRole: null,
  licenseStatus: null,
  refreshExpiresAt: TREINTA_DIAS,
};

function noRotado(verdict: Exclude<RefreshVerdict, 'rotated'>): RotatedRefresh {
  // Así llega de la función: todo en nulo menos el veredicto. Lo que no vale no autoriza a
  // saber de quién era.
  return {
    verdict,
    sessionId: null,
    accountId: null,
    practiceId: null,
    scope: null,
    accountRole: null,
    practitionerRole: null,
    permissions: null,
    accountStatus: null,
    passwordIsTemporary: false,
    licenseStatus: null,
    firstDayDone: false,
    refreshExpiresAt: null,
    graced: false,
  };
}

type Registro = {
  rotaciones: Array<{
    digest: string;
    newDigest: string;
    patientSeconds: number;
    practitionerSeconds: number;
  }>;
  contados: Array<{ sessionId: string; graced: boolean }>;
  firmas: Claims[];
  rollback: boolean;
};

function armar(opciones: { verdict?: RotatedRefresh; limite?: ContractError }): {
  caso: RefreshSession;
  visto: Registro;
} {
  const visto: Registro = { rotaciones: [], contados: [], firmas: [], rollback: false };

  const sessions: RefreshPort = {
    rotate: async (p) => {
      visto.rotaciones.push({
        digest: p.digest,
        newDigest: p.newDigest,
        patientSeconds: p.patientSeconds,
        practitionerSeconds: p.practitionerSeconds,
      });
      const verdict = opciones.verdict ?? ROTADO;
      try {
        // El doble se comporta como la transacción de verdad: lo que lance el `within`
        // deshace la rotación, y eso es lo que el `429` necesita para no costar la sesión.
        await p.withinTransaction(verdict);
      } catch (fallo) {
        visto.rollback = true;
        throw fallo;
      }
      return verdict;
    },
  };

  const limits: RefreshLimitsPort = {
    countRefresh: (sessionId, graced) => {
      visto.contados.push({ sessionId, graced });
      if (opciones.limite) return Promise.reject(opciones.limite);
      return Promise.resolve();
    },
  };

  const tokens: RefreshTokenPort = {
    sign: (claims) => {
      visto.firmas.push(claims);
      return Promise.resolve({ token: 'token.nuevo', expiresAt: CADUCA_TOKEN });
    },
    mintRefresh: () => ({ refresh: 'rfr_nuevo', digest: 'resumen_nuevo' }),
    digestRefresh: (refresh) => `resumen(${refresh})`,
  };

  return { caso: new RefreshSession(sessions, limits, tokens, 'latam'), visto };
}

async function errorDe(trabajo: () => Promise<unknown>): Promise<ContractError> {
  try {
    await trabajo();
  } catch (fallo) {
    if (fallo instanceof ContractError) return fallo;
    throw fallo;
  }
  throw new Error('se esperaba un ContractError y no se lanzó ninguno');
}

describe('POST /v1/session/refresh · el cuerpo', () => {
  it('sin el campo es 400 `refresco_vacio` y no toca la base', async () => {
    const { caso, visto } = armar({});

    const error = await errorDe(() => caso.run({}));

    expect(error.code).toBe('refresco_vacio');
    expect(error.status).toBe(400);
    expect(error.field).toBe('refresco');
    expect(visto.rotaciones).toEqual([]);
  });

  it('en blanco, nulo o sin cuerpo es el mismo 400', async () => {
    const { caso, visto } = armar({});

    for (const cuerpo of [{ refresco: '   ' }, { refresco: '' }, null, undefined, 'no-objeto']) {
      expect((await errorDe(() => caso.run(cuerpo))).code).toBe('refresco_vacio');
    }
    expect(visto.rotaciones).toEqual([]);
  });
});

describe('POST /v1/session/refresh · el 200', () => {
  it('rota con el resumen del refresco que llegó y devuelve los cinco campos', async () => {
    const { caso, visto } = armar({});

    const respuesta = await caso.run({ refresco: 'rfr_viejo' });

    expect(Object.keys(respuesta)).toEqual([
      'token',
      'token_caduca_en',
      'refresco',
      'refresco_caduca_en',
      'siguiente_paso',
    ]);
    expect(respuesta.token).toBe('token.nuevo');
    expect(respuesta.token_caduca_en).toBe(CADUCA_TOKEN.toISOString());
    expect(respuesta.refresco).toBe('rfr_nuevo');
    expect(respuesta.refresco_caduca_en).toBe(DOCE_HORAS.toISOString());
    expect(respuesta.siguiente_paso).toBe('inicio');
    // El refresco en claro NO viaja a la base: va su resumen determinista.
    expect(visto.rotaciones[0]?.digest).toBe('resumen(rfr_viejo)');
    expect(visto.rotaciones[0]?.newDigest).toBe('resumen_nuevo');
  });

  it('acuña el token con el rol de la consulta, el inquilino de la fila y los permisos resueltos', async () => {
    const { caso, visto } = armar({});

    await caso.run({ refresco: 'rfr_viejo' });

    expect(visto.firmas[0]).toEqual({
      sub: CUENTA,
      sid: SESION,
      rol: 'doctora',
      alcance: 'completo',
      region: 'latam',
      practice: CONSULTA,
      permisos: PERMISSIONS_BY_ROLE.doctora,
    });
    // `practitioner` es valor de base y no sale nunca al cliente.
    expect(visto.firmas[0]?.rol).not.toBe('practitioner');
  });

  it('la lista explícita de permisos manda sobre la del rol', async () => {
    const { caso, visto } = armar({
      verdict: { ...ROTADO, practitionerRole: 'recepcion', permissions: ['agenda:leer'] },
    });

    await caso.run({ refresco: 'rfr_viejo' });

    expect(visto.firmas[0]?.permisos).toEqual(['agenda:leer']);
  });

  it('manda las dos vidas del contrato en segundos y EN SU ORDEN, y no calcula ninguna', async () => {
    const { caso, visto } = armar({});

    await caso.run({ refresco: 'rfr_viejo' });

    // Paciente primero, consulta después (migración 0020). El orden importa: la base le
    // pone cota a cada hueco —31 días y 13 h—, así que invertirlos revienta en vez de
    // dejar a una doctora con un refresco de 30 días. Aquí se fija el orden para que no
    // haga falta que lo cace la base.
    expect(visto.rotaciones[0]?.patientSeconds).toBe(30 * 24 * 60 * 60);
    expect(visto.rotaciones[0]?.practitionerSeconds).toBe(12 * 60 * 60);
  });

  it('devuelve la caducidad que calculó la base, sin recalcularla: 30 días para la paciente', async () => {
    const { caso, visto } = armar({ verdict: PACIENTE });

    const respuesta = await caso.run({ refresco: 'rfr_viejo' });

    expect(respuesta.refresco_caduca_en).toBe(TREINTA_DIAS.toISOString());
    // Y su token no lleva inquilino: una paciente no es de ninguno.
    expect(visto.firmas[0]?.practice).toBeUndefined();
    expect(visto.firmas[0]?.permisos).toEqual([]);
  });

  it('`siguiente_paso` sale de los tres hechos que devuelve la base, no de una regla nueva', async () => {
    const licencia = armar({ verdict: { ...ROTADO, licenseStatus: 'sin_enviar' } });
    expect((await licencia.caso.run({ refresco: 'r' })).siguiente_paso).toBe('licencia');

    const primerDia = armar({ verdict: { ...ROTADO, firstDayDone: false } });
    expect((await primerDia.caso.run({ refresco: 'r' })).siguiente_paso).toBe('primer_dia');

    const temporal = armar({ verdict: { ...ROTADO, passwordIsTemporary: true } });
    expect((await temporal.caso.run({ refresco: 'r' })).siguiente_paso).toBe('contrasena_nueva');
  });

  it('el refresco que entró por la gracia se mide y NO se le cuenta al cliente', async () => {
    const { caso, visto } = armar({ verdict: { ...ROTADO, graced: true } });

    const respuesta = await caso.run({ refresco: 'rfr_viejo' });

    expect(visto.contados).toEqual([{ sessionId: SESION, graced: true }]);
    expect(JSON.stringify(respuesta)).not.toContain('graced');
    expect(JSON.stringify(respuesta)).not.toContain('gracia');
  });
});

describe('POST /v1/session/refresh · los errores', () => {
  it('los cuatro veredictos que no son rotación son sus cuatro 401, con cuatro frases', async () => {
    const esperado = {
      reused: { code: 'refresco_reutilizado', message: 'Cerramos tu sesión por seguridad. Entra otra vez.' },
      revoked: { code: 'sesion_revocada', message: 'Cerramos tu sesión en este teléfono.' },
      expired: { code: 'refresco_caducado', message: 'Pasó tiempo sin usar MedSkin. Entra otra vez.' },
      invalid: { code: 'refresco_no_valido', message: '' },
    } as const;

    for (const [verdict, esperada] of Object.entries(esperado)) {
      const { caso, visto } = armar({
        verdict: noRotado(verdict as Exclude<RefreshVerdict, 'rotated'>),
      });

      const error = await errorDe(() => caso.run({ refresco: 'rfr_viejo' }));

      expect(error.code).toBe(esperada.code);
      expect(error.status).toBe(401);
      expect(error.userMessage).toBe(esperada.message);
      // Un veredicto que no vale no gasta cuota de nadie: no hay `sid` que contar.
      expect(visto.contados).toEqual([]);
      expect(visto.firmas).toEqual([]);
    }
  });

  it('una cuenta suspendida es 403 aunque el refresco fuera bueno', async () => {
    const { caso, visto } = armar({ verdict: { ...ROTADO, accountStatus: 'suspendida' } });

    const error = await errorDe(() => caso.run({ refresco: 'rfr_viejo' }));

    expect(error.code).toBe('cuenta_suspendida');
    expect(error.status).toBe(403);
    // Y no se le devuelve par nuevo: la rotación mató la credencial, que es el lado seguro.
    expect(visto.firmas).toEqual([]);
  });

  it('el 429 se cuenta dentro de la transacción, así que el refresco que llegó sigue valiendo', async () => {
    const { caso, visto } = armar({ limite: new ContractError('demasiados_refrescos') });

    const error = await errorDe(() => caso.run({ refresco: 'rfr_viejo' }));

    expect(error.code).toBe('demasiados_refrescos');
    expect(error.status).toBe(429);
    // Lo que fija la decisión: la rotación se deshace. Sin esto, «espera y reintenta con
    // retroceso» le costaría la sesión a quien reintenta pasados los 20 s de gracia.
    expect(visto.rollback).toBe(true);
    expect(visto.firmas).toEqual([]);
  });

  it('una cuenta de consulta sin rol activo no inventa un rol: es 500 con su frase', async () => {
    const { caso } = armar({ verdict: { ...ROTADO, practitionerRole: null } });

    const error = await errorDe(() => caso.run({ refresco: 'rfr_viejo' }));

    expect(error).toBeInstanceOf(ServiceFailure);
    expect(error.userMessage).toBe(
      'No pudimos renovar tu sesión. Puedes seguir con lo último guardado.',
    );
    // La causa lleva identificadores y nada más, y no sale al cliente.
    expect(((error as ServiceFailure).cause as Error).message).toContain(CUENTA);
    expect(JSON.stringify(error.body())).not.toContain(CUENTA);
  });

  it('una rotación sin sesión, cuenta o alcance es 500 y no un token a medias', async () => {
    const { caso, visto } = armar({ verdict: { ...ROTADO, scope: null } });

    const error = await errorDe(() => caso.run({ refresco: 'rfr_viejo' }));

    expect(error).toBeInstanceOf(ServiceFailure);
    expect(visto.firmas).toEqual([]);
  });
});
