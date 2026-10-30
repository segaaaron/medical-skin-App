// `POST /v1/accounts/{account_id}/access` · lo que el contrato promete y es fácil romper.
//
// Las dos que importan:
//
//   · el `409 ya_eligio_su_contrasena`, que es lo que impide que una doctora sea dueña del
//     acceso al expediente de una persona adulta;
//   · y que la temporal en claro SOLO viaja por `whatsapp` y por `ninguna`. Por `correo` el
//     correo lo manda MedSkin, y que la doctora la lea no aporta nada y la expone.
//
// Y una de orden: sin celular, el 400 llega ANTES de acuñar. Si llegara después, la doctora
// habría matado la temporal que su paciente ya tenía para recibir un error.

import { describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import type { PasswordHasher } from '../../access/domain/ports';
import { DELIVERY_CHANNELS, type DeliveryFacts } from '../domain/access-delivery';
import type {
  PatientAccessMailPort,
  PatientAccessPort,
  PatientForDelivery,
  ResendLimitPort,
  ResendOutcome,
} from '../domain/ports';
import { PERMISSION, SendPatientAccess, type DeliveryClock } from './send-patient-access';

const AHORA = new Date('2026-10-27T22:24:00.000Z');
const CUENTA_PACIENTE = '99999999-9999-4999-8999-999999999999';

const DOCTORA: Caller = {
  accountId: '11111111-1111-4111-8111-111111111111',
  sessionId: '33333333-3333-4333-8333-333333333333',
  role: 'doctor',
  accountRole: 'doctor',
  scope: 'completo',
  region: 'latam',
  practiceId: '22222222-2222-4222-8222-222222222222',
  permissions: [PERMISSION],
};

const RECEPCION: Caller = { ...DOCTORA, role: 'doctor', permissions: ['pacientes:leer'] };

// Con un envío anterior que SÍ ocurrió: es el caso que hace falso poner nulo al compensar.
const DIA_1 = new Date('2026-08-03T22:24:00.000Z');

const VALERIA: PatientForDelivery = {
  firstName: 'Valeria',
  email: 'valeria.antelo@gmail.com',
  phone: '+59177124408',
  practitionerName: 'Dra. Andrea Paz',
  accessSentAt: DIA_1,
};

function armar(opciones: {
  paciente?: PatientForDelivery | null;
  veredicto?: ResendOutcome;
  demasiados?: boolean;
  correoFalla?: boolean;
  deshacerFalla?: boolean;
}) {
  const pasos: string[] = [];
  const mandados: DeliveryFacts[] = [];
  const restaurados: (Date | null)[] = [];

  const patients: PatientAccessPort = {
    forDelivery: () => {
      pasos.push('ficha:leer');
      return Promise.resolve(opciones.paciente === undefined ? VALERIA : opciones.paciente);
    },
    resend: (p) => {
      pasos.push(`acunar:${p.via}`);
      return Promise.resolve({
        outcome: opciones.veredicto ?? ('acceso_renovado' as const),
        expiresAt: p.expiresAt,
      });
    },
    restoreAccessSentAt: (_owner, _accountId, previous) => {
      pasos.push('marca:deshacer');
      if (opciones.deshacerFalla === true) {
        return Promise.reject(new Error('la marca de envío no se pudo deshacer: 0 filas'));
      }
      restaurados.push(previous);
      return Promise.resolve();
    },
  };

  const passwords: PasswordHasher = {
    verify: () => Promise.resolve(false),
    hash: () => Promise.resolve('$argon2id$temporal'),
  };

  const limit: ResendLimitPort = {
    count: () => {
      pasos.push('contador:reenvio');
      return Promise.resolve({ tooMany: opciones.demasiados ?? false });
    },
  };

  const clock: DeliveryClock = {
    now: () => AHORA,
    localTime: () => '18:24',
    localLongWhen: () => 'viernes 30 a las 18:24',
  };

  // El doble del correo guarda LO QUE SE MANDA, no cuántas veces se le llamó: lo que la
  // prueba afirma es el contenido del mensaje y que exista, no que un espía se activara.
  const mail: PatientAccessMailPort = {
    sendAccess: (facts) => {
      pasos.push('correo:mandar');
      if (opciones.correoFalla === true) {
        // El rechazo de un relé de VERDAD lleva la dirección dentro: «550 5.1.1
        // <carla@…> User unknown». Un doble que rechaza con `ECONNREFUSED` deja pasar una
        // aserción que dice «la causa no lleva el correo» sin comprobar nada.
        return Promise.reject(new Error(`550 5.1.1 <${VALERIA.email}> User unknown`));
      }
      mandados.push(facts);
      return Promise.resolve();
    },
  };

  return {
    caso: new SendPatientAccess(patients, passwords, limit, clock, mail),
    pasos,
    mandados,
    restaurados,
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

describe('POST /v1/accounts/{account_id}/access · quién puede', () => {
  it('recepción no manda accesos, y el permiso se mira antes de leer la ficha', async () => {
    const { caso, pasos } = armar({});
    const error = await errorDe(() => caso.run({ via: 'whatsapp' }, CUENTA_PACIENTE, RECEPCION));

    expect(error.code).toBe('sin_permiso');
    expect(error.status).toBe(403);
    expect(error.userMessage).toBe('Recepción no puede mandar accesos.');
    expect(pasos).toEqual([]);
  });

  it('una cuenta sin vínculo en esta consulta es 404, igual que una inventada', async () => {
    const { caso, pasos } = armar({ paciente: null });
    const error = await errorDe(() => caso.run({ via: 'correo' }, CUENTA_PACIENTE, DOCTORA));

    expect(error.code).toBe('paciente_no_existe');
    expect(error.status).toBe(404);
    // Y no se acuña nada sobre una cuenta que no es de esta consulta.
    expect(pasos).toEqual(['ficha:leer']);
  });
});

describe('POST /v1/accounts/{account_id}/access · la temporal en claro', () => {
  it('por WhatsApp viaja, con el número, el texto y el `wa.me` armado', async () => {
    const { caso } = armar({});
    const bloque = await caso.run({ via: 'whatsapp' }, CUENTA_PACIENTE, DOCTORA);

    expect(bloque.via).toBe('whatsapp');
    expect(bloque.enviado).toBe(false);
    expect(bloque.contrasena_temporal).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
    expect(bloque.caduca_en_texto).toBe('Caduca el viernes 30 a las 18:24');
    // 72 h exactas: «no se negocia por canal».
    expect(bloque.caduca_en).toBe(new Date(AHORA.getTime() + 72 * 3_600_000).toISOString());

    expect(bloque.whatsapp?.numero).toBe('+59177124408');
    expect(bloque.whatsapp?.texto).toContain('soy la Dra. Andrea Paz');
    expect(bloque.whatsapp?.texto).toContain('valeria.antelo@gmail.com');
    expect(bloque.whatsapp?.texto).toContain(bloque.contrasena_temporal as string);
    // El número del `wa.me` va sin `+` y sin signos, y el texto escapado.
    expect(bloque.whatsapp?.url).toContain('https://wa.me/59177124408?text=');
  });

  it('por `ninguna` viaja también —se la da en persona— y no hay bloque de WhatsApp', async () => {
    const { caso } = armar({});
    const bloque = await caso.run({ via: 'ninguna' }, CUENTA_PACIENTE, DOCTORA);

    expect(bloque.contrasena_temporal).not.toBeNull();
    expect(bloque.whatsapp).toBeUndefined();
  });

  it('por `correo` NO viaja: lo manda MedSkin y que la doctora la lea solo la expone', async () => {
    const { caso, mandados } = armar({});
    const bloque = await caso.run({ via: 'correo' }, CUENTA_PACIENTE, DOCTORA);

    expect(bloque.contrasena_temporal).toBeNull();
    expect(bloque.whatsapp).toBeUndefined();
    // La fecha sí: la doctora tiene que poder decirle hasta cuándo vale.
    expect(bloque.caduca_en_texto).toBe('Caduca el viernes 30 a las 18:24');
    // Y SÍ se manda, que es la otra mitad: la temporal está en el correo o en ninguna
    // parte, y lo que la doctora recibe es `enviado: true` de verdad.
    expect(bloque.enviado).toBe(true);
    expect(mandados[0]?.patientEmail).toBe('valeria.antelo@gmail.com');
    expect(mandados[0]?.temporaryPassword).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
  });

  it('el texto del WhatsApp no dice ni un dato clínico', async () => {
    const { caso } = armar({});
    const bloque = await caso.run({ via: 'whatsapp' }, CUENTA_PACIENTE, DOCTORA);
    const texto = (bloque.whatsapp?.texto ?? '').toLowerCase();

    for (const prohibida of ['diagnos', 'alergia', 'embarazo', 'medicacion', 'sesion de', 'foto']) {
      expect(texto, prohibida).not.toContain(prohibida);
    }
  });
});

describe('POST /v1/accounts/{account_id}/access · lo que no se hace', () => {
  it('ya eligió su contraseña: 409 con su nombre, y la doctora no la resetea', async () => {
    const { caso } = armar({ veredicto: 'ya_eligio_su_contrasena' });
    const error = await errorDe(() => caso.run({ via: 'correo' }, CUENTA_PACIENTE, DOCTORA));

    expect(error.code).toBe('ya_eligio_su_contrasena');
    expect(error.status).toBe(409);
    expect(error.userMessage).toContain('Valeria ya eligió su contraseña');
    expect(error.userMessage).toContain('Olvidé mi contraseña');
  });

  it('sin celular y con `via: whatsapp`, el 400 llega ANTES de acuñar', async () => {
    const { caso, pasos } = armar({ paciente: { ...VALERIA, phone: null } });
    const error = await errorDe(() => caso.run({ via: 'whatsapp' }, CUENTA_PACIENTE, DOCTORA));

    expect(error.code).toBe('celular_necesario_para_whatsapp');
    // Lo que importa: la temporal que ya tenía sigue viva, porque no se acuñó otra.
    expect(pasos).not.toContain('acunar:whatsapp');
  });

  it('una `via` que no es ninguna de las tres no acuña nada', async () => {
    const { caso, pasos } = armar({});
    expect((await errorDe(() => caso.run({ via: 'sms' }, CUENTA_PACIENTE, DOCTORA))).code).toBe(
      'via_no_valida',
    );
    expect(pasos).toEqual([]);
  });

  it('si el correo no sale, es 500 con la frase del contrato y no un 200 que miente', async () => {
    const { caso, pasos } = armar({ correoFalla: true });
    const error = await errorDe(() => caso.run({ via: 'correo' }, CUENTA_PACIENTE, DOCTORA));

    expect(error.code).toBe('fallo_de_servicio');
    expect(error.status).toBe(500);
    // La única frase del tramo que admite que algo se perdió, porque se perdió.
    expect(error.userMessage).toBe(
      'No pudimos mandarle el acceso. Su ficha está intacta, pero su contraseña anterior ya no vale: vuelve a mandárselo.',
    );
    // Y la marca de envío se deshace ANTES de contestar: `access_sent_at` solo puede
    // afirmar un envío que ocurrió.
    expect(pasos).toEqual(['ficha:leer', 'contador:reenvio', 'acunar:correo', 'correo:mandar', 'marca:deshacer']);

    // LA CADENA DE CAUSAS, RECORRIDA DE VERDAD. `String(error.cause)` solo renderiza el
    // mensaje del PRIMER eslabón: no mira el `cause` encadenado, así que la aserción
    // anterior pasaba con el correo dentro y no podía fallar nunca.
    const cadena = mensajesDeLaCausa(error);

    // Lo nuestro: la cuenta sí, y ni el correo ni la contraseña. Es lo único que este
    // código escribe, y es lo que esta prueba puede garantizar.
    expect(cadena[0]).toContain(CUENTA_PACIENTE);
    expect(cadena[0]).not.toContain('@');
    expect(cadena[0]).not.toMatch(/[a-z]+-[a-z]+-\d{2}/);

    // Y el rechazo del relé se CONSERVA encadenado, con su texto tal cual: es la causa real
    // y sin ella nadie arregla el relé (§10.3). Que ahí viaje una dirección es un hecho del
    // mensaje del motor, y lo que lo tapa es `service_failure`, que enmascara el correo al
    // escribir la fila —en las dos rutas, con y sin sesión—.
    expect(cadena.at(-1)).toContain('550 5.1.1');
    expect(cadena).toHaveLength(2);
  });

  it('la compensación devuelve la marca a su valor ANTERIOR, no a nulo', async () => {
    // Si el correo salió el día 1 y el reenvío del día 5 falla, poner nulo haría que la
    // consola leyera «nunca se le mandó» de una paciente que sí lo recibió: el mismo
    // defecto de B1 en la otra dirección.
    const conEnvioAnterior = armar({ correoFalla: true });
    await errorDe(() => conEnvioAnterior.caso.run({ via: 'correo' }, CUENTA_PACIENTE, DOCTORA));
    expect(conEnvioAnterior.restaurados).toEqual([DIA_1]);

    // Y la primera vez sí es nulo, porque nulo es lo que había.
    const primeraVez = armar({
      correoFalla: true,
      paciente: { ...VALERIA, accessSentAt: null },
    });
    await errorDe(() => primeraVez.caso.run({ via: 'correo' }, CUENTA_PACIENTE, DOCTORA));
    expect(primeraVez.restaurados).toEqual([null]);
  });

  it('si la compensación también falla, lo dice la causa y sigue siendo el mismo 500', async () => {
    const { caso } = armar({ correoFalla: true, deshacerFalla: true });
    const error = await errorDe(() => caso.run({ via: 'correo' }, CUENTA_PACIENTE, DOCTORA));

    expect(error.code).toBe('fallo_de_servicio');
    // Para la doctora es el mismo hecho; la fila de `service_failure` dice además que la
    // marca quedó puesta, que es lo que alguien tiene que ir a corregir.
    expect(String((error as { cause?: unknown }).cause)).toContain('la marca de envío quedó puesta');
  });

  it('cuando el correo SÍ sale, la marca de envío no se toca', async () => {
    const { caso, pasos } = armar({});
    await caso.run({ via: 'correo' }, CUENTA_PACIENTE, DOCTORA);

    expect(pasos).not.toContain('marca:deshacer');
  });

  it('el cuarto reenvío de la hora es 429 y tampoco acuña', async () => {
    const { caso, pasos } = armar({ demasiados: true });
    const error = await errorDe(() => caso.run({ via: 'correo' }, CUENTA_PACIENTE, DOCTORA));

    expect(error.code).toBe('demasiados_reenvios');
    expect(error.status).toBe(429);
    expect(pasos).not.toContain('acunar:correo');
  });
});

// =========================================================================================
// EL INVARIANTE · es lo que arregla esto para siempre
// =========================================================================================
describe('POST /v1/accounts/{account_id}/access · el invariante de la entrega', () => {
  it('para CADA vía: o se entregó un mensaje, o la contraseña viaja. Nunca ninguna', async () => {
    // Acuñar mata la temporal anterior y devuelve `temp_first_used_at` a nulo, y
    // `medskin_recovery_mint` solo acuña si está estrenada: una vía que no entregue
    // mensaje y no devuelva la contraseña deja fuera para siempre a una paciente que ya
    // entraba, sin aviso y sin salida. Si alguien vuelve a quitar el envío, falla aquí.
    const resultados: Record<string, boolean> = {};

    for (const via of DELIVERY_CHANNELS) {
      const { caso, mandados } = armar({});
      const bloque = await caso.run({ via }, CUENTA_PACIENTE, DOCTORA);

      const seEntrego = bloque.enviado && mandados.length === 1;
      const laContrasenaViaja = bloque.contrasena_temporal !== null;
      resultados[via] = seEntrego !== laContrasenaViaja;
    }

    // `ninguna` cumple con la contraseña en la respuesta: la doctora eligió dársela en
    // persona, y eso es una entrega aunque no pase por ningún relé.
    expect(resultados).toEqual({ correo: true, whatsapp: true, ninguna: true });
  });

  it('el artículo lo pone el título guardado: «soy Andrea Paz», no «soy la Andrea Paz»', async () => {
    const { caso } = armar({ paciente: { ...VALERIA, practitionerName: 'Andrea Paz' } });
    const bloque = await caso.run({ via: 'whatsapp' }, CUENTA_PACIENTE, DOCTORA);

    expect(bloque.whatsapp?.texto).toContain('soy Andrea Paz');
    expect(bloque.whatsapp?.texto).not.toContain('soy la Andrea Paz');
  });
});

/**
 * Los mensajes de toda la cadena de causas, del primero al último. Es lo que
 * `FailureLog.causeChain()` recorre para escribir `cause_chain`, y por eso una prueba que
 * dice «la causa no lleva el correo» tiene que recorrer lo mismo: `String(un Error)` no
 * renderiza su `cause`, así que afirmarlo sobre la cadena entera es lo único que puede
 * fallar cuando alguien meta el correo en un mensaje nuestro.
 */
function mensajesDeLaCausa(error: unknown): string[] {
  const mensajes: string[] = [];
  let actual: unknown = error instanceof Error ? error.cause : undefined;
  for (let i = 0; i < 5 && actual instanceof Error; i += 1) {
    mensajes.push(actual.message);
    actual = actual.cause;
  }
  return mensajes;
}
