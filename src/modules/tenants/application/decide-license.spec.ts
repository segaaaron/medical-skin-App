// `POST /v1/platform/tenants/{id}/license/decision` · los cuatro resultados que la
// base distingue, traducidos a la tabla del contrato.
//
// Lo que se fija aquí:
//   · verificar abre invitar y registrar; rechazar las deja cerradas y no borra nada;
//   · los tres `4xx` son los del contrato, incluido `409 licencia_sin_enviar`, que existe
//     porque la base distingue tres casos y el contrato nombraba dos;
//   · el cupo del plan entra en `puede` también aquí: una consulta en su tope no puede
//     invitar el mismo día que se le verifica la licencia.

import { describe, expect, it } from 'vitest';

import type {
  DecidedLicense,
  DecisionOutcome,
  DecisionResult,
  PlatformActor,
} from '../domain/platform-ports';
import { DecideLicense } from './decide-license';

const ACTOR: PlatformActor = {
  subject: '99999999-9999-4999-8999-999999999999',
  label: 'Soporte MedSkin',
  region: 'latam',
};

const PRACTICE = '11111111-1111-4111-8111-111111111111';
const DECIDIDA = new Date('2026-10-28T15:40:00Z');

type Opciones = {
  outcome?: DecisionOutcome;
  activePatients?: number;
  patientLimit?: number;
};

function armar(opciones: Opciones = {}) {
  const outcome = opciones.outcome ?? 'decided';
  const pedido: { practiceId: string; status: string; reason: string | null; label: string }[] = [];

  const licenses = {
    decide: <T>(p: {
      actor: PlatformActor;
      practiceId: string;
      decision: { status: string; rejectionReason: string | null };
      respond: (decided: DecidedLicense) => T;
    }): Promise<DecisionResult<T>> => {
      pedido.push({
        practiceId: p.practiceId,
        status: p.decision.status,
        reason: p.decision.rejectionReason,
        label: p.actor.label,
      });
      if (outcome !== 'decided') {
        return Promise.resolve({ outcome, served: null } as DecisionResult<T>);
      }
      return Promise.resolve({
        outcome: 'decided',
        served: {
          replayed: false,
          status: 200,
          response: p.respond({
            status: p.decision.status,
            decidedAt: DECIDIDA,
            activePatients: opciones.activePatients ?? 148,
            patientLimit: opciones.patientLimit ?? 300,
          }),
        },
      });
    },
  };

  return { caso: new DecideLicense(licenses), pedido };
}

const CLAVE = { key: 'consola-decision', bodyHash: 'huella-decision' };

describe('POST /v1/platform/tenants/{id}/license/decision', () => {
  it('verificar devuelve el 200 del contrato y abre invitar y registrar', async () => {
    const { caso, pedido } = armar();

    const served = await caso.run({ decision: 'verificada' }, PRACTICE, ACTOR, CLAVE);
    expect(served.status).toBe(200);
    expect(served.response).toEqual({
      estado: 'verificada',
      decidida_en: '2026-10-28T15:40:00.000Z',
      puede: {
        invitar_pacientes: true,
        registrar_sesiones: true,
        armar_catalogo: true,
        definir_horarios: true,
      },
    });
    // Quién decide sale del token: el `label` viaja a la bitácora y el cuerpo no lo elige.
    expect(pedido).toEqual([
      { practiceId: PRACTICE, status: 'verificada', reason: null, label: 'Soporte MedSkin' },
    ]);
  });

  it('una consulta en su tope no puede invitar aunque se le acabe de verificar', async () => {
    const { caso } = armar({ activePatients: 300, patientLimit: 300 });

    const served = await caso.run({ decision: 'verificada' }, PRACTICE, ACTOR, CLAVE);
    expect(served.response.puede.invitar_pacientes).toBe(false);
    expect(served.response.puede.registrar_sesiones).toBe(true);
  });

  it('rechazar lleva su motivo a la base y deja los candados puestos', async () => {
    const { caso, pedido } = armar();

    const served = await caso.run(
      { decision: 'rechazada', motivo_rechazo: 'La credencial está vencida: manda la vigente.' },
      PRACTICE,
      ACTOR,
      CLAVE,
    );

    expect(served.response.estado).toBe('rechazada');
    expect(served.response.puede).toEqual({
      invitar_pacientes: false,
      registrar_sesiones: false,
      // Rechazar no borra nada: la doctora sigue con su catálogo y sus horarios.
      armar_catalogo: true,
      definir_horarios: true,
    });
    expect(pedido[0]?.reason).toBe('La credencial está vencida: manda la vigente.');
  });

  it('un rechazo sin motivo no llega a la base', async () => {
    const { caso, pedido } = armar();

    await expect(caso.run({ decision: 'rechazada' }, PRACTICE, ACTOR, CLAVE)).rejects.toMatchObject({
      code: 'motivo_rechazo_vacio',
      status: 400,
      field: 'motivo_rechazo',
    });
    expect(pedido).toEqual([]);
  });

  it('los tres resultados que no son una decisión son los tres errores del contrato', async () => {
    const esperados = [
      ['no_license', 'licencia_no_existe', 404],
      ['not_submitted', 'licencia_sin_enviar', 409],
      ['already_decided', 'licencia_ya_decidida', 409],
    ] as const;

    for (const [outcome, codigo, status] of esperados) {
      await expect(
        armar({ outcome }).caso.run({ decision: 'verificada' }, PRACTICE, ACTOR, CLAVE),
      ).rejects.toMatchObject({ code: codigo, status });
    }
  });
});
