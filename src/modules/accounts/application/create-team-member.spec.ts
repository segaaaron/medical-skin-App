// `POST /v1/equipo` · el alta de recepción o de un asistente clínico.
//
// Lo que se fija aquí:
//   · UN SOLO `409` para las dos causas del correo tomado —ya está en este equipo, o ese
//     correo tiene cuenta en la región—, y una frase que no confirma ninguna: dos códigos
//     serían el oráculo del padrón que §12.2.1 cierra;
//   · el rol se comprueba ANTES del correo, así que un cuerpo mal formado no llega a nombrar
//     un correo y no se puede usar el 400 para medir nada;
//   · por correo la temporal NO viaja en la respuesta y sí va en el mensaje: el invariante
//     del acceso es que o se entrega un mensaje, o la contraseña viaja, nunca ninguna;
//   · el relé caído no es un 200 que miente, y su frase no dice «vuelve a intentarlo»,
//     porque reintentar el alta daría `409 correo_no_disponible`.

import { describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import type { PasswordHasher } from '../../access/domain/ports';
import type { TeamDeliveryFacts } from '../domain/access-delivery';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import type {
  IdempotencyCompletionPort,
  TeamAccessMailPort,
  TeamMemberCreation,
  TeamPort,
} from '../domain/ports';
import { TEAM_PERMISSION } from '../domain/team';
import { CreateTeamMember } from './create-team-member';
import type { DeliveryClock } from './send-patient-access';

const AHORA = new Date('2026-10-27T22:24:00.000Z');

const DUENA: Caller = {
  accountId: '11111111-1111-4111-8111-111111111111',
  sessionId: '33333333-3333-4333-8333-333333333333',
  role: 'doctora',
  accountRole: 'practitioner',
  scope: 'completo',
  region: 'latam',
  practiceId: '22222222-2222-4222-8222-222222222222',
  permissions: [TEAM_PERMISSION],
};

const CLAVE: IdempotencyRecord = { key: '7f8e9d10-2222-4222-8222-222222222222', bodyHash: 'huella' };

const CREADA: TeamMemberCreation = {
  verdict: 'created',
  accountId: '44444444-4444-4444-8444-444444444444',
  practitionerId: '55555555-5555-4555-8555-555555555555',
  practiceName: 'Clínica Paz',
  replay: null,
};

const CUERPO = {
  nombre: ' Rosa ',
  apellido: ' Mamani ',
  correo: 'Rosa.Mamani@gmail.com',
  rol: 'recepcion',
};

function armar(opciones: { creacion?: TeamMemberCreation; releCaido?: boolean } = {}) {
  const pasos: string[] = [];
  const cerradas: { status: number; response: unknown }[] = [];
  const enviados: TeamDeliveryFacts[] = [];
  let recibido: Record<string, unknown> | null = null;

  const team: TeamPort = {
    create: (p) => {
      pasos.push('base');
      recibido = { ...p, owner: undefined };
      return Promise.resolve(opciones.creacion ?? CREADA);
    },
  };

  const passwords: PasswordHasher = {
    verify: () => Promise.reject(new Error('este endpoint no compara contraseñas')),
    hash: (password: string) => {
      pasos.push('argon2:hashear');
      return Promise.resolve(`$argon2id$${password}`);
    },
  };

  const clock: DeliveryClock = {
    now: () => AHORA,
    localTime: () => '18:24',
    localLongWhen: () => 'viernes 30 a las 18:24',
  };

  const mail: TeamAccessMailPort = {
    sendTeamAccess: (facts) => {
      pasos.push('correo');
      if (opciones.releCaido === true) {
        return Promise.reject(new Error('ECONNREFUSED 127.0.0.1:1025'));
      }
      enviados.push(facts);
      return Promise.resolve();
    },
  };

  const idempotency: IdempotencyCompletionPort = {
    complete: (p) => {
      pasos.push('clave:cerrar');
      cerradas.push({ status: p.status, response: p.response });
      return Promise.resolve();
    },
  };

  return {
    caso: new CreateTeamMember(team, passwords, clock, mail, idempotency),
    pasos,
    enviados,
    cerradas,
    recibido: () => recibido,
  };
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

describe('POST /v1/equipo', () => {
  it('da de alta a recepción, le manda su acceso y no devuelve la contraseña', async () => {
    const { caso, pasos, enviados, recibido } = armar();
    const respuesta = await caso.run(CUERPO, DUENA, CLAVE);

    expect(respuesta).toEqual({
      miembro_id: CREADA.practitionerId,
      cuenta_id: CREADA.accountId,
      nombre_completo: 'Rosa Mamani',
      rol: 'recepcion',
      acceso: {
        via: 'correo',
        enviado: true,
        // El correo lo manda MedSkin: que la dueña la lea no aporta nada y la expone.
        contrasena_temporal: null,
        caduca_en: new Date(AHORA.getTime() + 72 * 3600_000).toISOString(),
        caduca_en_texto: 'Caduca el viernes 30 a las 18:24',
      },
    });

    // El nombre llega recortado y el correo en minúsculas —la columna es `citext`, y la
    // clave de todo lo demás también—, y la temporal va HASHEADA a la base.
    expect(recibido()).toMatchObject({
      email: 'rosa.mamani@gmail.com',
      firstName: 'Rosa',
      lastName: 'Mamani',
      role: 'recepcion',
    });
    expect(String(recibido()?.hash).startsWith('$argon2id$')).toBe(true);

    // Y la contraseña en claro solo existe en el mensaje, que es la otra mitad del
    // invariante: o se entrega un mensaje, o la contraseña viaja en la respuesta.
    expect(enviados[0]).toMatchObject({
      firstName: 'Rosa',
      email: 'rosa.mamani@gmail.com',
      practiceName: 'Clínica Paz',
      expiryText: 'Caduca el viernes 30 a las 18:24',
    });
    expect(enviados[0]?.temporaryPassword).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);

    expect(pasos).toEqual(['argon2:hashear', 'base', 'correo', 'clave:cerrar']);
  });

  it('la repetición devuelve la respuesta guardada: ni segunda cuenta ni segundo correo', async () => {
    const guardada = { miembro_id: 'prt', cuenta_id: 'cta', nombre_completo: 'Rosa Mamani' };
    const { caso, pasos, enviados } = armar({
      creacion: {
        verdict: 'replayed',
        accountId: null,
        practitionerId: null,
        practiceName: null,
        replay: { status: 201, response: guardada },
      },
    });

    expect(await caso.run(CUERPO, DUENA, CLAVE)).toEqual(guardada);
    expect(enviados).toEqual([]);
    expect(pasos).toEqual(['argon2:hashear', 'base']);
  });

  it('un correo tomado da un solo 409 y una frase que no dice por qué', async () => {
    const { caso } = armar({
      creacion: { verdict: 'email_taken', accountId: null, practitionerId: null, practiceName: null, replay: null },
    });
    const fallo = await errorDe(() => caso.run(CUERPO, DUENA, CLAVE));

    expect({ codigo: fallo.code, estado: fallo.status, mensaje: fallo.userMessage }).toEqual({
      codigo: 'correo_no_disponible',
      estado: 409,
      mensaje:
        'Ese correo no se puede usar para el equipo. Dale de alta con otro correo suyo, o escríbenos a hola@medskin.app.',
    });
    // La frase no nombra ninguna de las dos causas, y eso es el punto: no hay cómo saber si
    // ese correo es de alguien de este equipo o de una paciente de otra clínica.
    expect(fallo.data).toBeUndefined();
  });

  it('quien no es la dueña no da de alta a nadie, y lo dice la base', async () => {
    const { caso } = armar({
      creacion: { verdict: 'not_owner', accountId: null, practitionerId: null, practiceName: null, replay: null },
    });
    const fallo = await errorDe(() => caso.run(CUERPO, DUENA, CLAVE));

    expect({ codigo: fallo.code, estado: fallo.status }).toEqual({
      codigo: 'sin_permiso',
      estado: 403,
    });
  });

  it('sin el permiso no se toca la base', async () => {
    const { caso, pasos } = armar();
    const fallo = await errorDe(() => caso.run(CUERPO, { ...DUENA, permissions: [] }, CLAVE));

    expect(fallo.code).toBe('sin_permiso');
    expect(pasos).toEqual([]);
  });

  it('un rol que no se asigna desde aquí es 400, y se comprueba antes del correo', async () => {
    const { caso, pasos } = armar();
    for (const rol of ['duena', 'paciente', 'doctora', undefined]) {
      const fallo = await errorDe(() => caso.run({ ...CUERPO, rol, correo: 'no-es-un-correo' }, DUENA, CLAVE));
      expect({ rol, codigo: fallo.code, campo: fallo.field }).toEqual({
        rol,
        codigo: 'rol_no_asignable',
        campo: 'rol',
      });
    }
    expect(pasos).toEqual([]);
  });

  it('el nombre y el apellido son obligatorios, y el correo tiene la frase de este endpoint', async () => {
    const { caso } = armar();
    const sinNombre = await errorDe(() => caso.run({ ...CUERPO, nombre: '  ' }, DUENA, CLAVE));
    expect({ codigo: sinNombre.code, campo: sinNombre.field }).toEqual({
      codigo: 'nombre_vacio',
      campo: 'nombre',
    });

    const sinCorreo = await errorDe(() => caso.run({ ...CUERPO, correo: '' }, DUENA, CLAVE));
    expect({ codigo: sinCorreo.code, mensaje: sinCorreo.userMessage }).toEqual({
      codigo: 'correo_vacio',
      mensaje: 'Hace falta su correo: es por donde le llega su contraseña.',
    });

    const malEscrito = await errorDe(() => caso.run({ ...CUERPO, correo: 'rosa@' }, DUENA, CLAVE));
    expect(malEscrito.code).toBe('correo_mal_escrito');
  });

  it('el relé caído es un 500 que admite que la cuenta ya existe y manda a reenviar', async () => {
    const { caso } = armar({ releCaido: true });
    const fallo = await errorDe(() => caso.run(CUERPO, DUENA, CLAVE));

    expect({ codigo: fallo.code, estado: fallo.status, mensaje: fallo.userMessage }).toEqual({
      codigo: 'fallo_de_servicio',
      estado: 500,
      // Ya no manda a soporte: desde que existe `POST /v1/equipo/{miembro_id}/acceso` hay
      // una salida dentro del producto, y la frase la nombra en vez de prometer un reintento
      // del alta que daría `409 correo_no_disponible`.
      mensaje:
        'No pudimos mandarle el acceso. Su cuenta ya está creada, así que no la vuelvas a dar de alta: vuelve a mandárselo.',
    });
    expect(fallo.userMessage).not.toContain('hola@medskin.app');
    // Ni el correo ni la contraseña en la causa que acaba en `service_failure`: solo la
    // cuenta, y la del relé encadenada.
    expect(String((fallo as { cause?: unknown }).cause)).not.toContain('rosa.mamani');
  });
});
