// `DELETE /v1/accounts/mine` · el orden, los cuatro noes y lo que el 200 promete.
//
// Lo que se fija aquí:
//   · la contraseña se comprueba ANTES de llamar al borrado, y un fallo no escribe nada;
//   · los tres `409` llevan su frase literal, con el número y la fecha que devuelve la
//     función interpolados —son parte de la frase, no un adorno—;
//   · «recepción y asistente, no» es un veredicto de la base, no un `if` del controlador;
//   · borrar lo ya borrado devuelve el mismo 200, con la fecha del borrado DE VERDAD, y por
//     eso `se_conserva.hasta` se calcula sobre ESA fecha: lo que se le prometió a quien ya
//     se borró no se reinterpreta;
//   · `se_borro` enumera lo que el borrado CUBRE, con las dos listas de los tramos 6 y 7.

import { describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import type { ClockPort, PasswordHasher } from '../../access/domain/ports';
import type {
  AccountDeletionPort,
  DeletionResult,
  OwnCredentialPort,
} from '../domain/ports';
import { DeleteOwnAccount } from './delete-own-account';

const AHORA = new Date('2026-10-27T14:20:00.000Z');
const ANOS = 7;

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

const BORRADA: DeletionResult = {
  verdict: 'deleted',
  deletedAt: AHORA,
  patientCount: null,
  planRenewsOn: null,
};

function armar(opciones: { coincide?: boolean; veredicto?: DeletionResult }) {
  const pasos: string[] = [];
  let recibido: { retentionUntil: string; reason: string | null } | null = null;

  const credentials: OwnCredentialPort = {
    readMine: () => {
      pasos.push('credencial:mia');
      return Promise.resolve({ hash: '$argon2id$la-de-ahora' });
    },
    replace: () => Promise.reject(new Error('este endpoint no escribe contraseñas')),
  };

  const passwords: PasswordHasher = {
    verify: () => {
      pasos.push('argon2:comparar');
      return Promise.resolve(opciones.coincide ?? true);
    },
    hash: () => Promise.reject(new Error('este endpoint no hashea nada')),
  };

  const deletion: AccountDeletionPort = {
    deleteMine: (p) => {
      pasos.push('borrado');
      recibido = { retentionUntil: p.retentionUntil, reason: p.reason };
      return Promise.resolve(opciones.veredicto ?? BORRADA);
    },
  };

  const clock: ClockPort = { now: () => AHORA, localTime: () => '10:20' };

  return {
    caso: new DeleteOwnAccount(credentials, passwords, deletion, clock, ANOS),
    pasos,
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

describe('DELETE /v1/accounts/mine', () => {
  it('borra, y dice qué se fue y qué se conserva hasta cuándo', async () => {
    const { caso, pasos, recibido } = armar({});
    const respuesta = await caso.run({ contrasena: 'la-mía', motivo: 'ya_no_la_uso' }, PACIENTE);

    expect(respuesta).toEqual({
      borrado_en: AHORA.toISOString(),
      se_borro: ['acceso', 'fotos_que_subiste', 'datos_de_contacto', 'sesiones', 'tokens_de_aviso'],
      se_conserva: {
        que: 'expediente_clinico',
        hasta: '2033-10-27',
        por_que: 'Tu doctora tiene que conservar tu historia clínica por ley.',
        vuelve_si: 'Tu doctora te da de alta otra vez con este mismo correo.',
      },
    });
    // El plazo que viaja a la base es el que la bitácora guarda como hecho histórico.
    expect(recibido()).toEqual({ retentionUntil: '2033-10-27', reason: 'ya_no_la_uso' });
    expect(pasos).toEqual(['credencial:mia', 'argon2:comparar', 'borrado']);
  });

  it('con la contraseña mal no se borra nada, y la frase es la de esta pantalla', async () => {
    const { caso, pasos } = armar({ coincide: false });
    const fallo = await errorDe(() => caso.run({ contrasena: 'no-es' }, PACIENTE));

    expect({
      codigo: fallo.code,
      estado: fallo.status,
      campo: fallo.field,
      mensaje: fallo.userMessage,
    }).toEqual({
      codigo: 'contrasena_actual_no_coincide',
      estado: 401,
      // El cuerpo de esta pantalla se llama `contrasena`, no `actual`: el `codigo` es el
      // mismo que el del cambio de contraseña y la casilla que se enciende es otra.
      campo: 'contrasena',
      mensaje: 'Esa no es tu contraseña.',
    });
    expect(pasos).toEqual(['credencial:mia', 'argon2:comparar']);
  });

  it('borrar lo ya borrado devuelve el mismo 200, con la fecha del borrado de verdad', async () => {
    const PRIMERO = new Date('2026-09-01T10:00:00.000Z');
    const { caso } = armar({
      veredicto: { ...BORRADA, verdict: 'already_deleted', deletedAt: PRIMERO },
    });
    const respuesta = await caso.run({ contrasena: 'la-mía' }, PACIENTE);

    expect(respuesta.borrado_en).toBe(PRIMERO.toISOString());
    // Y el plazo se cuenta desde ESA fecha, no desde el reintento.
    expect(respuesta.se_conserva.hasta).toBe('2033-09-01');
  });

  it('recepción y asistente no pueden borrarse desde aquí, y lo dice la base', async () => {
    const { caso } = armar({
      veredicto: { ...BORRADA, verdict: 'not_allowed', deletedAt: null },
    });
    const fallo = await errorDe(() => caso.run({ contrasena: 'la-mía' }, PACIENTE));

    expect({ codigo: fallo.code, estado: fallo.status }).toEqual({
      codigo: 'sin_permiso',
      estado: 403,
    });
  });

  it('la dueña con equipo: primero saca a su equipo', async () => {
    const { caso } = armar({
      veredicto: { ...BORRADA, verdict: 'practice_has_team', deletedAt: null },
    });
    const fallo = await errorDe(() => caso.run({ contrasena: 'la-mía' }, PACIENTE));

    expect({ codigo: fallo.code, estado: fallo.status, mensaje: fallo.userMessage }).toEqual({
      codigo: 'consulta_con_equipo',
      estado: 409,
      mensaje:
        'Primero saca a tu equipo de la consulta: si borras tu cuenta ahora, se quedan sin acceso.',
    });
  });

  it('la dueña con fichas: el número sale de la función y la frase lo interpola', async () => {
    const { caso } = armar({
      veredicto: {
        verdict: 'practice_has_patients',
        deletedAt: null,
        patientCount: 148,
        planRenewsOn: null,
      },
    });
    const fallo = await errorDe(() => caso.run({ contrasena: 'la-mía' }, PACIENTE));

    expect(fallo.code).toBe('consulta_con_pacientes');
    expect(fallo.userMessage).toBe(
      'Tu consulta tiene 148 pacientes con su historia clínica. Por ley alguien tiene que seguir siendo responsable de ella, así que primero hay que traspasar o cerrar la consulta. Escríbenos a hola@medskin.app y lo hacemos contigo.',
    );
    expect(fallo.data).toEqual({ pacientes: 148 });
  });

  it('con una sola ficha la frase concuerda en singular', async () => {
    const { caso } = armar({
      veredicto: {
        verdict: 'practice_has_patients',
        deletedAt: null,
        patientCount: 1,
        planRenewsOn: null,
      },
    });
    const fallo = await errorDe(() => caso.run({ contrasena: 'la-mía' }, PACIENTE));

    expect(fallo.userMessage.startsWith('Tu consulta tiene 1 paciente con su historia')).toBe(true);
  });

  it('la dueña con plan vigente: la fecha sale de plan_renews_on, escrita en palabras', async () => {
    const { caso } = armar({
      veredicto: {
        verdict: 'subscription_active',
        deletedAt: null,
        patientCount: null,
        planRenewsOn: '2026-11-14',
      },
    });
    const fallo = await errorDe(() => caso.run({ contrasena: 'la-mía' }, PACIENTE));

    expect({ codigo: fallo.code, estado: fallo.status, mensaje: fallo.userMessage }).toEqual({
      codigo: 'suscripcion_activa',
      estado: 409,
      mensaje:
        'Tu plan sigue activo hasta el 14 de noviembre. Cancélalo primero y después borra tu cuenta.',
    });
  });

  it('el motivo se acota en vez de reventar en la base, que lo rechaza por largo', async () => {
    const { caso, recibido } = armar({});
    await caso.run({ contrasena: 'la-mía', motivo: 'x'.repeat(200) }, PACIENTE);

    expect(recibido()?.reason).toHaveLength(120);
  });

  it('sin motivo viaja nulo, que es lo que la columna admite', async () => {
    const { caso, recibido } = armar({});
    await caso.run({ contrasena: 'la-mía', motivo: '   ' }, PACIENTE);

    expect(recibido()?.reason).toBeNull();
  });
});
