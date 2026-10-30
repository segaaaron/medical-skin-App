// `GET /v1/platform/tenants/{id}` · la ficha de la consola.
//
// Lo que se fija aquí:
//   · NO HAY UN SOLO CAMPO DE PACIENTE en la respuesta, y `incidencias` nace vacía;
//   · `verificada_en` solo cuando está verificada: con un rechazo sería una fecha que miente;
//   · un `id` sin consulta es `404` y una consulta sin dueña es 500 con su causa.

import { describe, expect, it } from 'vitest';

import { ServiceFailure } from '../../../shared/contract/error-catalog';
import type { PlatformActor, TenantFile } from '../domain/platform-ports';
import { ReadTenant } from './read-tenant';

const ACTOR: PlatformActor = {
  subject: '99999999-9999-4999-8999-999999999999',
  label: 'Soporte MedSkin',
  region: 'latam',
};

const PRACTICE = '11111111-1111-4111-8111-111111111111';

const FICHA: TenantFile = {
  id: PRACTICE,
  name: 'Clínica Paz',
  plan: 'consultorio',
  patientLimit: 300,
  activePatients: 148,
  region: 'latam',
  createdOn: '2026-03-14',
  license: { status: 'verificada', decidedAt: new Date('2026-03-15T14:02:00Z') },
  appVersions: { ios: '2.4.1', android: '2.4.0' },
  owner: {
    accountId: '22222222-2222-4222-8222-222222222222',
    email: 'andrea.paz@clinicapaz.bo',
    status: 'activa',
    lockedUntil: null,
    liveSessions: 2,
  },
};

function armar(ficha: TenantFile | null = FICHA) {
  const pedido: { practiceId: string; subject: string }[] = [];
  const files = {
    read: (p: { actor: PlatformActor; practiceId: string }) => {
      pedido.push({ practiceId: p.practiceId, subject: p.actor.subject });
      return Promise.resolve(ficha);
    },
  };
  return { caso: new ReadTenant(files, 'Bolivia · bo-1'), pedido };
}

describe('GET /v1/platform/tenants/{id}', () => {
  it('sirve metadatos y estados, y ni un dato de paciente', async () => {
    const { caso, pedido } = armar();

    await expect(caso.run(PRACTICE, ACTOR)).resolves.toEqual({
      id: PRACTICE,
      nombre: 'Clínica Paz',
      plan: { clave: 'consultorio', pacientes: 148, limite_pacientes: 300 },
      region: 'latam',
      // De la configuración del despliegue, no de la base (decisión 6).
      region_etiqueta: 'Bolivia · bo-1',
      alta_en: '2026-03-14',
      licencia: { estado: 'verificada', verificada_en: '2026-03-15T14:02:00.000Z' },
      versiones_app: { ios: '2.4.1', android: '2.4.0' },
      doctora: {
        cuenta_id: FICHA.owner?.accountId,
        correo: 'andrea.paz@clinicapaz.bo',
        estado: 'activa',
        pausa_hasta: null,
        sesiones_activas: 2,
      },
      // Se alimenta de los tramos 6 y 7: hasta entonces la pantalla dibuja su estado vacío,
      // no un error.
      incidencias: [],
    });

    expect(pedido).toEqual([{ practiceId: PRACTICE, subject: ACTOR.subject }]);
  });

  it('`verificada_en` es nula en todo lo que no está verificado', async () => {
    for (const estado of ['sin_enviar', 'en_revision', 'rechazada']) {
      const { caso } = armar({
        ...FICHA,
        // Un rechazo TIENE `decided_at`, y aun así `verificada_en` va nula: un campo que se
        // llama así diciendo cuándo se rechazó sería falso.
        license: { status: estado, decidedAt: new Date('2026-03-15T14:02:00Z') },
      });
      const respuesta = await caso.run(PRACTICE, ACTOR);
      expect(respuesta.licencia).toEqual({ estado, verificada_en: null });
    }
  });

  it('una consulta sin sesiones vivas devuelve las dos versiones nulas, que también es una respuesta', async () => {
    const { caso } = armar({
      ...FICHA,
      appVersions: { ios: null, android: null },
      activePatients: 0,
    });

    const respuesta = await caso.run(PRACTICE, ACTOR);
    expect(respuesta.versiones_app).toEqual({ ios: null, android: null });
    expect(respuesta.plan.pacientes).toBe(0);
  });

  it('la pausa de la dueña viaja cuando la hay: es lo que la consola va a levantar', async () => {
    const { caso } = armar({
      ...FICHA,
      owner: { ...FICHA.owner!, status: 'activa', lockedUntil: new Date('2026-10-28T14:29:00Z') },
    });

    const respuesta = await caso.run(PRACTICE, ACTOR);
    expect(respuesta.doctora.pausa_hasta).toBe('2026-10-28T14:29:00.000Z');
  });

  it('sin consulta con ese `id` es `404 consulta_no_existe`', async () => {
    const { caso } = armar(null);

    await expect(caso.run(PRACTICE, ACTOR)).rejects.toMatchObject({
      code: 'consulta_no_existe',
      status: 404,
      userMessage: 'No encontramos esa consulta.',
    });
  });

  it('una consulta sin dueña es 500 con su causa, no una ficha a medias', async () => {
    const { caso } = armar({ ...FICHA, owner: null });

    const fallo = await caso.run(PRACTICE, ACTOR).catch((failure: unknown) => failure);
    expect(fallo).toBeInstanceOf(ServiceFailure);
    expect((fallo as ServiceFailure).body().error.mensaje).toBe(
      'No pudimos cargar la consulta. El servidor no respondió: puedes volver a intentarlo.',
    );
    expect(String((fallo as ServiceFailure).cause)).toContain(PRACTICE);
  });
});
