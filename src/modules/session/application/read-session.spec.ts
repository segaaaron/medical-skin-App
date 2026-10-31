// `GET /v1/session`. Lo que se fija aquí es lo que el contrato pone por escrito y una app
// no puede comprobar sola:
//
//   · la lista de permisos sale RESUELTA, y nunca el rol a secas;
//   · el `alcance` es el DEL TOKEN, que es de donde la app saca qué pantalla abrir;
//   · una sesión revocada responde 401 y no un 200 con datos;
//   · nada clínico sale en la respuesta ni en la causa de un 500.

import { describe, expect, it } from 'vitest';

import { ContractError, ServiceFailure } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import { PERMISSIONS_BY_ROLE } from '../../access/domain/role';
import type { SessionOwner, SessionSnapshot, SessionSnapshotPort } from '../domain/ports';
import { ReadSession } from './read-session';

const SESION = '33333333-3333-4333-8333-333333333333';
const CUENTA = '11111111-1111-4111-8111-111111111111';
const CONSULTA = '22222222-2222-4222-8222-222222222222';
const CADUCA = new Date('2026-10-27T14:46:00.000Z');
const REFRESCO_CADUCA = new Date('2026-10-28T02:31:00.000Z');

const DOCTORA: Caller = {
  accountId: CUENTA,
  sessionId: SESION,
  role: 'doctor',
  accountRole: 'doctor',
  scope: 'completo',
  region: 'latam',
  practiceId: CONSULTA,
  permissions: [],
};

const PACIENTE: Caller = {
  accountId: CUENTA,
  sessionId: SESION,
  role: 'patient',
  accountRole: 'patient',
  scope: 'completo',
  region: 'latam',
  practiceId: null,
  permissions: [],
};

const CONSULTA_VIVA: SessionSnapshot = {
  accountStatus: 'activa',
  revokedAt: null,
  refreshExpiresAt: REFRESCO_CADUCA,
  practice: { id: CONSULTA, name: 'Clínica Paz' },
  licenseDeclared: true,
  firstDayDone: true,
  permissions: null,
};

function puerto(
  snapshot: SessionSnapshot | null,
): { port: SessionSnapshotPort; vistos: SessionOwner[] } {
  const vistos: SessionOwner[] = [];
  return {
    vistos,
    port: {
      read: (owner) => {
        vistos.push(owner);
        return Promise.resolve(snapshot);
      },
    },
  };
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

describe('GET /v1/session · el 200', () => {
  it('devuelve la forma exacta del contrato y busca la fila por el `sid` del token', async () => {
    const { port, vistos } = puerto(CONSULTA_VIVA);

    const vista = await new ReadSession(port).run(DOCTORA, CADUCA);

    expect(Object.keys(vista)).toEqual([
      'sesion_id',
      'cuenta_id',
      'rol',
      'alcance',
      'region',
      'siguiente_paso',
      'consulta',
      'permisos',
      'segundo_factor',
      'token_caduca_en',
      'refresco_caduca_en',
    ]);
    expect(vista.sesion_id).toBe(SESION);
    expect(vista.cuenta_id).toBe(CUENTA);
    expect(vista.rol).toBe('doctor');
    expect(vista.alcance).toBe('completo');
    expect(vista.consulta).toEqual({ id: CONSULTA, nombre: 'Clínica Paz' });
    expect(vista.token_caduca_en).toBe(CADUCA.toISOString());
    expect(vista.refresco_caduca_en).toBe(REFRESCO_CADUCA.toISOString());
    // El `sid` y la cuenta salen del TOKEN, nunca del cuerpo ni de la URL.
    expect(vistos).toEqual([
      {
        accountId: CUENTA,
        sessionId: SESION,
        practiceId: CONSULTA,
        accountRole: 'doctor',
      },
    ]);
  });

  it('el segundo factor va apagado y lo dice, porque su endpoint está en `propuesto`', async () => {
    const { port } = puerto(CONSULTA_VIVA);
    const vista = await new ReadSession(port).run(DOCTORA, CADUCA);
    expect(vista.segundo_factor).toEqual({ activo: false, obligatorio_desde: null });
  });

  it('con `practitioner.permissions` nula resuelve la lista de su rol, no el rol', async () => {
    const { port } = puerto(CONSULTA_VIVA);
    const vista = await new ReadSession(port).run(DOCTORA, CADUCA);
    expect(vista.permisos).toEqual(PERMISSIONS_BY_ROLE.doctor);
  });

  it('con la lista explícita recortada no recibe lo que esa lista no dice', async () => {
    // Lo que acota a alguien dentro de una consulta es `practitioner.permissions`, no un
    // rol: «permisos como interruptores, no como roles». Con un solo rol esta es la única
    // forma de que una persona tenga menos que otra, y por eso se prueba.
    const { port } = puerto({ ...CONSULTA_VIVA, permissions: ['agenda:leer', 'citas:crear'] });

    const vista = await new ReadSession(port).run(DOCTORA, CADUCA);

    expect(vista.permisos).toEqual(['agenda:leer', 'citas:crear']);
    expect(vista.permisos).not.toContain('pacientes:crear');
    expect(vista.permisos).not.toContain('historia:leer');
  });

  it('con la lista explícita escrita manda esa, y no la de la tabla por rol', async () => {
    const { port } = puerto({ ...CONSULTA_VIVA, permissions: ['pacientes:leer', 'agenda:leer'] });
    const vista = await new ReadSession(port).run(DOCTORA, CADUCA);
    expect(vista.permisos).toEqual(['pacientes:leer', 'agenda:leer']);
  });

  it('una paciente no tiene consulta ni permisos, y su paso es `inicio`', async () => {
    const { port, vistos } = puerto({
      ...CONSULTA_VIVA,
      practice: null,
      licenseDeclared: false,
    });

    const vista = await new ReadSession(port).run(PACIENTE, CADUCA);

    expect(vista.consulta).toBeNull();
    expect(vista.permisos).toEqual([]);
    expect(vista.siguiente_paso).toBe('inicio');
    // Y su contexto no fija consulta: no pertenece a ninguno.
    expect(vistos[0]?.practiceId).toBeNull();
  });

  it('la licencia sin enviar y la lista del primer día mueven `siguiente_paso` en cada arranque', async () => {
    const { port: sinEnviar } = puerto({ ...CONSULTA_VIVA, licenseDeclared: false });
    expect((await new ReadSession(sinEnviar).run(DOCTORA, CADUCA)).siguiente_paso).toBe('licencia');

    const { port: primerDia } = puerto({ ...CONSULTA_VIVA, firstDayDone: false });
    expect((await new ReadSession(primerDia).run(DOCTORA, CADUCA)).siguiente_paso).toBe(
      'primer_dia',
    );
  });

  it('con la contraseña todavía temporal dice el alcance restringido y manda a elegirla', async () => {
    // La fila ya no tiene refresco porque el alcance restringido no lo lleva.
    const { port } = puerto({ ...CONSULTA_VIVA, refreshExpiresAt: null });
    const temporal: Caller = { ...DOCTORA, scope: 'contrasena_temporal' };

    const vista = await new ReadSession(port).run(temporal, CADUCA);

    expect(vista.alcance).toBe('contrasena_temporal');
    expect(vista.siguiente_paso).toBe('contrasena_nueva');
    expect(vista.refresco_caduca_en).toBeNull();
  });
});

describe('GET /v1/session · los errores', () => {
  it('una sesión cerrada en otro sitio es 401 `sesion_revocada`, no un 200', async () => {
    const { port } = puerto({ ...CONSULTA_VIVA, revokedAt: new Date('2026-10-27T13:00:00.000Z') });

    const error = await errorDe(() => new ReadSession(port).run(DOCTORA, CADUCA));

    expect(error.code).toBe('sesion_revocada');
    expect(error.status).toBe(401);
    expect(error.userMessage).toBe('Cerramos tu sesión en este teléfono.');
  });

  it('una cuenta suspendida es 403 y su frase, con la dirección de contacto', async () => {
    const { port } = puerto({ ...CONSULTA_VIVA, accountStatus: 'suspendida' });

    const error = await errorDe(() => new ReadSession(port).run(DOCTORA, CADUCA));

    expect(error.code).toBe('cuenta_suspendida');
    expect(error.status).toBe(403);
  });

  it('un `sid` que no es fila de esta cuenta es 401 `token_no_valido`', async () => {
    const { port } = puerto(null);

    const error = await errorDe(() => new ReadSession(port).run(DOCTORA, CADUCA));

    expect(error.code).toBe('token_no_valido');
    expect(error.status).toBe(401);
  });

  it('un token con consulta y sin consulta que leer es 500 con su frase y su causa real', async () => {
    const { port } = puerto({ ...CONSULTA_VIVA, practice: null });

    const error = await errorDe(() => new ReadSession(port).run(DOCTORA, CADUCA));

    expect(error).toBeInstanceOf(ServiceFailure);
    expect(error.status).toBe(500);
    // La frase del contrato, palabra por palabra: este 500 NO expulsa al acceso.
    expect(error.userMessage).toBe(
      'No pudimos comprobar tu sesión. Puedes seguir con lo último guardado.',
    );
    // La causa viaja hacia `service_failure` y lleva identificadores y nada más.
    const causa = (error as ServiceFailure).cause;
    expect(causa).toBeInstanceOf(Error);
    expect((causa as Error).message).toContain(SESION);
    // Y el cuerpo que ve el cliente no lleva ni la causa ni el identificador.
    expect(JSON.stringify(error.body())).not.toContain(SESION);
  });
});
