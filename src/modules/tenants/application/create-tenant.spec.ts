// `POST /v1/platform/tenants` · la única puerta de una doctora al sistema.
//
// Lo que se fija aquí:
//   · el 201 completo, con la temporal y su caducidad, y `licencia.estado = "sin_enviar"`;
//   · `email_taken` es el `409` del contrato y los otros dos veredictos son 500 con su causa;
//   · el correo del alta que falla NO tira el alta: deja una fila de fallo y el 201 sale;
//   · el reintento idempotente devuelve la misma respuesta y NO manda un segundo correo.

import { describe, expect, it } from 'vitest';

import { ServiceFailure } from '../../../shared/contract/error-catalog';
import type {
  Admission,
  AdmissionVerdict,
  CreatedTenant,
  PlatformActor,
} from '../domain/platform-ports';
import { CreateTenant, type CreatedTenantResponse } from './create-tenant';

const ACTOR: PlatformActor = {
  subject: '99999999-9999-4999-8999-999999999999',
  label: 'Soporte MedSkin',
  region: 'latam',
};

const TRACE = { traceId: 'traza-1', requestId: 'peticion-1' };

const CUERPO = {
  nombre: 'Clínica Paz',
  region: 'latam',
  pais: 'BO',
  zona_horaria: 'America/La_Paz',
  moneda: 'BOB',
  plan: 'consultorio',
  doctora: { nombre: 'Andrea', apellido: 'Paz', correo: 'andrea.paz@clinicapaz.bo' },
};

const CREADO: CreatedTenant = {
  practiceId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  createdAt: new Date('2026-10-27T13:12:00Z'),
};

type Opciones = {
  verdict?: AdmissionVerdict;
  replayed?: boolean;
  mailFalla?: boolean;
};

function armar(opciones: Opciones = {}) {
  const verdict = opciones.verdict ?? 'created';
  const enviados: { email: string; temporaryPassword: string }[] = [];
  const registrados: { accountId: string; practiceId: string; traceId: string }[] = [];
  const hasheadas: string[] = [];

  const tenants = {
    create: <T>(p: { respond: (created: CreatedTenant) => T }): Promise<Admission<T>> => {
      if (verdict !== 'created') {
        return Promise.resolve({ verdict, served: null } as Admission<T>);
      }
      return Promise.resolve({
        verdict: 'created',
        served: {
          replayed: opciones.replayed ?? false,
          status: opciones.replayed ? 200 : 201,
          response: p.respond(CREADO),
        },
      });
    },
  };

  const caso = new CreateTenant(
    tenants,
    {
      hash: (password: string) => {
        hasheadas.push(password);
        return Promise.resolve(`$argon2id$v=19$m=65536,p=4,t=3$c2FsYWRh$${password.length}`);
      },
      verify: () => Promise.resolve(false),
    },
    { now: () => new Date('2026-10-27T13:12:00Z'), localLongWhen: () => 'viernes 30 a las 09:12' },
    {
      sendOwnerWelcome: (facts: { email: string; temporaryPassword: string }) => {
        enviados.push({ email: facts.email, temporaryPassword: facts.temporaryPassword });
        return opciones.mailFalla === true
          ? Promise.reject(new Error('el relé no contestó'))
          : Promise.resolve();
      },
    },
    {
      record: (p: { accountId: string; practiceId: string; traceId: string }) => {
        registrados.push({
          accountId: p.accountId,
          practiceId: p.practiceId,
          traceId: p.traceId,
        });
        return Promise.resolve();
      },
    },
    'latam',
  );

  return { caso, enviados, registrados, hasheadas };
}

const CLAVE = { key: 'consola-caso', bodyHash: 'huella-caso' };

describe('POST /v1/platform/tenants', () => {
  it('crea la consulta y devuelve el 201 con la temporal una sola vez', async () => {
    const { caso, enviados, hasheadas } = armar();

    const served = await caso.run(CUERPO, ACTOR, CLAVE, TRACE);
    const respuesta: CreatedTenantResponse = served.response;

    expect(served.status).toBe(201);
    expect(served.replayed).toBe(false);
    expect(respuesta).toEqual({
      id: CREADO.practiceId,
      nombre: 'Clínica Paz',
      region: 'latam',
      plan: { clave: 'consultorio', limite_pacientes: 300, pacientes: 0 },
      licencia: { estado: 'sin_enviar' },
      creado_en: '2026-10-27T13:12:00.000Z',
      doctora: {
        cuenta_id: CREADO.accountId,
        correo: 'andrea.paz@clinicapaz.bo',
        contrasena_temporal: respuesta.doctora.contrasena_temporal,
        // 72 h desde el alta, y la cota la comprueba además la base.
        contrasena_temporal_caduca_en: '2026-10-30T13:12:00.000Z',
      },
    });
    // La forma del contrato, `tejado-lila-07`: se dicta por teléfono.
    expect(respuesta.doctora.contrasena_temporal).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
    // Lo que viaja a la base es el HASH de esa misma contraseña, nunca la contraseña.
    expect(hasheadas).toEqual([respuesta.doctora.contrasena_temporal]);
    // Y el correo del alta sale en el mismo acto, con la temporal dentro.
    expect(enviados).toEqual([
      {
        email: 'andrea.paz@clinicapaz.bo',
        temporaryPassword: respuesta.doctora.contrasena_temporal,
      },
    ]);
  });

  it('el correo ya tomado es el `409` del contrato, y ese sí revela que existe', async () => {
    const { caso, enviados } = armar({ verdict: 'email_taken' });

    await expect(caso.run(CUERPO, ACTOR, CLAVE, TRACE)).rejects.toMatchObject({
      code: 'correo_ya_tiene_cuenta',
      status: 409,
      userMessage:
        'Ese correo ya tiene una cuenta en MedSkin. Busca la consulta antes de crear otra.',
    });
    // Nada de correos: no se creó ninguna cuenta a la que escribirle.
    expect(enviados).toEqual([]);
  });

  it('los dos veredictos que el contrato no nombra son 500 con su causa', async () => {
    for (const verdict of ['practice_has_owner', 'practice_not_found'] as const) {
      const fallo = await armar({ verdict })
        .caso.run(CUERPO, ACTOR, CLAVE, TRACE)
        .catch((failure: unknown) => failure);

      expect(fallo).toBeInstanceOf(ServiceFailure);
      expect((fallo as ServiceFailure).body().error.mensaje).toBe(
        'No pudimos crear la consulta. El servidor no respondió. No se creó nada: puedes volver a intentarlo.',
      );
      expect(String((fallo as ServiceFailure).cause)).toContain(verdict);
    }
  });

  it('si el correo falla, la consulta QUEDA CREADO y el fallo se registra', async () => {
    const { caso, registrados } = armar({ mailFalla: true });

    // El 201 sale: la frase del 500 de este endpoint promete «no se creó nada», y decirlo
    // cuando la consulta ya existe sería mentirle a quien da el alta. Su salida es la
    // contraseña del 201, que puede leer y dictar.
    const served = await caso.run(CUERPO, ACTOR, CLAVE, TRACE);
    expect(served.status).toBe(201);
    expect(served.response.doctora.contrasena_temporal).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);

    // Y la fila del fallo va con la cuenta y la consulta recién creadas, más la traza.
    expect(registrados).toEqual([
      { accountId: CREADO.accountId, practiceId: CREADO.practiceId, traceId: 'traza-1' },
    ]);
  });

  it('el reintento con la misma clave repite la respuesta y NO manda un segundo correo', async () => {
    const { caso, enviados } = armar({ replayed: true });

    const served = await caso.run(CUERPO, ACTOR, { key: 'k-1', bodyHash: 'h-1' }, TRACE);
    expect(served.replayed).toBe(true);
    expect(served.status).toBe(200);
    // El alta ya ocurrió y el correo ya salió: mandar otro sería un segundo correo con una
    // contraseña que ya no es la que vale.
    expect(enviados).toEqual([]);
  });

  it('un cuerpo mal formado no llega a la base ni acuña ninguna contraseña', async () => {
    const { caso, hasheadas } = armar();

    await expect(caso.run({ ...CUERPO, nombre: '' }, ACTOR, CLAVE, TRACE)).rejects.toMatchObject({
      code: 'nombre_vacio',
      status: 400,
    });
    expect(hasheadas).toEqual([]);
  });
});
