// `GET /v1/tenants/mine` · lo que el contrato promete de `PrimerDia` y de `Licencia` · 2.
//
// Lo que se fija aquí:
//   · `puede` se DERIVA del estado de la licencia y viaja resuelto, porque la app lo lee;
//   · `pacientes` es el recuento de fichas `activa` que trae el puerto, el mismo que usa la
//     consola: el caso de uso no lo vuelve a calcular ni lo filtra;
//   · una paciente recibe `403 rol_no_corresponde` ANTES de que se abra una transacción;
//   · un inquilino sin consulta que servir es un 500 con su frase, nunca una respuesta
//     inventada.

import { describe, expect, it } from 'vitest';

import { ContractError, ServiceFailure } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import type { PracticeOwner, PracticeSnapshot } from '../domain/ports';
import { ReadOwnPractice } from './read-own-practice';

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

const PACIENTE: Caller = {
  ...DOCTORA,
  role: 'paciente',
  accountRole: 'paciente',
  practiceId: null,
};

const CONSULTA: PracticeSnapshot = {
  id: DOCTORA.practiceId!,
  name: 'Clínica Paz',
  address: 'Av. Ballivián 1240',
  city: 'Santa Cruz',
  phone: '+591 3 342 1180',
  logoUrl: null,
  region: 'latam',
  timeZone: 'America/La_Paz',
  currency: 'BOB',
  plan: 'consultorio',
  patientLimit: 300,
  planRenewsOn: '2026-11-14',
  activePatients: 148,
  license: {
    status: 'en_revision',
    submittedAt: new Date('2026-10-26T22:24:00Z'),
    responseEstimatedAt: new Date('2026-10-28T22:24:00Z'),
    rejectionReason: null,
  },
  firstDay: { practiceData: false, schedule: false, firstTreatment: false, dismissed: false },
};

function armar(consulta: PracticeSnapshot | null = CONSULTA) {
  const pedido: PracticeOwner[] = [];
  const practices = {
    read: (owner: PracticeOwner) => {
      pedido.push(owner);
      return Promise.resolve(consulta);
    },
  };
  return { caso: new ReadOwnPractice(practices), pedido };
}

describe('GET /v1/tenants/mine', () => {
  it('sirve la consulta entera con su plan, su licencia y su primer día', async () => {
    const { caso, pedido } = armar();

    await expect(caso.run(DOCTORA)).resolves.toEqual({
      id: CONSULTA.id,
      nombre: 'Clínica Paz',
      direccion: 'Av. Ballivián 1240',
      ciudad: 'Santa Cruz',
      telefono: '+591 3 342 1180',
      logo_url: null,
      region: 'latam',
      zona_horaria: 'America/La_Paz',
      moneda: 'BOB',
      plan: {
        clave: 'consultorio',
        nombre: 'Consultorio',
        limite_pacientes: 300,
        pacientes: 148,
        renueva_en: '2026-11-14',
      },
      licencia: {
        estado: 'en_revision',
        enviada_en: '2026-10-26T22:24:00.000Z',
        respuesta_estimada_en: '2026-10-28T22:24:00.000Z',
        motivo_rechazo: null,
      },
      puede: {
        invitar_pacientes: false,
        registrar_sesiones: false,
        armar_catalogo: true,
        definir_horarios: true,
      },
      primer_dia: {
        visible: true,
        datos_consulta: false,
        horarios: false,
        primer_tratamiento: false,
      },
    });

    // Quien pregunta sale del TOKEN y de nada más: ni un identificador del cuerpo o de la
    // URL llega al puerto (OWASP A01).
    expect(pedido).toEqual([{ accountId: DOCTORA.accountId, practiceId: DOCTORA.practiceId }]);
  });

  it('con la licencia verificada abre invitar y registrar, y es lo único que cambia', async () => {
    const { caso } = armar({
      ...CONSULTA,
      license: { ...CONSULTA.license, status: 'verificada', responseEstimatedAt: null },
    });

    const respuesta = await caso.run(DOCTORA);
    expect(respuesta.puede).toEqual({
      invitar_pacientes: true,
      registrar_sesiones: true,
      armar_catalogo: true,
      definir_horarios: true,
    });
    expect(respuesta.licencia.estado).toBe('verificada');
    expect(respuesta.licencia.respuesta_estimada_en).toBeNull();
  });

  it('con el plan en su tope no puede invitar, aunque la licencia esté verificada', async () => {
    const { caso } = armar({
      ...CONSULTA,
      activePatients: 300,
      patientLimit: 300,
      license: { ...CONSULTA.license, status: 'verificada' },
    });

    const respuesta = await caso.run(DOCTORA);
    // El candado se pinta ANTES de que ella escriba el alta de una paciente y la pierda
    // contra el `409` de `pacientes.md`, que se queda como red.
    expect(respuesta.puede.invitar_pacientes).toBe(false);
    expect(respuesta.puede.registrar_sesiones).toBe(true);
    // Y el número que lo justifica viaja en la misma respuesta: «300 de 300».
    expect(respuesta.plan).toMatchObject({ pacientes: 300, limite_pacientes: 300 });
  });

  it('un rechazo viaja con su motivo: la doctora lo va a leer', async () => {
    const { caso } = armar({
      ...CONSULTA,
      license: {
        status: 'rechazada',
        submittedAt: new Date('2026-10-26T22:24:00Z'),
        responseEstimatedAt: null,
        rejectionReason: 'La credencial está vencida: manda la vigente.',
      },
    });

    const respuesta = await caso.run(DOCTORA);
    expect(respuesta.licencia.motivo_rechazo).toBe('La credencial está vencida: manda la vigente.');
    expect(respuesta.puede.invitar_pacientes).toBe(false);
  });

  it('la lista del primer día desaparece cuando ella la cerró, no cuando están las tres hechas', async () => {
    const tresHechas = { practiceData: true, schedule: true, firstTreatment: true };

    const abierta = await armar({
      ...CONSULTA,
      firstDay: { ...tresHechas, dismissed: false },
    }).caso.run(DOCTORA);
    // «Esta lista desaparece la próxima vez que abras la app»: todavía se dibuja una vez más.
    expect(abierta.primer_dia).toEqual({
      visible: true,
      datos_consulta: true,
      horarios: true,
      primer_tratamiento: true,
    });

    const cerrada = await armar({
      ...CONSULTA,
      firstDay: { ...tresHechas, dismissed: true },
    }).caso.run(DOCTORA);
    expect(cerrada.primer_dia.visible).toBe(false);
  });

  it('una paciente recibe `403 rol_no_corresponde` y no se le abre ninguna transacción', async () => {
    const { caso, pedido } = armar();

    await expect(caso.run(PACIENTE)).rejects.toMatchObject({
      code: 'rol_no_corresponde',
      status: 403,
      userMessage: 'Esta pantalla no es de tu cuenta.',
    });
    expect(pedido).toEqual([]);
  });

  it('un token de consulta sin `practice` tampoco se atiende, y falla cerrado', async () => {
    const { caso } = armar();
    const sinInquilino: Caller = { ...DOCTORA, practiceId: null };

    await expect(caso.run(sinInquilino)).rejects.toBeInstanceOf(ContractError);
  });

  it('sin consulta que servir es 500 con la frase del contrato, y la causa no sale al cliente', async () => {
    const { caso } = armar(null);

    const fallo = await caso.run(DOCTORA).catch((failure: unknown) => failure);
    expect(fallo).toBeInstanceOf(ServiceFailure);
    expect((fallo as ServiceFailure).body()).toEqual({
      error: {
        codigo: 'fallo_de_servicio',
        mensaje:
          'No pudimos cargar tu consulta. El servidor no respondió. Te mostramos lo último guardado: puedes volver a intentarlo.',
        campo: null,
      },
    });
    // La causa real viaja aparte, hacia `service_failure`, y nunca hacia el cliente.
    expect(String((fallo as ServiceFailure).cause)).toContain(DOCTORA.practiceId);
  });
});
