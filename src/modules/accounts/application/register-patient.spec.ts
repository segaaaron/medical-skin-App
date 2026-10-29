// `POST /v1/patients` · el alta de una paciente, que es la única puerta de una paciente al
// sistema y el endpoint más cargado del tramo.
//
// Lo que se fija aquí, regla por regla:
//   · el alta sale por correo O por WhatsApp, y la temporal viaja en la respuesta SOLO en
//     las vías que MedSkin no manda —whatsapp y ninguna—: por correo va en nulo porque lo
//     manda MedSkin, y es el invariante de que o se entrega un mensaje, o viaja la clave;
//   · MedSkin no manda nada por WhatsApp: `enviado: false` y un `wa.me` armado;
//   · recepción no crea pacientes, y el permiso sale de la lista del token;
//   · `null` y `false` no son lo mismo en los antecedentes, y cada campo contestado guarda
//     `fuente: doctora`;
//   · ningún 400 toca la base ni gasta el límite de altas;
//   · quien ya tiene cuenta no recibe temporal ninguna y su texto no la nombra;
//   · el relé caído es un 500 que admite lo que se perdió, deshace la marca de envío y no
//     deja ni el correo ni la contraseña en la causa que acaba en `service_failure`.

import { describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import type { Caller } from '../../access/application/caller';
import type { PasswordHasher } from '../../access/domain/ports';
import type { DeliveryFacts, LinkNoticeFacts } from '../domain/access-delivery';
import { PATIENT_CREATE_PERMISSION } from '../domain/patient-registration';
import type {
  IdempotencyCompletionPort,
  PatientAccessMailPort,
  PatientCreationLimitPort,
  PatientLinkNoticeMailPort,
  PatientRegistration,
  PatientRegistrationPort,
} from '../domain/ports';
import { RegisterPatient, type RegistrationClock } from './register-patient';

const AHORA = new Date('2026-10-28T22:24:00.000Z');
const EN_72H = new Date(AHORA.getTime() + 72 * 3600_000);

const CONSULTA = '22222222-2222-4222-8222-222222222222';
const FICHA = '66666666-6666-4666-8666-666666666666';
const CUENTA_PACIENTE = '44444444-4444-4444-8444-444444444444';

const DOCTORA: Caller = {
  accountId: '11111111-1111-4111-8111-111111111111',
  sessionId: '33333333-3333-4333-8333-333333333333',
  role: 'doctora',
  accountRole: 'practitioner',
  scope: 'completo',
  region: 'latam',
  practiceId: CONSULTA,
  permissions: [PATIENT_CREATE_PERMISSION],
};

const CLAVE: IdempotencyRecord = { key: '7f8e9d10-1111-4111-8111-111111111111', bodyHash: 'huella' };

const CREADA: PatientRegistration = {
  verdict: 'created',
  patientId: FICHA,
  accountId: CUENTA_PACIENTE,
  accountAlreadyExisted: false,
  patientLimit: null,
  duplicate: null,
  practitionerName: 'Dra. Andrea Paz',
  replay: null,
};

const CUERPO = {
  nombre: ' Valeria ',
  apellido: ' Antelo ',
  nacimiento: '1992-04-18',
  correo: 'Valeria.Antelo@gmail.com',
  celular: '+591 77124408',
  tiene_whatsapp: true,
  recordatorios_por: 'ambas',
  como_llego: 'instagram',
  enviar_acceso_por: 'whatsapp',
  antes_de_atenderla: {
    alergias: { tiene: true, cuales: ['lidocaína', 'penicilina'] },
    medicacion: { toma: false },
    embarazo_o_lactancia: 'ninguno',
    fototipo: 3,
    notas: 'Pide empezar por la zona periocular.',
  },
};

type Opciones = {
  registro?: PatientRegistration;
  releCaido?: boolean;
  compensacionCaida?: boolean;
  demasiadas?: boolean;
  cierreCaido?: boolean;
};

function armar(opciones: Opciones = {}) {
  const pasos: string[] = [];
  const enviados: DeliveryFacts[] = [];
  const avisados: LinkNoticeFacts[] = [];
  const marcas: (Date | null)[] = [];
  const cerradas: { status: number; response: unknown }[] = [];
  let recibido: Record<string, unknown> | null = null;

  const patients: PatientRegistrationPort = {
    register: (p) => {
      pasos.push('base');
      recibido = { ...p, owner: p.owner.practiceId };
      return Promise.resolve(opciones.registro ?? CREADA);
    },
    markAccessSent: (_owner, _patientId, sentAt) => {
      pasos.push('deshacer-marca');
      if (opciones.compensacionCaida === true) {
        return Promise.reject(new Error('la fila del vínculo no apareció'));
      }
      marcas.push(sentAt);
      return Promise.resolve();
    },
  };

  const idempotency: IdempotencyCompletionPort = {
    complete: (p) => {
      pasos.push('clave:cerrar');
      if (opciones.cierreCaido === true) {
        return Promise.reject(new Error('la fila de la clave no apareció'));
      }
      cerradas.push({ status: p.status, response: p.response });
      return Promise.resolve();
    },
  };

  const passwords: PasswordHasher = {
    verify: () => Promise.reject(new Error('este endpoint no compara contraseñas')),
    hash: (password: string) => {
      pasos.push('argon2:hashear');
      return Promise.resolve(`$argon2id$${password}`);
    },
  };

  const limit: PatientCreationLimitPort = {
    count: () => {
      pasos.push('limite');
      return Promise.resolve({ tooMany: opciones.demasiadas === true });
    },
  };

  const clock: RegistrationClock = {
    now: () => AHORA,
    localTime: () => '18:24',
    localLongWhen: () => 'sábado 31 a las 18:24',
    localDay: () => '3 de agosto',
  };

  const mail: PatientAccessMailPort & PatientLinkNoticeMailPort = {
    sendAccess: (facts) => {
      pasos.push('correo');
      if (opciones.releCaido === true) {
        return Promise.reject(new Error('ECONNREFUSED 127.0.0.1:1025'));
      }
      enviados.push(facts);
      return Promise.resolve();
    },
    sendLinkNotice: (facts) => {
      pasos.push('correo:aviso');
      if (opciones.releCaido === true) {
        return Promise.reject(new Error('ECONNREFUSED 127.0.0.1:1025'));
      }
      avisados.push(facts);
      return Promise.resolve();
    },
  };

  return {
    caso: new RegisterPatient(patients, passwords, limit, idempotency, clock, mail),
    pasos,
    enviados,
    avisados,
    marcas,
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

describe('POST /v1/patients · la ficha, la cuenta y el acceso', () => {
  it('por WhatsApp devuelve la temporal y el enlace, y MedSkin no manda nada', async () => {
    const { caso, pasos, enviados } = armar();
    const respuesta = await caso.run(CUERPO, DOCTORA, CLAVE);

    expect(respuesta.paciente_id).toBe(FICHA);
    expect(respuesta.cuenta_id).toBe(CUENTA_PACIENTE);
    expect(respuesta.nombre_completo).toBe('Valeria Antelo');
    expect(respuesta.edad).toBe(34);
    expect(respuesta.vinculo).toEqual({ estado: 'invitada', correo: 'valeria.antelo@gmail.com' });

    const acceso = respuesta.acceso;
    expect(acceso.via).toBe('whatsapp');
    // MedSkin no tiene número y no manda mensajes por ella.
    expect(acceso.enviado).toBe(false);
    // Sin la temporal no hay mensaje que mandar: es el costo de no tener número.
    expect(acceso.contrasena_temporal).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
    expect(acceso.caduca_en).toBe(EN_72H.toISOString());
    expect(acceso.caduca_en_texto).toBe('Caduca el sábado 31 a las 18:24');

    // El texto lo redacta el servidor, con el nombre de la doctora y la temporal dentro, y
    // sin una palabra de tratamiento, de zona del cuerpo ni de clínica.
    const whatsapp = acceso.whatsapp;
    expect(whatsapp?.numero).toBe('+59177124408');
    expect(whatsapp?.texto).toContain('soy la Dra. Andrea Paz');
    expect(whatsapp?.texto).toContain(acceso.contrasena_temporal);
    expect(whatsapp?.url).toBe(
      `https://wa.me/59177124408?text=${encodeURIComponent(whatsapp?.texto ?? '')}`,
    );
    for (const prohibido of ['periocular', 'lidocaína', 'penicilina', 'alergia']) {
      expect(whatsapp?.texto).not.toContain(prohibido);
    }

    // Y no se mandó ningún correo: la vía la eligió ella.
    expect(enviados).toEqual([]);
    // La clave se cierra al final, con la respuesta ya verdadera.
    expect(pasos).toEqual(['limite', 'argon2:hashear', 'base', 'clave:cerrar']);
  });

  it('por correo lo manda MedSkin y la contraseña NO viaja en la respuesta', async () => {
    const { caso, enviados, pasos } = armar();
    const respuesta = await caso.run({ ...CUERPO, enviar_acceso_por: 'correo' }, DOCTORA, CLAVE);

    expect(respuesta.acceso.via).toBe('correo');
    // «`enviado` significa que el relé aceptó el mensaje, no que llegó a su bandeja.»
    expect(respuesta.acceso.enviado).toBe(true);
    expect(respuesta.acceso.contrasena_temporal).toBeNull();
    expect(respuesta.acceso.whatsapp).toBeUndefined();

    // La contraseña en claro solo existe en el mensaje, que es la otra mitad del invariante.
    expect(enviados[0]?.patientEmail).toBe('valeria.antelo@gmail.com');
    expect(enviados[0]?.temporaryPassword).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
    expect(pasos).toEqual(['limite', 'argon2:hashear', 'base', 'correo', 'clave:cerrar']);
  });

  it('en persona la temporal viaja y no hay ni correo ni enlace', async () => {
    const { caso, enviados } = armar();
    const respuesta = await caso.run({ ...CUERPO, enviar_acceso_por: 'ninguna' }, DOCTORA, CLAVE);

    expect(respuesta.acceso.via).toBe('ninguna');
    expect(respuesta.acceso.enviado).toBe(false);
    expect(respuesta.acceso.contrasena_temporal).not.toBeNull();
    expect(respuesta.acceso.whatsapp).toBeUndefined();
    expect(enviados).toEqual([]);
  });

  it('la ficha, el vínculo y los antecedentes llegan normalizados y con su autor', async () => {
    const { caso, recibido } = armar();
    await caso.run(CUERPO, DOCTORA, CLAVE);

    expect(recibido()).toMatchObject({
      owner: CONSULTA,
      via: 'whatsapp',
      confirmDuplicate: false,
      expiresAt: EN_72H,
      ficha: {
        firstName: 'Valeria',
        lastName: 'Antelo',
        birthDate: '1992-04-18',
        // La columna es `citext` y el correo entra en minúsculas, igual que en el equipo.
        email: 'valeria.antelo@gmail.com',
        phone: '+59177124408',
        hasWhatsapp: true,
        remindersVia: 'ambas',
        howArrived: 'instagram',
        referredBy: null,
      },
      history: {
        hasAllergies: true,
        allergies: ['lidocaína', 'penicilina'],
        // `false` es «se le preguntó y no toma», y su lista va vacía: la base no admite las
        // dos cosas y un expediente que se contradice no es un expediente.
        takesMedication: false,
        medication: [],
        pregnancyOrLactation: 'ninguno',
        phototype: 3,
        pastConditions: [],
        previousTreatments: [],
        notes: 'Pide empezar por la zona periocular.',
      },
    });

    // «Todo lo que llega aquí se guarda con `fuente: doctora`», y solo lo CONTESTADO: las
    // dos listas que nadie llenó se quedan sin autor, porque un campo vacío es «nadie
    // preguntó todavía» y la paciente todavía puede escribirlo desde su app.
    expect(recibido()?.written).toEqual([
      'allergies',
      'medication',
      'pregnancy_or_lactation',
      'phototype',
      'notes',
    ]);
    // Y la temporal va HASHEADA a la base, nunca en claro.
    expect(String(recibido()?.hash).startsWith('$argon2id$')).toBe(true);
  });

  it('el paso 3 es opcional entero: sin él todo queda en nulo y sin autor', async () => {
    const { caso, recibido } = armar();
    await caso.run({ ...CUERPO, antes_de_atenderla: undefined }, DOCTORA, CLAVE);

    expect(recibido()?.written).toEqual([]);
    expect(recibido()?.history).toMatchObject({
      hasAllergies: null,
      takesMedication: null,
      pregnancyOrLactation: null,
      phototype: null,
      notes: null,
    });
  });

  it('recepción no da de alta pacientes, y no se toca nada', async () => {
    const { caso, pasos } = armar();
    const fallo = await errorDe(() => caso.run(CUERPO, { ...DOCTORA, permissions: ['pacientes:leer'] }, CLAVE));

    expect({ codigo: fallo.code, estado: fallo.status, mensaje: fallo.userMessage }).toEqual({
      codigo: 'sin_permiso',
      estado: 403,
      mensaje: 'Recepción no puede dar de alta pacientes.',
    });
    expect(pasos).toEqual([]);
  });

  it('quien ya tiene cuenta no recibe temporal ninguna, y su texto no la nombra', async () => {
    const { caso, enviados } = armar({
      registro: { ...CREADA, accountAlreadyExisted: true },
    });
    const respuesta = await caso.run(CUERPO, DOCTORA, CLAVE);

    expect(respuesta.acceso.via).toBe('ya_tiene_cuenta');
    expect(respuesta.acceso.contrasena_temporal).toBeNull();
    // No se acuñó ninguna, así que no hay nada que caduque: una fecha aquí sería inventada.
    expect(respuesta.acceso.caduca_en).toBeNull();
    expect(respuesta.acceso.caduca_en_texto).toBeNull();
    expect(respuesta.acceso.whatsapp?.texto).toContain('Entra con tu cuenta de siempre');
    expect(respuesta.acceso.whatsapp?.texto).not.toMatch(/[a-z]+-[a-z]+-\d{2}/);
    expect(enviados).toEqual([]);
  });

  it('por correo a quien ya tiene cuenta se le AVISA, sin contraseña ninguna', async () => {
    // Esa persona tiene que enterarse de que una consulta la dio de alta: es su identidad la
    // que queda vinculada, y enterarse es lo único que le permite reaccionar.
    const { caso, enviados, avisados, pasos } = armar({
      registro: { ...CREADA, accountAlreadyExisted: true },
    });
    const respuesta = await caso.run({ ...CUERPO, enviar_acceso_por: 'correo' }, DOCTORA, CLAVE);

    expect(respuesta.acceso.via).toBe('ya_tiene_cuenta');
    // `enviado` significa lo mismo que siempre: el relé aceptó el mensaje.
    expect(respuesta.acceso.enviado).toBe(true);
    expect(respuesta.acceso.contrasena_temporal).toBeNull();
    expect(respuesta.acceso.caduca_en).toBeNull();

    // El correo del acceso NO se manda: no hay temporal que mandar. El del aviso sí, y no
    // nombra ninguna contraseña.
    expect(enviados).toEqual([]);
    expect(avisados).toEqual([
      {
        patientEmail: 'valeria.antelo@gmail.com',
        patientFirstName: 'Valeria',
        practitionerName: 'Dra. Andrea Paz',
      },
    ]);
    expect(pasos).toEqual(['limite', 'argon2:hashear', 'base', 'correo:aviso', 'clave:cerrar']);
  });

  it('el relé caído del aviso no promete un reenvío que daría 409', async () => {
    const { caso, marcas } = armar({
      registro: { ...CREADA, accountAlreadyExisted: true },
      releCaido: true,
    });
    const fallo = await errorDe(() => caso.run({ ...CUERPO, enviar_acceso_por: 'correo' }, DOCTORA, CLAVE));

    expect({ codigo: fallo.code, estado: fallo.status, mensaje: fallo.userMessage }).toEqual({
      codigo: 'fallo_de_servicio',
      estado: 500,
      // NO dice «vuelve a mandárselo»: no hay acceso que mandar —no se acuñó ninguna
      // temporal— y el reenvío le daría `409 ya_eligio_su_contrasena` si ya eligió la suya.
      mensaje:
        'No pudimos avisarle por correo. Su ficha ya está creada, así que no la vuelvas a dar de alta: ella ya tiene su cuenta y va a ver tu invitación cuando abra la app.',
    });
    expect(fallo.userMessage).not.toContain('vuelve a mandárselo');
    // Y la marca de envío vuelve a nulo igual: nadie recibió nada.
    expect(marcas).toEqual([null]);
  });
});

describe('POST /v1/patients · lo que no entra', () => {
  it('ningún 400 toca la base ni gasta el límite de altas', async () => {
    const casos: [Record<string, unknown>, string, string | null][] = [
      [{ nombre: '  ' }, 'nombre_vacio', 'nombre'],
      [{ apellido: '' }, 'nombre_vacio', 'nombre'],
      // Un solo código para las dos cosas, y su nombre no afirma ninguna: ausente, con
      // otro formato, o una fecha que no existe.
      [{ nacimiento: '' }, 'nacimiento_no_valido', 'nacimiento'],
      [{ nacimiento: undefined }, 'nacimiento_no_valido', 'nacimiento'],
      [{ nacimiento: '18/04/1992' }, 'nacimiento_no_valido', 'nacimiento'],
      // Un 31 de febrero pasa el patrón y no existe: el motor lo rechazaría con un 500.
      [{ nacimiento: '1992-02-31' }, 'nacimiento_no_valido', 'nacimiento'],
      [{ nacimiento: '2027-01-01' }, 'nacimiento_futuro', 'nacimiento'],
      [{ nacimiento: '2010-10-29' }, 'menor_de_edad', 'nacimiento'],
      [{ correo: '   ' }, 'correo_vacio', 'correo'],
      [{ correo: 'valeria@' }, 'correo_mal_escrito', 'correo'],
      [{ celular: '77124408' }, 'celular_mal_escrito', 'celular'],
      [{ enviar_acceso_por: 'sms' }, 'via_no_valida', 'enviar_acceso_por'],
      [{ enviar_acceso_por: undefined }, 'via_no_valida', 'enviar_acceso_por'],
      [{ celular: undefined }, 'celular_necesario_para_whatsapp', 'celular'],
      [{ como_llego: '' }, 'cuerpo_no_valido', 'como_llego'],
      [{ como_llego: 'referida' }, 'referida_sin_quien', 'referida_por'],
      [{ como_llego: 'referida', referida_por: 'pac_01HQ' }, 'referida_no_existe', 'referida_por'],
      [{ recordatorios_por: 'telegrama' }, 'cuerpo_no_valido', 'recordatorios_por'],
      [{ antes_de_atenderla: { alergias: { tiene: true } } }, 'alergias_sin_cuales', 'alergias'],
      [
        { antes_de_atenderla: { alergias: { tiene: true, cuales: [] } } },
        'alergias_sin_cuales',
        'alergias',
      ],
      [
        { antes_de_atenderla: { medicacion: { toma: true } } },
        'medicacion_sin_cuales',
        'medicacion',
      ],
      [{ antes_de_atenderla: { fototipo: 7 } }, 'fototipo_fuera_de_escala', 'fototipo'],
      [{ antes_de_atenderla: { fototipo: 2.5 } }, 'fototipo_fuera_de_escala', 'fototipo'],
      [
        { antes_de_atenderla: { embarazo_o_lactancia: 'quizas' } },
        'embarazo_valor_desconocido',
        'embarazo_o_lactancia',
      ],
      // Nada se recorta en silencio: truncar una alergia es perder un dato clínico.
      [
        { antes_de_atenderla: { alergias: { tiene: true, cuales: ['x'.repeat(200)] } } },
        'cuerpo_no_valido',
        null,
      ],
      [{ antes_de_atenderla: { notas: 'n'.repeat(2001) } }, 'cuerpo_no_valido', null],
    ];

    for (const [parche, codigo, campo] of casos) {
      const { caso, pasos } = armar();
      const fallo = await errorDe(() => caso.run({ ...CUERPO, ...parche }, DOCTORA, CLAVE));
      expect({ parche, codigo: fallo.code, campo: fallo.field, estado: fallo.status }).toEqual({
        parche,
        codigo,
        campo,
        estado: codigo === 'referida_no_existe' ? 404 : 400,
      });
      // Y lo que importa de este caso: un cuerpo mal escrito no crea nada, no gasta cuota
      // y no puede usarse para medir si un correo existe.
      expect(pasos).toEqual([]);
    }
  });

  it('el correo vacío lleva la frase de este endpoint, que dice para qué sirve', async () => {
    const { caso } = armar();
    const fallo = await errorDe(() => caso.run({ ...CUERPO, correo: '' }, DOCTORA, CLAVE));
    expect(fallo.userMessage).toBe('Hace falta su correo: es por donde le llega su contraseña.');
  });

  it('la casilla de WhatsApp sin número no es un número', async () => {
    const { caso, recibido } = armar();
    await caso.run(
      { ...CUERPO, celular: undefined, tiene_whatsapp: true, enviar_acceso_por: 'correo' },
      DOCTORA,
      CLAVE,
    );
    expect(recibido()?.ficha).toMatchObject({ phone: null, hasWhatsapp: false });
  });

  it('más de 60 altas en una hora es 429, y se cuenta antes de crear nada', async () => {
    const { caso, pasos } = armar({ demasiadas: true });
    const fallo = await errorDe(() => caso.run(CUERPO, DOCTORA, CLAVE));

    expect({ codigo: fallo.code, estado: fallo.status }).toEqual({
      codigo: 'demasiadas_altas',
      estado: 429,
    });
    expect(pasos).toEqual(['limite']);
  });
});

describe('POST /v1/patients · los veredictos de la base', () => {
  it('la licencia sin verificar no da de alta a nadie', async () => {
    const { caso } = armar({ registro: { ...CREADA, verdict: 'license_unverified' } });
    const fallo = await errorDe(() => caso.run(CUERPO, DOCTORA, CLAVE));

    expect({ codigo: fallo.code, estado: fallo.status, mensaje: fallo.userMessage }).toEqual({
      codigo: 'licencia_sin_verificar',
      estado: 409,
      mensaje:
        'Todavía no puedes invitar pacientes: tu licencia está en revisión. Te avisamos en cuanto se apruebe.',
    });
  });

  it('el límite del plan lleva el número del plan en la frase', async () => {
    const { caso } = armar({ registro: { ...CREADA, verdict: 'plan_limit', patientLimit: 300 } });
    const fallo = await errorDe(() => caso.run(CUERPO, DOCTORA, CLAVE));

    expect({ codigo: fallo.code, estado: fallo.status, mensaje: fallo.userMessage }).toEqual({
      codigo: 'limite_del_plan',
      estado: 409,
      mensaje: 'Llegaste a las 300 pacientes de tu plan. Amplíalo para dar de alta más.',
    });
  });

  it('el duplicado nombra a quién y cuándo, y trae lo que la app necesita para abrir su ficha', async () => {
    const duplicada = {
      patientId: '77777777-7777-4777-8777-777777777777',
      fullName: 'Valeria Antelo',
      createdAt: new Date('2026-08-03T22:24:00.000Z'),
    };
    const { caso } = armar({ registro: { ...CREADA, verdict: 'duplicate_email', duplicate: duplicada } });
    const fallo = await errorDe(() => caso.run(CUERPO, DOCTORA, CLAVE));

    expect({ codigo: fallo.code, estado: fallo.status, campo: fallo.field }).toEqual({
      codigo: 'correo_duplicado_en_la_consulta',
      estado: 409,
      // Aviso ámbar SOBRE EL CAMPO, no alerta: el duplicado no es un muro.
      campo: 'correo',
    });
    expect(fallo.userMessage).toBe(
      'Ya tienes a Valeria Antelo con este correo, de alta el 3 de agosto. Revisa antes de crear otra ficha.',
    );
    expect(fallo.data).toEqual({
      paciente_id: duplicada.patientId,
      nombre_completo: 'Valeria Antelo',
      alta_en: duplicada.createdAt.toISOString(),
    });
  });

  it('«Es otra persona» repite la petición y el duplicado ya no se comprueba', async () => {
    const { caso, recibido } = armar();
    await caso.run({ ...CUERPO, confirmar_duplicado: true }, DOCTORA, CLAVE);
    expect(recibido()?.confirmDuplicate).toBe(true);
  });

  it('un correo que no se puede usar es un 409 que NO dice por qué', async () => {
    const { caso } = armar({ registro: { ...CREADA, verdict: 'email_unavailable' } });
    const fallo = await errorDe(() => caso.run(CUERPO, DOCTORA, CLAVE));

    expect({ codigo: fallo.code, estado: fallo.status, campo: fallo.field }).toEqual({
      codigo: 'correo_no_disponible',
      estado: 409,
      campo: 'correo',
    });
    expect(fallo.userMessage).toBe(
      'Ese correo no se puede usar para el alta. Dale de alta con otro correo suyo, o escríbenos a hola@medskin.app.',
    );
    // Lo que esta prueba defiende es lo que la frase NO dice: si nombrara el motivo, el alta
    // sería un directorio del personal de MedSkin consultable de uno en uno.
    for (const prohibido of ['practicante', 'doctora', 'equipo', 'recepción', 'personal']) {
      expect(fallo.userMessage.toLowerCase()).not.toContain(prohibido.toLowerCase());
    }
    expect(fallo.data).toBeUndefined();
  });

  it('quien la refirió tiene que ser ficha de esta consulta', async () => {
    const { caso } = armar({ registro: { ...CREADA, verdict: 'referrer_not_found' } });
    const fallo = await errorDe(() =>
      caso.run({ ...CUERPO, como_llego: 'referida', referida_por: FICHA }, DOCTORA, CLAVE),
    );

    // El mismo 404 que un identificador inventado: no se distingue «no es tuya» de «no
    // existe», que es la regla del `404` de `cuentas.md`.
    expect({ codigo: fallo.code, estado: fallo.status }).toEqual({
      codigo: 'referida_no_existe',
      estado: 404,
    });
  });
});

describe('POST /v1/patients · el relé caído', () => {
  it('es un 500 que admite lo que se perdió y deshace la marca de envío', async () => {
    const { caso, pasos, marcas } = armar({ releCaido: true });
    const fallo = await errorDe(() => caso.run({ ...CUERPO, enviar_acceso_por: 'correo' }, DOCTORA, CLAVE));

    expect({ codigo: fallo.code, estado: fallo.status, mensaje: fallo.userMessage }).toEqual({
      codigo: 'fallo_de_servicio',
      estado: 500,
      // No dice «puedes volver a intentarlo»: reintentar el alta crearía una segunda ficha
      // de la misma persona. La salida es volver a mandarle el acceso.
      mensaje:
        'No pudimos mandarle el acceso. Su ficha ya está creada, así que no la vuelvas a dar de alta: vuelve a mandárselo desde su ficha.',
    });
    // Y TRAE CON QUÉ REENVIAR. La frase manda volver a mandárselo, y el identificador que el
    // reenvío pide viajaba solo en el 201 que nunca llegó: la doctora leía la salida y no
    // tenía con qué tomarla.
    const datos = fallo.data as { paciente_id?: unknown; cuenta_id?: unknown };
    expect(typeof datos.paciente_id).toBe('string');
    expect(typeof datos.cuenta_id).toBe('string');
    // La marca vuelve a nulo porque el vínculo acaba de nacer y nulo es lo que había:
    // `access_sent_at` solo puede afirmar un envío que ocurrió.
    expect(marcas).toEqual([null]);
    expect(pasos).toEqual(['limite', 'argon2:hashear', 'base', 'correo', 'deshacer-marca']);
  });

  it('ni el correo ni la contraseña entran en la causa que acaba en `service_failure`', async () => {
    const { caso } = armar({ releCaido: true });
    const fallo = await errorDe(() => caso.run({ ...CUERPO, enviar_acceso_por: 'correo' }, DOCTORA, CLAVE));

    // La cadena entera, que es lo que el registro de fallos recorre: la causa propia, la
    // del relé y lo que cuelgue de ella.
    const cadena = cadenaDe(fallo);
    expect(cadena).toContain(FICHA);
    expect(cadena).toContain('ECONNREFUSED');
    for (const prohibido of ['valeria.antelo@gmail.com', 'Valeria', 'periocular']) {
      expect(cadena).not.toContain(prohibido);
    }
    // Y la contraseña temporal tampoco, que es lo que no se puede registrar nunca.
    expect(cadena).not.toMatch(/[a-z]+-[a-z]+-\d{2}/);
  });

  it('si la compensación tampoco se puede, la causa lo dice en vez de taparlo', async () => {
    const { caso } = armar({ releCaido: true, compensacionCaida: true });
    const fallo = await errorDe(() => caso.run({ ...CUERPO, enviar_acceso_por: 'correo' }, DOCTORA, CLAVE));

    expect(fallo.code).toBe('fallo_de_servicio');
    const cadena = cadenaDe(fallo);
    expect(cadena).toContain('la marca de envío quedó puesta');
    expect(cadena).toContain('la fila del vínculo no apareció');
  });
});

describe('POST /v1/patients · la idempotencia', () => {
  it('la repetición devuelve la respuesta guardada y no manda ni crea nada', async () => {
    // La decide la MISMA transacción que habría creado la ficha, así que el caso de uso no
    // vuelve a hashear, no vuelve a escribir y no manda ningún correo.
    const guardada = { paciente_id: FICHA, cuenta_id: CUENTA_PACIENTE, nombre_completo: 'Valeria Antelo' };
    const { caso, pasos, enviados, cerradas } = armar({
      registro: { ...CREADA, verdict: 'replayed', replay: { status: 201, response: guardada } },
    });

    const respuesta = await caso.run({ ...CUERPO, enviar_acceso_por: 'correo' }, DOCTORA, CLAVE);

    // Byte a byte la original, contraseña incluida si la llevaba.
    expect(respuesta).toEqual(guardada);
    expect(enviados).toEqual([]);
    expect(cerradas).toEqual([]);
    expect(pasos).toEqual(['limite', 'argon2:hashear', 'base']);
  });

  it('la clave se cierra con la respuesta ya verdadera, y con su estado', async () => {
    const { caso, cerradas, pasos } = armar();
    const respuesta = await caso.run({ ...CUERPO, enviar_acceso_por: 'correo' }, DOCTORA, CLAVE);

    // Lo que se guarda es EXACTAMENTE lo que se devolvió: si se guardara antes del envío,
    // `enviado` diría «true» de un correo que todavía no había salido.
    expect(cerradas).toEqual([{ status: 201, response: respuesta }]);
    expect(pasos).toEqual(['limite', 'argon2:hashear', 'base', 'correo', 'clave:cerrar']);
  });

  it('si la clave no se puede cerrar, el 500 NO dice que se pueda volver a crear', async () => {
    const { caso } = armar({ cierreCaido: true });
    const fallo = await errorDe(() =>
      caso.run({ ...CUERPO, enviar_acceso_por: 'correo' }, DOCTORA, CLAVE),
    );

    // La ficha existe y el correo salió: «no se creó nada» sería falso y «vuelve a
    // intentarlo» mandaría a crear una segunda ficha de la misma persona.
    expect(fallo.code).toBe('fallo_de_servicio');
    expect(fallo.userMessage).toBe(
      'No pudimos mandarle el acceso. Su ficha ya está creada, así que no la vuelvas a dar de alta: vuelve a mandárselo desde su ficha.',
    );
    expect(cadenaDe(fallo)).toContain('la fila de la clave no apareció');
  });
});

/** La cadena de causas en texto: es lo que `FailureLog` recorre para escribir la fila. */
function cadenaDe(fallo: unknown): string {
  const partes: string[] = [];
  let actual: unknown = fallo;
  for (let i = 0; i < 5 && actual instanceof Error; i += 1) {
    partes.push(actual.name, actual.message);
    actual = actual.cause;
  }
  return partes.join(' · ');
}
