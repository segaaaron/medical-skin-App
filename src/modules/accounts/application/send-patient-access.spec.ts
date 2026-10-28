// `POST /v1/cuentas/{cuenta_id}/acceso` · lo que el contrato promete y es fácil romper.
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
import type {
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
  role: 'doctora',
  accountRole: 'practitioner',
  scope: 'completo',
  region: 'latam',
  practiceId: '22222222-2222-4222-8222-222222222222',
  permissions: [PERMISSION],
};

const RECEPCION: Caller = { ...DOCTORA, role: 'recepcion', permissions: ['pacientes:leer'] };

const VALERIA: PatientForDelivery = {
  firstName: 'Valeria',
  email: 'valeria.antelo@gmail.com',
  phone: '+59177124408',
  practitionerName: 'Dra. Andrea Paz',
};

function armar(opciones: {
  paciente?: PatientForDelivery | null;
  veredicto?: ResendOutcome;
  demasiados?: boolean;
}) {
  const pasos: string[] = [];

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

  return { caso: new SendPatientAccess(patients, passwords, limit, clock), pasos };
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

describe('POST /v1/cuentas/{cuenta_id}/acceso · quién puede', () => {
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

describe('POST /v1/cuentas/{cuenta_id}/acceso · la temporal en claro', () => {
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
    const { caso } = armar({});
    const bloque = await caso.run({ via: 'correo' }, CUENTA_PACIENTE, DOCTORA);

    expect(bloque.contrasena_temporal).toBeNull();
    expect(bloque.whatsapp).toBeUndefined();
    // La fecha sí: la doctora tiene que poder decirle hasta cuándo vale.
    expect(bloque.caduca_en_texto).toBe('Caduca el viernes 30 a las 18:24');
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

describe('POST /v1/cuentas/{cuenta_id}/acceso · lo que no se hace', () => {
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

  it('el cuarto reenvío de la hora es 429 y tampoco acuña', async () => {
    const { caso, pasos } = armar({ demasiados: true });
    const error = await errorDe(() => caso.run({ via: 'correo' }, CUENTA_PACIENTE, DOCTORA));

    expect(error.code).toBe('demasiados_reenvios');
    expect(error.status).toBe(429);
    expect(pasos).not.toContain('acunar:correo');
  });
});
