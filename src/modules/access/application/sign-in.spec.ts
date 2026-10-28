// La prueba del ORDEN, que es parte del contrato de `POST /v1/acceso`.
//
// No comprueba que un doble fue llamado: comprueba la SECUENCIA, porque la secuencia es la
// regla. `acceso.md` · «El orden de las comprobaciones, que es parte del contrato»: la
// pausa primero, el verificado de Argon2id siempre —contra el hash real o contra el
// señuelo—, y solo si la contraseña coincide se miran la suspensión y el estado de la
// temporal. Hecho al revés, una petición con contraseña inventada distingue un correo con
// cuenta de uno sin cuenta, y eso es dato de salud.
//
// Sin NestJS, sin base y sin Redis: los casos de uso reciben sus puertos.

import { describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import type {
  AccessCredential,
  AccessPausePort,
  ClockPort,
  CredentialPort,
  OpenedSession,
  PasswordHasher,
  PauseState,
  SessionPort,
  TokenPort,
} from '../domain/ports';
import { SignIn } from './sign-in';

const AHORA = new Date('2026-10-27T14:14:00.000Z');
const CUENTA = '11111111-1111-4111-8111-111111111111';
const CONSULTA = '22222222-2222-4222-8222-222222222222';
const SESION = '33333333-3333-4333-8333-333333333333';

/** El señuelo: `accountId` nulo y un hash que verificar igual. */
const SENUELO: AccessCredential = {
  accountId: null,
  accountRole: null,
  accountStatus: null,
  region: null,
  hash: '$argon2id$senuelo',
  isTemporary: false,
  tempExpiresAt: null,
  tempUsedAt: null,
  practiceId: null,
  practitionerRole: null,
  permissions: null,
};

const PACIENTE: AccessCredential = {
  accountId: CUENTA,
  accountRole: 'paciente',
  accountStatus: 'activa',
  region: 'latam',
  hash: '$argon2id$real',
  isTemporary: false,
  tempExpiresAt: null,
  tempUsedAt: null,
  practiceId: null,
  practitionerRole: null,
  permissions: null,
};

const DOCTORA: AccessCredential = {
  ...PACIENTE,
  accountRole: 'practitioner',
  practiceId: CONSULTA,
  practitionerRole: 'doctora',
  permissions: null,
};

function armar(opciones: {
  credencial: AccessCredential;
  coincide: boolean;
  pausa?: PauseState;
  trasFallar?: PauseState;
}) {
  const pasos: string[] = [];
  const libre: PauseState = { paused: false, pausedUntil: null, attemptsLeft: 5 };

  const credentials: CredentialPort = {
    read: (correo) => {
      pasos.push(`leer:${correo}`);
      return Promise.resolve(opciones.credencial);
    },
    recordAttempt: (_correo, acerto) => {
      pasos.push(`intento:${acerto}`);
      return Promise.resolve();
    },
    readMine: () => Promise.resolve(null),
    saveFinalPassword: () =>
      Promise.resolve({
        verdict: 'saved' as const,
        accountRole: 'paciente' as const,
        practiceId: null,
        permissions: null,
      }),
  };

  const passwords: PasswordHasher = {
    verify: (hash) => {
      pasos.push(`argon2:${hash}`);
      return Promise.resolve(opciones.coincide);
    },
    hash: () => Promise.resolve('$argon2id$nuevo'),
  };

  const pause: AccessPausePort = {
    peek: () => {
      pasos.push('pausa:mirar');
      return Promise.resolve(opciones.pausa ?? libre);
    },
    recordFailure: () => {
      pasos.push('pausa:fallo');
      return Promise.resolve(
        opciones.trasFallar ?? { paused: false, pausedUntil: null, attemptsLeft: 3 },
      );
    },
    clear: () => {
      pasos.push('pausa:limpiar');
      return Promise.resolve();
    },
  };

  const sessions: SessionPort = {
    open: (): Promise<OpenedSession> => {
      pasos.push('sesion:abrir');
      return Promise.resolve({
        sessionId: SESION,
        licenseStatus: 'aprobada',
        firstDayDone: true,
        practitionerRole: 'doctora' as const,
        permissions: null,
      });
    },
    nextStepFacts: () =>
      Promise.resolve({
        licenseStatus: 'aprobada',
        firstDayDone: true,
        practitionerRole: 'doctora' as const,
        permissions: null,
      }),
    list: () => Promise.resolve([]),
    revokeOne: () => Promise.resolve(true),
    revokeOthers: () => Promise.resolve(0),
  };

  const tokens: TokenPort = {
    sign: () => {
      pasos.push('token:firmar');
      return Promise.resolve({ token: 'jwt', expiresAt: new Date(AHORA.getTime() + 900_000) });
    },
    mintRefresh: () => ({ refresh: 'rfr_x', digest: 'd' }),
  };

  const clock: ClockPort = { now: () => AHORA, localTime: () => '10:29' };

  return {
    pasos,
    caso: new SignIn(credentials, passwords, pause, sessions, tokens, clock),
  };
}

const PETICION = {
  body: { correo: 'Carla.Rojas@Gmail.com', contrasena: 'tejado-lila-07' },
  ip: '201.131.0.9',
  device: {
    deviceId: 'disp-1',
    model: 'iPhone 15 Pro',
    os: 'iOS 18.2',
    appVersion: '2.4.1',
    platform: 'ios' as const,
    city: null,
  },
};

async function errorDe(trabajo: () => Promise<unknown>): Promise<ContractError> {
  try {
    await trabajo();
  } catch (fallo) {
    if (fallo instanceof ContractError) return fallo;
    throw fallo;
  }
  throw new Error('se esperaba un ErrorDeContrato y no se lanzó ninguno');
}

describe('POST /v1/acceso · el orden de las comprobaciones', () => {
  it('mira la pausa ANTES de leer la credencial y de verificar el hash', async () => {
    const { caso, pasos } = armar({ credencial: PACIENTE, coincide: true });
    await caso.run(PETICION);

    expect(pasos.indexOf('pausa:mirar')).toBe(0);
    expect(pasos.indexOf('pausa:mirar')).toBeLessThan(pasos.indexOf('leer:carla.rojas@gmail.com'));
    expect(pasos.indexOf('leer:carla.rojas@gmail.com')).toBeLessThan(
      pasos.indexOf('argon2:$argon2id$real'),
    );
  });

  it('un correo que no existe ejecuta el MISMO verificado de Argon2id, contra el señuelo', async () => {
    const { caso, pasos } = armar({ credencial: SENUELO, coincide: false });

    const error = await errorDe(() => caso.run(PETICION));

    expect(error.code).toBe('acceso_no_coincide');
    // El verificado se ejecutó: sin esto, la respuesta inmediata del caso «no existe» es
    // el oráculo que la frase niega.
    expect(pasos).toContain('argon2:$argon2id$senuelo');
    // Y el contador se movió aunque no haya cuenta: «la pausa cuenta igual para un correo
    // que no existe».
    expect(pasos).toContain('pausa:fallo');
  });

  it('una contraseña que no coincide da el MISMO 401 que un correo que no existe', async () => {
    const inventada = await errorDe(() =>
      armar({ credencial: SENUELO, coincide: false }).caso.run(PETICION),
    );
    const equivocada = await errorDe(() =>
      armar({ credencial: PACIENTE, coincide: false }).caso.run(PETICION),
    );

    expect(equivocada.code).toBe(inventada.code);
    expect(equivocada.userMessage).toBe(inventada.userMessage);
    expect(equivocada.status).toBe(inventada.status);
    expect(equivocada.data).toEqual(inventada.data);
  });

  it('si no coincide NO consulta la suspensión ni el estado de la temporal', async () => {
    // Una cuenta suspendida y con la temporal caducada: con la contraseña mal, nada de eso
    // se mira, y la respuesta es el 401 de siempre.
    const suspendidaYCaducada: AccessCredential = {
      ...PACIENTE,
      accountStatus: 'suspendida',
      isTemporary: true,
      tempExpiresAt: new Date(AHORA.getTime() - 1),
      tempUsedAt: new Date(AHORA.getTime() - 1000),
    };

    const error = await errorDe(() =>
      armar({ credencial: suspendidaYCaducada, coincide: false }).caso.run(PETICION),
    );

    expect(error.code).toBe('acceso_no_coincide');
    expect(error.status).toBe(401);
  });

  it('solo si coincide se devuelve 403 cuenta_suspendida', async () => {
    const error = await errorDe(() =>
      armar({ credencial: { ...PACIENTE, accountStatus: 'suspendida' }, coincide: true }).caso.run(
        PETICION,
      ),
    );

    expect(error.code).toBe('cuenta_suspendida');
    expect(error.status).toBe(403);
  });

  it('la suspensión se evalúa ANTES que la temporal caducada', async () => {
    const error = await errorDe(() =>
      armar({
        credencial: {
          ...PACIENTE,
          accountStatus: 'suspendida',
          isTemporary: true,
          tempExpiresAt: new Date(AHORA.getTime() - 1),
        },
        coincide: true,
      }).caso.run(PETICION),
    );

    expect(error.code).toBe('cuenta_suspendida');
  });

  it('la temporal caducada lleva su `caduco_en` y no abre sesión', async () => {
    const caduco = new Date(AHORA.getTime() - 60_000);
    const { caso, pasos } = armar({
      credencial: { ...PACIENTE, isTemporary: true, tempExpiresAt: caduco },
      coincide: true,
    });

    const error = await errorDe(() => caso.run(PETICION));

    expect(error.code).toBe('contrasena_temporal_caducada');
    expect(error.data).toEqual({ caduco_en: caduco.toISOString() });
    expect(pasos).not.toContain('sesion:abrir');
  });

  // El `contrasena_temporal_ya_usada` que había aquí se RETIRÓ con el código (decisión 27,
  // 27 de octubre). No era solo inalcanzable: el día que exista el reenvío de acceso, una
  // función que ponga `is_temporary = true` sin limpiar `temp_used_at` haría que esa rama
  // rechazara una temporal NUEVA Y LEGÍTIMA con «ya elegiste la tuya», y dejaría a la
  // paciente fuera de su cuenta. Lo que queda es que la temporal vieja no coincide con el
  // hash y cae en `acceso_no_coincide`, que es correcto y no filtra nada.
  it('una temporal consumida que ya no coincide cae en el 401 de siempre', async () => {
    const error = await errorDe(() =>
      armar({
        credencial: {
          ...PACIENTE,
          isTemporary: true,
          tempExpiresAt: new Date(AHORA.getTime() + 3_600_000),
          tempUsedAt: new Date(AHORA.getTime() - 3_600_000),
        },
        coincide: false,
      }).caso.run(PETICION),
    );

    expect(error.code).toBe('acceso_no_coincide');
  });
});

describe('POST /v1/acceso · la pausa', () => {
  it('429 antes de verificar nada: no se lee la credencial ni se llama a Argon2id', async () => {
    const hasta = new Date('2026-10-27T14:29:00.000Z');
    const { caso, pasos } = armar({
      credencial: PACIENTE,
      coincide: true,
      pausa: { paused: true, pausedUntil: hasta, attemptsLeft: 0 },
    });

    const error = await errorDe(() => caso.run(PETICION));

    expect(error.code).toBe('acceso_en_pausa');
    expect(error.status).toBe(429);
    expect(error.data).toEqual({ pausa_hasta: hasta.toISOString() });
    // La frase lleva la HORA, no «en 15 minutos».
    expect(error.userMessage).toBe('Demasiados intentos. Puedes volver a entrar a las 10:29.');
    expect(pasos).toEqual(['pausa:mirar']);
  });

  it('un correo SIN cuenta en pausa recibe exactamente el mismo 429', async () => {
    const hasta = new Date('2026-10-27T14:29:00.000Z');
    const conCuenta = await errorDe(() =>
      armar({
        credencial: PACIENTE,
        coincide: false,
        pausa: { paused: true, pausedUntil: hasta, attemptsLeft: 0 },
      }).caso.run(PETICION),
    );
    const sinCuenta = await errorDe(() =>
      armar({
        credencial: SENUELO,
        coincide: false,
        pausa: { paused: true, pausedUntil: hasta, attemptsLeft: 0 },
      }).caso.run(PETICION),
    );

    expect(sinCuenta.code).toBe(conCuenta.code);
    expect(sinCuenta.userMessage).toBe(conCuenta.userMessage);
    expect(sinCuenta.data).toEqual(conCuenta.data);
  });

  it('el 401 manda las dos piezas: `mensaje` para los campos y `datos.aviso` para el snackbar', async () => {
    const error = await errorDe(() =>
      armar({
        credencial: PACIENTE,
        coincide: false,
        trasFallar: { paused: false, pausedUntil: null, attemptsLeft: 3 },
      }).caso.run(PETICION),
    );

    expect(error.userMessage).toBe('Revisa tu correo y tu contraseña.');
    expect(error.data).toEqual({
      // Decisión 19: los dos campos que se encienden viajan en `datos.campos`, porque
      // `campo` admite uno y este es el único error del tramo con dos.
      campos: ['correo', 'contrasena'],
      intentos_restantes: 3,
      pausa_minutos: 15,
      aviso: 'Te quedan 3 intentos antes de una pausa de 15 minutos.',
    });
    // No nombra cuál de los dos campos falló.
    expect(error.field).toBeNull();
  });

  it('con un intento, el aviso concuerda en singular', async () => {
    const error = await errorDe(() =>
      armar({
        credencial: PACIENTE,
        coincide: false,
        trasFallar: { paused: false, pausedUntil: null, attemptsLeft: 1 },
      }).caso.run(PETICION),
    );

    expect(error.data?.aviso).toBe('Te quedan 1 intento antes de una pausa de 15 minutos.');
  });

  it('el quinto fallo devuelve el 429, no el 401', async () => {
    const hasta = new Date('2026-10-27T14:29:00.000Z');
    const error = await errorDe(() =>
      armar({
        credencial: PACIENTE,
        coincide: false,
        trasFallar: { paused: true, pausedUntil: hasta, attemptsLeft: 0 },
      }).caso.run(PETICION),
    );

    expect(error.code).toBe('acceso_en_pausa');
  });

  it('se limpia al entrar bien', async () => {
    const { caso, pasos } = armar({ credencial: PACIENTE, coincide: true });
    await caso.run(PETICION);
    expect(pasos).toContain('pausa:limpiar');
    expect(pasos).toContain('intento:true');
  });
});

describe('POST /v1/acceso · la respuesta', () => {
  it('la contraseña definitiva da alcance completo, refresco y 30 días para la paciente', async () => {
    const { caso } = armar({ credencial: PACIENTE, coincide: true });
    const respuesta = await caso.run(PETICION);

    expect(respuesta.rol).toBe('paciente');
    expect(respuesta.region).toBe('latam');
    expect(respuesta.siguiente_paso).toBe('inicio');
    expect(respuesta.refresco).toBe('rfr_x');
    expect(respuesta.refresco_caduca_en).toBe(
      new Date(AHORA.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    );
    expect(respuesta.sesion_id).toBe(SESION);
  });

  it('la doctora recibe 12 h de refresco, no 30 días', async () => {
    const { caso } = armar({ credencial: DOCTORA, coincide: true });
    const respuesta = await caso.run(PETICION);

    expect(respuesta.rol).toBe('doctora');
    expect(respuesta.refresco_caduca_en).toBe(
      new Date(AHORA.getTime() + 12 * 60 * 60 * 1000).toISOString(),
    );
  });

  it('con la temporal: `siguiente_paso` contrasena_nueva y SIN refresco', async () => {
    const { caso } = armar({
      credencial: {
        ...PACIENTE,
        isTemporary: true,
        tempExpiresAt: new Date(AHORA.getTime() + 3_600_000),
      },
      coincide: true,
    });
    const respuesta = await caso.run(PETICION);

    expect(respuesta.siguiente_paso).toBe('contrasena_nueva');
    // «Esa sesión no se puede prolongar, solo terminar eligiendo la contraseña.»
    expect(respuesta.refresco).toBeNull();
    // Presente y nulo, no ausente (`sesion.md`, 28 de octubre): una sola forma del campo.
    expect(respuesta.refresco_caduca_en).toBeNull();
  });

  it('una cuenta `practitioner` sin fila de consulta no inventa un rol: es 500', async () => {
    const error = await errorDe(() =>
      armar({
        credencial: { ...DOCTORA, practitionerRole: null },
        coincide: true,
      }).caso.run(PETICION),
    );

    expect(error.code).toBe('fallo_de_servicio');
    expect(error.userMessage).toBe(
      'No pudimos entrar. El servidor no respondió. Tu contraseña no cambió: puedes volver a intentarlo.',
    );
  });
});

describe('POST /v1/acceso · la forma del cuerpo', () => {
  it('correo vacío y contraseña vacía, en ese orden, y sin tocar nada más', async () => {
    const { caso, pasos } = armar({ credencial: PACIENTE, coincide: true });

    const sinCorreo = await errorDe(() =>
      caso.run({ ...PETICION, body: { contrasena: 'x' } }),
    );
    const sinContrasena = await errorDe(() =>
      caso.run({ ...PETICION, body: { correo: 'a@b.com' } }),
    );

    expect(sinCorreo.code).toBe('correo_vacio');
    expect(sinCorreo.field).toBe('correo');
    expect(sinContrasena.code).toBe('contrasena_vacia');
    expect(sinContrasena.field).toBe('contrasena');
    expect(pasos).toEqual([]);
  });

  it('un campo `rol` en el cuerpo se ignora SIN avisar', async () => {
    const { caso } = armar({ credencial: PACIENTE, coincide: true });
    const respuesta = await caso.run({
      ...PETICION,
      body: { ...PETICION.body, rol: 'doctora' },
    });

    // El rol lo resuelve el servidor: sigue siendo `paciente`.
    expect(respuesta.rol).toBe('paciente');
  });
});
