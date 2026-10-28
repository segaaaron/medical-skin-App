// El correo del acceso de la paciente. Lo que esta prueba defiende:
//
//   · el asunto es «Tu acceso a MedSkin» y NADA MÁS —ni clínica, ni doctora, ni
//     tratamiento—, porque es lo que se lee en la pantalla bloqueada del teléfono (§11.1);
//   · el cuerpo lleva lo que ella necesita para entrar y ni un dato clínico;
//   · y va en texto plano, sin HTML y sin imagen de seguimiento.

import { describe, expect, it } from 'vitest';

import type { MailMessage, MailPort } from '../../../shared/mail/mailer';
import { accessMailBody, type DeliveryFacts } from '../domain/access-delivery';
import { ACCESS_SUBJECT, PatientAccessMail } from './patient-access-mail';

const VALERIA: DeliveryFacts = {
  patientFirstName: 'Valeria',
  patientEmail: 'valeria.antelo@gmail.com',
  practitionerName: 'Dra. Andrea Paz',
  temporaryPassword: 'tejado-lila-07',
  expiryText: 'Caduca el jueves 30 a las 18:24',
};

describe('el correo del acceso', () => {
  it('el asunto no dice de qué es la clínica, ni quién escribe, ni para qué', () => {
    expect(ACCESS_SUBJECT).toBe('Tu acceso a MedSkin');
  });

  it('el cuerpo lleva el correo con el que entra, la contraseña y qué pasa al entrar', () => {
    const cuerpo = accessMailBody(VALERIA);

    expect(cuerpo).toContain('valeria.antelo@gmail.com');
    expect(cuerpo).toContain('tejado-lila-07');
    expect(cuerpo).toContain('Caduca en 72 horas y al entrar eliges la tuya.');
  });

  it('no dice ni un dato clínico', () => {
    const cuerpo = accessMailBody(VALERIA).toLowerCase();

    for (const prohibida of [
      'diagnos',
      'alergia',
      'embarazo',
      'medicacion',
      'sesion de',
      'foto',
      'piel',
    ]) {
      expect(cuerpo, prohibida).not.toContain(prohibida);
    }
  });

  it('se manda al correo de la ficha, con ese asunto y en texto plano', async () => {
    const mandados: MailMessage[] = [];
    const mail: MailPort = {
      send: (mensaje) => {
        mandados.push(mensaje);
        return Promise.resolve();
      },
    };

    await new PatientAccessMail(mail).sendAccess(VALERIA);

    expect(mandados[0]?.to).toBe('valeria.antelo@gmail.com');
    expect(mandados[0]?.subject).toBe(ACCESS_SUBJECT);
    expect(Object.keys(mandados[0] ?? {}).sort()).toEqual(['subject', 'text', 'to']);
  });
});
