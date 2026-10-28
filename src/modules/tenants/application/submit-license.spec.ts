// `POST /v1/inquilinos/mio/licencia` · los veredictos de la base traducidos a la tabla de
// errores del contrato, y nada más que eso.
//
// Lo que se fija aquí:
//   · un cuerpo mal formado NO llega a la base: se para en el borde con su `codigo`;
//   · los tres veredictos que el contrato nombra se traducen uno a uno, y `not_owner` es el
//     `403 sin_permiso` con la frase de ESTE endpoint;
//   · los que el contrato NO nombra son 500 con su causa, nunca un error inventado;
//   · `respuesta_estimada_en` la calcula el servidor y entra como argumento a la base.

import { describe, expect, it } from 'vitest';

import { ServiceFailure } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import type { RememberedResponse, Submission, SubmissionVerdict } from '../domain/ports';
import { SubmitLicense } from './submit-license';

const DOCTORA: Caller = {
  accountId: '11111111-1111-4111-8111-111111111111',
  sessionId: '33333333-3333-4333-8333-333333333333',
  role: 'doctora',
  accountRole: 'practitioner',
  scope: 'completo',
  region: 'latam',
  practiceId: '22222222-2222-4222-8222-222222222222',
  permissions: [],
};

const RECEPCION: Caller = { ...DOCTORA, role: 'recepcion' };
const PACIENTE: Caller = {
  ...DOCTORA,
  role: 'paciente',
  accountRole: 'paciente',
  practiceId: null,
};

const CUERPO = {
  pais_ejercicio: 'BO',
  especialidad: 'medicina_estetica',
  matricula: '48921',
  credencial_clave: `lic/${DOCTORA.practiceId!}/4f2a.pdf`,
  declaracion_aceptada: true,
  terminos_aceptados: true,
};

const AHORA = new Date('2026-10-27T22:24:00Z'); // martes 18:24 en La Paz
const ENVIADA = new Date('2026-10-27T22:24:01Z');

const CLAVE: IdempotencyRecord = { key: '7f8e9d10-3333-4333-8333-333333333333', bodyHash: 'huella' };

function armar(verdict: SubmissionVerdict = 'submitted', repetida: unknown = null) {
  const pedido: { practiceId: string; licenseNumber: string; responseEstimatedAt: Date }[] = [];
  const guardadas: RememberedResponse[] = [];

  const licenses = {
    submit: (p: {
      owner: { practiceId: string };
      form: { licenseNumber: string };
      responseEstimatedAt: Date;
      idempotency: IdempotencyRecord;
      respond: (s: Submission) => RememberedResponse;
    }): Promise<{ submission: Submission; replay: { status: number; response: unknown } | null }> => {
      pedido.push({
        practiceId: p.owner.practiceId,
        licenseNumber: p.form.licenseNumber,
        responseEstimatedAt: p.responseEstimatedAt,
      });
      // La misma petición otra vez: el repositorio devuelve la respuesta guardada y el caso
      // de uso no vuelve a construir nada.
      if (repetida !== null) {
        return Promise.resolve({
          submission: { verdict: 'already_in_review', status: 'en_revision', submittedAt: null, responseEstimatedAt: null },
          replay: { status: 202, response: repetida },
        });
      }
      const submission: Submission =
        verdict === 'submitted'
          ? {
              verdict,
              status: 'en_revision',
              submittedAt: ENVIADA,
              responseEstimatedAt: p.responseEstimatedAt,
            }
          : { verdict, status: 'en_revision', submittedAt: null, responseEstimatedAt: null };
      // Lo que el repositorio guardaría en la MISMA transacción, construido por quien sabe
      // su forma: nulo para los veredictos que no se repiten.
      guardadas.push(p.respond(submission));
      return Promise.resolve({ submission, replay: null });
    },
  };

  return {
    caso: new SubmitLicense(licenses, { now: () => AHORA }, 'America/La_Paz'),
    pedido,
    guardadas,
  };
}

describe('POST /v1/inquilinos/mio/licencia', () => {
  it('abre el caso y devuelve el 202 del contrato, con `puede` sin desbloquear nada', async () => {
    const { caso, pedido } = armar();

    await expect(caso.run(CUERPO, DOCTORA, CLAVE)).resolves.toEqual({
      estado: 'en_revision',
      enviada_en: '2026-10-27T22:24:01.000Z',
      respuesta_estimada_en: '2026-10-28T22:24:00.000Z',
      puede: {
        invitar_pacientes: false,
        registrar_sesiones: false,
        armar_catalogo: true,
        definir_horarios: true,
      },
    });

    // El inquilino sale del token y la respuesta estimada la calcula el servidor: 24 h
    // hábiles desde el martes.
    expect(pedido).toEqual([
      {
        practiceId: DOCTORA.practiceId,
        licenseNumber: '48921',
        responseEstimatedAt: new Date('2026-10-28T22:24:00Z'),
      },
    ]);
  });

  it('un cuerpo incompleto no llega a la base', async () => {
    const { caso, pedido } = armar();

    await expect(caso.run({ ...CUERPO, matricula: '' }, DOCTORA, CLAVE)).rejects.toMatchObject({
      code: 'matricula_vacia',
      status: 400,
      field: 'matricula',
    });
    expect(pedido).toEqual([]);
  });

  it('`not_owner` es el 403 con la frase de este endpoint, y lo decide la base', async () => {
    // Recepción llega con un cuerpo perfecto: quien la para es `practice.owner_account_id`,
    // que es una fila y no una lista de permisos que se pueda editar aquí.
    const { caso, pedido } = armar('not_owner');

    await expect(caso.run(CUERPO, RECEPCION, CLAVE)).rejects.toMatchObject({
      code: 'sin_permiso',
      status: 403,
      userMessage: 'Solo la dueña de la consulta puede enviar la licencia.',
    });
    expect(pedido).toHaveLength(1);
  });

  it('una paciente no llega a abrir contexto de inquilino: su token no tiene ninguno', async () => {
    const { caso, pedido } = armar();

    await expect(caso.run(CUERPO, PACIENTE, CLAVE)).rejects.toMatchObject({
      code: 'sin_permiso',
      status: 403,
    });
    expect(pedido).toEqual([]);
  });

  it('un caso ya abierto es `409 licencia_en_revision`, y uno verificado su hermano', async () => {
    await expect(armar('already_in_review').caso.run(CUERPO, DOCTORA, CLAVE)).rejects.toMatchObject({
      code: 'licencia_en_revision',
      status: 409,
    });
    await expect(armar('already_verified').caso.run(CUERPO, DOCTORA, CLAVE)).rejects.toMatchObject({
      code: 'licencia_ya_verificada',
      status: 409,
    });
  });

  it('pasados los cinco envíos del día es `429 demasiados_envios`', async () => {
    await expect(armar('too_many').caso.run(CUERPO, DOCTORA, CLAVE)).rejects.toMatchObject({
      code: 'demasiados_envios',
      status: 429,
      userMessage: 'Ya enviaste tu licencia varias veces hoy. Espera a que la revisemos.',
    });
  });

  it('los veredictos que el contrato no nombra son 500 con su causa, no un error inventado', async () => {
    for (const verdict of ['incomplete', 'invalid_transition', 'no_license'] as const) {
      const fallo = await armar(verdict)
        .caso.run(CUERPO, DOCTORA, CLAVE)
        .catch((failure: unknown) => failure);

      expect(fallo).toBeInstanceOf(ServiceFailure);
      expect((fallo as ServiceFailure).body().error.mensaje).toBe(
        'No pudimos enviar tu licencia. El servidor no respondió. Lo que llenaste está guardado en este teléfono: puedes volver a intentarlo.',
      );
      // La causa dice el veredicto de verdad, que es lo que hace falta para arreglarlo.
      expect(String((fallo as ServiceFailure).cause)).toContain(verdict);
    }
  });

  it('un `submitted` sin fechas es 500: no se inventa una fecha de envío', async () => {
    const submission: Submission = {
      verdict: 'submitted',
      status: 'en_revision',
      submittedAt: null,
      responseEstimatedAt: null,
    };
    const licenses = {
      // El `respond` del repositorio construye la respuesta DENTRO de la transacción, así
      // que este 500 salta ahí: la clave no se guarda y el reintento puede volver a
      // intentarlo de verdad, que es lo correcto para una inconsistencia del servidor.
      submit: (p: { respond: (s: Submission) => unknown }) =>
        Promise.resolve({ submission, replay: null, ...{ respondio: p.respond(submission) } }),
    };
    const caso = new SubmitLicense(licenses, { now: () => AHORA }, 'America/La_Paz');

    await expect(caso.run(CUERPO, DOCTORA, CLAVE)).rejects.toBeInstanceOf(ServiceFailure);
  });
});
