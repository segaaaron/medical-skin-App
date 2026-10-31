// `POST /v1/tenants/mine/license` · «el doctor declara su matrícula».
//
// Lo que se fija aquí:
//   · un cuerpo mal formado NO llega a la base: se para en el borde con su `codigo`;
//   · `not_owner` es el `403 sin_permiso` con la frase de ESTE endpoint, **y lo decide la
//     base**: el token no lleva «soy la dueña»;
//   · `too_many` es el `429`, y el cupo de cinco al día sobrevivió a la corrección;
//   · un `saved` sin fecha es 500 con su causa, no una fecha inventada.
//
// TENÍA CUATRO PRUEBAS MÁS Y SE FUERON CON LO QUE PROBABAN: el `202` de «caso de revisión
// abierto», el `respuesta_estimada_en` de 24 h hábiles, los dos `409`
// —`licencia_en_revision` y `licencia_ya_verificada`— y los tres veredictos de transición
// imposible. MedSkin no verifica licencias (migración 0072): es un formulario y el último
// `POST` gana.

import { describe, expect, it } from 'vitest';

import { ServiceFailure } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import type { RememberedResponse, Submission, SubmissionVerdict } from '../domain/ports';
import { SubmitLicense } from './submit-license';

const DOCTORA: Caller = {
  accountId: '11111111-1111-4111-8111-111111111111',
  sessionId: '33333333-3333-4333-8333-333333333333',
  role: 'doctor',
  accountRole: 'doctor',
  scope: 'completo',
  region: 'latam',
  practiceId: '22222222-2222-4222-8222-222222222222',
  permissions: [],
};

/** La misma forma de token, pero la fila de `practice.owner_account_id` dice otra cuenta. */
const OTRA_DEL_EQUIPO: Caller = {
  ...DOCTORA,
  accountId: '44444444-4444-4444-8444-444444444444',
};

const PACIENTE: Caller = {
  ...DOCTORA,
  role: 'patient',
  accountRole: 'patient',
  practiceId: null,
};

const CUERPO = {
  pais_ejercicio: 'BO',
  especialidad: 'medicina_estetica',
  matricula: '48921',
};

const DECLARADA = new Date('2026-10-27T22:24:01Z');

const CLAVE: IdempotencyRecord = { key: '7f8e9d10-3333-4333-8333-333333333333', bodyHash: 'huella' };

function armar(verdict: SubmissionVerdict = 'saved', repetida: unknown = null) {
  const pedido: { practiceId: string; licenseNumber: string }[] = [];
  const guardadas: RememberedResponse[] = [];

  const licenses = {
    submit: (p: {
      owner: { practiceId: string };
      form: { licenseNumber: string };
      idempotency: IdempotencyRecord;
      respond: (s: Submission) => RememberedResponse;
    }): Promise<{ submission: Submission; replay: { status: number; response: unknown } | null }> => {
      pedido.push({ practiceId: p.owner.practiceId, licenseNumber: p.form.licenseNumber });
      // La misma petición otra vez: el repositorio devuelve la respuesta guardada y el caso
      // de uso no vuelve a construir nada.
      if (repetida !== null) {
        return Promise.resolve({
          submission: { verdict: 'saved', declaredAt: null },
          replay: { status: 200, response: repetida },
        });
      }
      const submission: Submission =
        verdict === 'saved' ? { verdict, declaredAt: DECLARADA } : { verdict, declaredAt: null };
      // Lo que el repositorio guardaría en la MISMA transacción, construido por quien sabe
      // su forma: nulo para los veredictos que no se repiten.
      guardadas.push(p.respond(submission));
      return Promise.resolve({ submission, replay: null });
    },
  };

  return { caso: new SubmitLicense(licenses), pedido, guardadas };
}

describe('POST /v1/tenants/mine/license', () => {
  it('guarda y devuelve los tres datos con la hora que puso la BASE, y ni un campo más', async () => {
    const { caso, pedido } = armar();

    await expect(caso.run(CUERPO, DOCTORA, CLAVE)).resolves.toEqual({
      pais_ejercicio: 'BO',
      especialidad: 'medicina_estetica',
      matricula: '48921',
      declarada_en: '2026-10-27T22:24:01.000Z',
    });

    // Sin `estado`, sin `respuesta_estimada_en` y SIN `puede`: declarar la matrícula no
    // cambia ni uno de sus cuatro valores, y `puede` se sirve donde se lee.
    expect(pedido).toEqual([{ practiceId: DOCTORA.practiceId, licenseNumber: '48921' }]);
  });

  it('el 200 que se guarda para el reintento es el MISMO que se devuelve', async () => {
    const { caso, guardadas } = armar();
    const respuesta = await caso.run(CUERPO, DOCTORA, CLAVE);

    expect(guardadas).toEqual([{ status: 200, response: respuesta }]);
  });

  it('la misma clave otra vez devuelve su respuesta original, sin volver a escribir', async () => {
    const original = {
      pais_ejercicio: 'BO',
      especialidad: 'dermatologia',
      matricula: 'MP-1',
      declarada_en: '2026-10-26T10:00:00.000Z',
    };
    const { caso } = armar('saved', original);

    // La fecha es la del PRIMER guardado, no una recalculada: es lo que manda
    // `_convenciones.md` y lo que hace que el reintento no gaste uno de los cinco del día.
    await expect(caso.run(CUERPO, DOCTORA, CLAVE)).resolves.toEqual(original);
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

  it('`not_owner` es el 403 con la frase de este endpoint, y LO DECIDE LA BASE', async () => {
    // Alguien del equipo llega con un cuerpo perfecto: quien la para es el `exists` contra
    // `practice.owner_account_id`, que es una fila y no una lista de permisos editable aquí.
    // Por eso la petición SÍ llega al repositorio — a diferencia de la paciente.
    const { caso, pedido } = armar('not_owner');

    await expect(caso.run(CUERPO, OTRA_DEL_EQUIPO, CLAVE)).rejects.toMatchObject({
      code: 'sin_permiso',
      status: 403,
      userMessage: 'Solo la dueña de la consulta puede declarar la matrícula.',
    });
    expect(pedido).toHaveLength(1);
  });

  it('una paciente no llega a abrir contexto de consulta: su token no tiene ninguno', async () => {
    const { caso, pedido } = armar();

    await expect(caso.run(CUERPO, PACIENTE, CLAVE)).rejects.toMatchObject({
      code: 'sin_permiso',
      status: 403,
    });
    expect(pedido).toEqual([]);
  });

  it('pasados los cinco guardados del día es `429 demasiados_envios`', async () => {
    // El cupo SE QUEDÓ al quitar la revisión: es un límite de escritura en un borde
    // autenticado, y quitarlo habría sido cobrar la corrección en seguridad. Lo que cambió es
    // la frase: nadie la va a revisar.
    await expect(armar('too_many').caso.run(CUERPO, DOCTORA, CLAVE)).rejects.toMatchObject({
      code: 'demasiados_envios',
      status: 429,
      userMessage: 'Guardaste tu matrícula varias veces hoy. Vuelve a intentarlo mañana.',
    });
  });

  it('un `saved` sin fecha es 500 con su causa: no se inventa una hora de declaración', async () => {
    const submission: Submission = { verdict: 'saved', declaredAt: null };
    const licenses = {
      // El `respond` del repositorio construye la respuesta DENTRO de la transacción, así
      // que este 500 salta ahí: la clave no se guarda y el reintento puede volver a
      // intentarlo de verdad, que es lo correcto para una inconsistencia del servidor.
      submit: (p: { respond: (s: Submission) => unknown }) =>
        Promise.resolve({ submission, replay: null, ...{ respondio: p.respond(submission) } }),
    };
    const caso = new SubmitLicense(licenses);

    const fallo = await caso.run(CUERPO, DOCTORA, CLAVE).catch((failure: unknown) => failure);
    expect(fallo).toBeInstanceOf(ServiceFailure);
    expect((fallo as ServiceFailure).body().error.mensaje).toBe(
      'No pudimos guardar tu matrícula. El servidor no respondió. Lo que llenaste está guardado en este teléfono: puedes volver a intentarlo.',
    );
    expect(String((fallo as ServiceFailure).cause)).toContain('updated_at');
  });
});
