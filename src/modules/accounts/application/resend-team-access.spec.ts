// `POST /v1/team/{member_id}/access` · el endpoint que cierra el hueco del alta.
//
// Lo que se fija aquí:
//   · el ORDEN: el miembro se busca antes de acuñar y antes de gastar contador, porque un
//     `miembro_id` equivocado no puede matarle la temporal a nadie para devolver un 404;
//   · el `404` es uno solo para las cuatro situaciones del contrato —no es de esta consulta,
//     retirada, cuenta borrada, o es la de quien llama— y no gasta contador;
//   · la contraseña NO viaja en la respuesta y SÍ va en el mensaje: por correo lo manda
//     MedSkin, y que la dueña la lea no aporta nada y expone la credencial de otra persona;
//   · el `429` cuenta por la CUENTA DE DESTINO, que es la misma clave del reenvío de
//     pacientes: las tres por hora cuentan igual venga de donde venga;
//   · el `500` del relé caído admite que la anterior ya no vale y NO nombra ninguna ficha.

import { describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import type { PasswordHasher } from '../../access/domain/ports';
import type { TeamDeliveryFacts } from '../domain/access-delivery';
import type {
  ResendLimitPort,
  TeamAccessMailPort,
  TeamAccessPort,
  TeamMemberForDelivery,
  TeamResendOutcome,
} from '../domain/ports';
import { TEAM_PERMISSION } from '../domain/team';
import { ResendTeamAccess } from './resend-team-access';
import type { DeliveryClock } from './send-patient-access';

const AHORA = new Date('2026-10-28T22:24:00.000Z');
const MIEMBRO = '55555555-5555-4555-8555-555555555555';
const CUENTA_MIEMBRO = '44444444-4444-4444-8444-444444444444';

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

const ROSA: TeamMemberForDelivery = {
  accountId: CUENTA_MIEMBRO,
  firstName: 'Rosa',
  practiceName: 'Clínica Paz',
};

const CORREO_DE_ROSA = 'rosa.mamani@gmail.com';

function armar(
  opciones: {
    miembro?: TeamMemberForDelivery | null;
    veredicto?: TeamResendOutcome;
    correo?: string | null;
    demasiados?: boolean;
    releCaido?: boolean;
  } = {},
) {
  const pasos: string[] = [];
  const contados: string[] = [];
  const mandados: TeamDeliveryFacts[] = [];
  let recibido: Record<string, unknown> | null = null;

  const team: TeamAccessPort = {
    forDelivery: () => {
      pasos.push('miembro:leer');
      return Promise.resolve(opciones.miembro === undefined ? ROSA : opciones.miembro);
    },
    resend: (p) => {
      pasos.push('acunar');
      recibido = { ...p, owner: undefined };
      const outcome = opciones.veredicto ?? 'acceso_renovado';
      return Promise.resolve({
        outcome,
        // Los tres veredictos que no renuevan vuelven sin correo: no se filtra el de nadie
        // por un 403 ni por un 404.
        email:
          outcome === 'acceso_renovado'
            ? (opciones.correo === undefined ? CORREO_DE_ROSA : opciones.correo)
            : null,
      });
    },
  };

  const passwords: PasswordHasher = {
    verify: () => Promise.reject(new Error('este endpoint no compara contraseñas')),
    hash: (password: string) => {
      pasos.push('argon2:hashear');
      return Promise.resolve(`$argon2id$${password}`);
    },
  };

  const limit: ResendLimitPort = {
    count: (accountId: string) => {
      pasos.push('contador:reenvio');
      contados.push(accountId);
      return Promise.resolve({ tooMany: opciones.demasiados ?? false });
    },
  };

  const clock: DeliveryClock = {
    now: () => AHORA,
    localTime: () => '18:24',
    localLongWhen: () => 'sábado 31 a las 18:24',
  };

  const mail: TeamAccessMailPort = {
    sendTeamAccess: (facts) => {
      pasos.push('correo:mandar');
      if (opciones.releCaido === true) {
        // Como rechaza un relé de verdad: con la dirección dentro.
        return Promise.reject(new Error(`550 5.1.1 <${CORREO_DE_ROSA}> User unknown`));
      }
      mandados.push(facts);
      return Promise.resolve();
    },
  };

  return {
    caso: new ResendTeamAccess(team, passwords, limit, clock, mail),
    pasos,
    contados,
    mandados,
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

function mensajesDeLaCausa(error: unknown): string[] {
  const mensajes: string[] = [];
  let actual: unknown = error instanceof Error ? error.cause : undefined;
  for (let i = 0; i < 5 && actual instanceof Error; i += 1) {
    mensajes.push(actual.message);
    actual = actual.cause;
  }
  return mensajes;
}

describe('POST /v1/team/{member_id}/access', () => {
  it('acuña una temporal nueva, se la manda por correo y no la devuelve', async () => {
    const { caso, pasos, contados, mandados, recibido } = armar();
    const bloque = await caso.run(MIEMBRO, DUENA);

    expect(bloque).toEqual({
      via: 'correo',
      enviado: true,
      contrasena_temporal: null,
      caduca_en: new Date(AHORA.getTime() + 72 * 3600_000).toISOString(),
      caduca_en_texto: 'Caduca el sábado 31 a las 18:24',
    });

    // La contraseña en claro solo existe en el mensaje, y el mensaje va al correo que
    // devolvió la base: es el dato que este rol no puede leer de `account`.
    expect(mandados[0]).toMatchObject({
      firstName: 'Rosa',
      email: CORREO_DE_ROSA,
      practiceName: 'Clínica Paz',
      expiryText: 'Caduca el sábado 31 a las 18:24',
    });
    expect(mandados[0]?.temporaryPassword).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);

    // A la base va HASHEADA, y con el identificador del miembro que vino en la URL.
    expect(String(recibido()?.hash).startsWith('$argon2id$')).toBe(true);
    expect(recibido()).toMatchObject({ practitionerId: MIEMBRO, accountId: CUENTA_MIEMBRO });

    // El contador va por la CUENTA DEL MIEMBRO, no por la de quien llama ni por el
    // `miembro_id`: es la misma clave que usa el reenvío de pacientes.
    expect(contados).toEqual([CUENTA_MIEMBRO]);

    // Y el orden: leer, contar, hashear, acuñar, mandar.
    expect(pasos).toEqual([
      'miembro:leer',
      'contador:reenvio',
      'argon2:hashear',
      'acunar',
      'correo:mandar',
    ]);
  });

  it('un miembro que no está en esta consulta es 404, sin acuñar y sin gastar contador', async () => {
    const { caso, pasos } = armar({ miembro: null });
    const fallo = await errorDe(() => caso.run(MIEMBRO, DUENA));

    expect({ codigo: fallo.code, estado: fallo.status, mensaje: fallo.userMessage }).toEqual({
      codigo: 'miembro_no_existe',
      estado: 404,
      mensaje: 'Esa persona no está en tu equipo.',
    });
    // Ni contador ni acuñación: un `miembro_id` equivocado no le mata la temporal a nadie.
    expect(pasos).toEqual(['miembro:leer']);
  });

  it('el 404 de la base es el mismo 404, y tampoco dice otra cosa', async () => {
    // Si la fila desaparece entre la lectura y la acuñación, o si es la de quien llama y
    // solo la función lo ve: el mismo código y la misma frase.
    const { caso } = armar({ veredicto: 'member_not_found' });
    const fallo = await errorDe(() => caso.run(MIEMBRO, DUENA));

    expect(fallo.code).toBe('miembro_no_existe');
  });

  it('quien no es la dueña no manda accesos al equipo, y lo dice la base', async () => {
    const { caso } = armar({ veredicto: 'not_owner' });
    const fallo = await errorDe(() => caso.run(MIEMBRO, DUENA));

    expect({ codigo: fallo.code, estado: fallo.status, mensaje: fallo.userMessage }).toEqual({
      codigo: 'sin_permiso',
      estado: 403,
      mensaje: 'Solo la dueña de la consulta puede mandar accesos al equipo.',
    });
  });

  it('sin el permiso no se toca la base', async () => {
    const { caso, pasos } = armar();
    const fallo = await errorDe(() => caso.run(MIEMBRO, { ...DUENA, permissions: [] }));

    expect(fallo.code).toBe('sin_permiso');
    expect(pasos).toEqual([]);
  });

  it('a quien ya eligió su contraseña no se le reenvía nada', async () => {
    const { caso, pasos } = armar({ veredicto: 'ya_eligio_su_contrasena' });
    const fallo = await errorDe(() => caso.run(MIEMBRO, DUENA));

    expect({ codigo: fallo.code, estado: fallo.status, mensaje: fallo.userMessage }).toEqual({
      codigo: 'ya_eligio_su_contrasena',
      estado: 409,
      // La frase de ESTE endpoint, la del contrato, sin el nombre: la de pacientes lo lleva
      // porque su pantalla lo necesita, y aquí la dueña ya sabe a quién le dio.
      mensaje: 'Ya eligió su contraseña. Dile que use «Olvidé mi contraseña».',
    });
    // Y no se le mandó ningún correo con una temporal que no vale.
    expect(pasos).not.toContain('correo:mandar');
  });

  it('más de tres en una hora para la misma cuenta es 429, antes de acuñar', async () => {
    const { caso, pasos } = armar({ demasiados: true });
    const fallo = await errorDe(() => caso.run(MIEMBRO, DUENA));

    expect({ codigo: fallo.code, estado: fallo.status }).toEqual({
      codigo: 'demasiados_reenvios',
      estado: 429,
    });
    expect(pasos).toEqual(['miembro:leer', 'contador:reenvio']);
  });

  it('el relé caído es un 500 que admite que la anterior ya no vale, y no nombra ninguna ficha', async () => {
    const { caso } = armar({ releCaido: true });
    const fallo = await errorDe(() => caso.run(MIEMBRO, DUENA));

    expect({ codigo: fallo.code, estado: fallo.status, mensaje: fallo.userMessage }).toEqual({
      codigo: 'fallo_de_servicio',
      estado: 500,
      mensaje:
        'No pudimos mandarle el acceso. Su contraseña anterior ya no vale: vuelve a mandárselo.',
    });
    expect(fallo.userMessage).not.toContain('ficha');

    // La causa que se registra: la cadena recorrida de verdad. Lo nuestro lleva la cuenta y
    // ni el correo ni la temporal; el rechazo del relé se conserva encadenado, y es
    // `service_failure` quien enmascara la dirección al escribir la fila.
    const cadena = mensajesDeLaCausa(fallo);
    expect(cadena[0]).toContain(CUENTA_MIEMBRO);
    expect(cadena[0]).not.toContain('@');
    expect(cadena[0]).not.toMatch(/[a-z]+-[a-z]+-\d{2}/);
    expect(cadena.at(-1)).toContain('550 5.1.1');
  });

  it('un acceso renovado sin correo es un 500, no un 202 que no mandó nada', async () => {
    const { caso, pasos } = armar({ correo: null });
    const fallo = await errorDe(() => caso.run(MIEMBRO, DUENA));

    expect(fallo.code).toBe('fallo_de_servicio');
    expect(pasos).not.toContain('correo:mandar');
  });
});
