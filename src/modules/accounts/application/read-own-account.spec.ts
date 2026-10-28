// `GET /v1/cuentas/mia` · lo que el contrato promete de la pantalla de arranque.
//
// Lo que se fija aquí:
//   · el `rol` de doctora y equipo sale de `practitioner.role` DE ESTA CONSULTA, no de
//     `account.role`, que vale `practitioner` para las tres;
//   · `doctoras` es de una paciente: para una cuenta de equipo sale vacío y NI SE PREGUNTA,
//     porque `app_practitioner` lee `patient_link` por `practice_id` y devolvería las fichas
//     de la consulta en vez de las suyas;
//   · una sesión restringida se sirve con el rol de base restringido y su único paso es
//     «Crea tu contraseña»;
//   · una cuenta sin fila que servir es un 500 con su frase, nunca una respuesta inventada.

import { describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import type { NextStepFacts } from '../../access/domain/ports';
import type { OwnProfile } from '../domain/ports';
import { ReadOwnAccount, type PractitionerFactsPort } from './read-own-account';

const PACIENTE: Caller = {
  accountId: '11111111-1111-4111-8111-111111111111',
  sessionId: '33333333-3333-4333-8333-333333333333',
  role: 'paciente',
  accountRole: 'paciente',
  scope: 'completo',
  region: 'latam',
  practiceId: null,
  permissions: [],
};

const EQUIPO: Caller = {
  ...PACIENTE,
  role: 'recepcion',
  accountRole: 'practitioner',
  practiceId: '22222222-2222-4222-8222-222222222222',
};

const VINCULO = {
  practiceId: '44444444-4444-4444-8444-444444444444',
  practiceName: 'Clínica Paz',
  practitionerName: 'Dra. Paz Villarroel',
  status: 'vinculada',
  since: '2026-03-01',
};

const PERFIL: OwnProfile = {
  email: 'carla.rojas@gmail.com',
  firstName: 'Carla',
  lastName: 'Rojas',
  phone: '+59171234567',
  status: 'activa',
  region: 'latam',
  passwordIsTemporary: false,
  doctoras: [VINCULO],
};

type Opciones = {
  perfil?: OwnProfile | null;
  hechos?: Partial<NextStepFacts>;
};

function armar(opciones: Opciones = {}) {
  const pedido: { restricted?: boolean; withLinks?: boolean }[] = [];
  const pasos: string[] = [];

  const accounts = {
    readProfile: (p: { restricted: boolean; withLinks: boolean }) => {
      pasos.push('perfil');
      pedido.push({ restricted: p.restricted, withLinks: p.withLinks });
      const perfil = opciones.perfil === undefined ? PERFIL : opciones.perfil;
      // El repositorio solo devuelve vínculos si se los piden: es lo que hace la consulta.
      return Promise.resolve(
        perfil === null ? null : { ...perfil, doctoras: p.withLinks ? perfil.doctoras : [] },
      );
    },
  };

  const facts: PractitionerFactsPort = {
    nextStepFacts: () => {
      pasos.push('hechos');
      return Promise.resolve({
        licenseStatus: 'verificada',
        firstDayDone: true,
        practitionerRole: 'recepcion',
        permissions: null,
        ...opciones.hechos,
      });
    },
  };

  return { caso: new ReadOwnAccount(accounts, facts), pedido, pasos };
}

async function errorDe(trabajo: () => Promise<unknown>): Promise<ContractError> {
  try {
    await trabajo();
  } catch (fallo) {
    if (fallo instanceof ContractError) return fallo;
    throw fallo;
  }
  throw new Error('no lanzó y tenía que lanzar');
}

describe('GET /v1/cuentas/mia', () => {
  it('a la paciente le devuelve sus doctoras, y no pregunta nada de ninguna consulta', async () => {
    const { caso, pedido, pasos } = armar();
    const respuesta = await caso.run(PACIENTE);

    expect(respuesta).toEqual({
      cuenta_id: PACIENTE.accountId,
      rol: 'paciente',
      nombre: 'Carla',
      apellido: 'Rojas',
      correo: 'carla.rojas@gmail.com',
      celular: '+59171234567',
      estado: 'activa',
      contrasena_es_temporal: false,
      siguiente_paso: 'inicio',
      region: 'latam',
      doctoras: [
        {
          practice_id: VINCULO.practiceId,
          nombre: 'Dra. Paz Villarroel',
          consulta: 'Clínica Paz',
          desde: '2026-03-01',
          vinculo: 'vinculada',
        },
      ],
    });
    expect(pedido).toEqual([{ restricted: false, withLinks: true }]);
    // Ni una lectura de licencia ni de la lista del primer día: una paciente no tiene
    // consulta, y preguntar por ella sería un viaje a la base por cada arranque de la app.
    expect(pasos).toEqual(['perfil']);
  });

  it('a una cuenta de equipo le devuelve el rol de ESTA consulta y doctoras vacío', async () => {
    const { caso, pedido } = armar({ hechos: { practitionerRole: 'asistente_clinico' } });
    const respuesta = await caso.run(EQUIPO);

    // `account.role` es `practitioner` y no viaja nunca; el rol que la app lee es el de la
    // fila de `practitioner`, que aquí dice otra cosa que la reclamación del token.
    expect(respuesta.rol).toBe('asistente_clinico');
    expect(respuesta.doctoras).toEqual([]);
    // Y no se le PREGUNTA por sus vínculos: con `app_practitioner` esa lectura devolvería
    // las fichas de la consulta, que no son suyas.
    expect(pedido).toEqual([{ restricted: false, withLinks: false }]);
  });

  it('la licencia sin enviar manda a la doctora a su licencia', async () => {
    const { caso } = armar({
      hechos: { practitionerRole: 'doctora', licenseStatus: 'sin_enviar' },
    });
    expect((await caso.run({ ...EQUIPO, role: 'doctora' })).siguiente_paso).toBe('licencia');
  });

  it('una sesión restringida se sirve con el rol de base restringido y va a su contraseña', async () => {
    const { caso, pedido, pasos } = armar({
      perfil: { ...PERFIL, passwordIsTemporary: true },
    });
    const respuesta = await caso.run({ ...PACIENTE, scope: 'contrasena_temporal' });

    expect(respuesta.contrasena_es_temporal).toBe(true);
    expect(respuesta.siguiente_paso).toBe('contrasena_nueva');
    expect(pedido).toEqual([{ restricted: true, withLinks: true }]);
    expect(pasos).toEqual(['perfil']);
  });

  it('una sesión restringida de equipo lee su rol del token, que es lo único que alcanza', async () => {
    // `app_account` no tiene política en `practitioner`: la reclamación del token es la
    // única vía, y ese valor lo firmó este servidor al entrar leyendo esa misma fila.
    const { caso, pasos } = armar({ perfil: { ...PERFIL, passwordIsTemporary: true } });
    const respuesta = await caso.run({ ...EQUIPO, scope: 'contrasena_temporal' });

    expect({ rol: respuesta.rol, paso: respuesta.siguiente_paso }).toEqual({
      rol: 'recepcion',
      paso: 'contrasena_nueva',
    });
    expect(pasos).toEqual(['perfil']);
  });

  it('una cuenta sin fila que servir es el 500 con la frase del contrato, no una respuesta inventada', async () => {
    const { caso } = armar({ perfil: null });
    const fallo = await errorDe(() => caso.run(PACIENTE));

    expect({ codigo: fallo.code, estado: fallo.status, mensaje: fallo.userMessage }).toEqual({
      codigo: 'fallo_de_servicio',
      estado: 500,
      mensaje: 'No pudimos cargar tu cuenta. El servidor no respondió: puedes volver a intentarlo.',
    });
  });

  it('una cuenta de equipo sin fila de consulta activa no tiene rol, y no se le inventa uno', async () => {
    const { caso } = armar({ hechos: { practitionerRole: null } });
    const fallo = await errorDe(() => caso.run(EQUIPO));

    expect(fallo.code).toBe('fallo_de_servicio');
  });
});
