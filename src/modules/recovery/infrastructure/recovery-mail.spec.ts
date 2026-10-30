// El correo del código. El contrato es exigente con él y por eso tiene prueba:
//
//   · el asunto es «Tu código de MedSkin» Y NADA MÁS, porque es lo que se lee en la
//     pantalla bloqueada del teléfono (§11.1);
//   · lleva el aviso antiestafa y la salida para quien no lo pidió, los dos literales;
//   · y no lleva NADA de la consulta: ni nombre de doctora, ni tratamiento, ni clínica.
//
// La última es la que una plantilla «mejorada» rompe sin que nadie lo note.

import { describe, expect, it } from 'vitest';

import type { MailMessage, MailPort } from '../../../shared/mail/mailer';
import {
  ANTI_SCAM,
  NOT_YOU,
  RECOVERY_SUBJECT,
  RecoveryMail,
  recoveryMailBody,
} from './recovery-mail';

const CADUCA = new Date('2026-10-27T13:28:00.000Z');
const RELOJ = { localTime: () => '09:28' };

describe('el correo del código', () => {
  it('el asunto es exactamente el del contrato', () => {
    expect(RECOVERY_SUBJECT).toBe('Tu código de MedSkin');
  });

  it('el cuerpo lleva el código, la hora, el aviso antiestafa y la salida', () => {
    const cuerpo = recoveryMailBody({ code: '418203', expiresAt: CADUCA, clock: RELOJ });

    expect(cuerpo).toContain('418203');
    expect(cuerpo).toContain('Caduca a las 09:28');
    expect(cuerpo).toContain(ANTI_SCAM);
    expect(cuerpo).toContain(NOT_YOU);
  });

  it('las dos frases son las del contrato, palabra por palabra', () => {
    expect(ANTI_SCAM).toBe(
      'Nadie de MedSkin ni de tu clínica te va a pedir este código por teléfono, por WhatsApp ni por correo. Si alguien te lo pide, no se lo des.',
    );
    expect(NOT_YOU).toBe(
      'Si no pediste el código, ignóralo: tu contraseña de ahora sigue valiendo y nadie ha entrado.',
    );
  });

  it('no dice ni una palabra de la consulta, del tratamiento ni de para qué es MedSkin', () => {
    // Las dos frases literales se descuentan: el aviso antiestafa SÍ dice «tu clínica», y
    // tiene que decirlo, porque es la clínica la que no va a pedir el código. Lo que se
    // comprueba es lo que la plantilla añade por su cuenta.
    const cuerpo = recoveryMailBody({ code: '418203', expiresAt: CADUCA, clock: RELOJ })
      .replace(ANTI_SCAM, '')
      .replace(NOT_YOU, '');

    // La lista está en ESPAÑOL a propósito: es el idioma del correo que lee la persona, y
    // lo que se comprueba es que ninguna de esas palabras aparezca en el cuerpo. No tiene
    // nada que ver con los valores de rol, que sí son inglés.
    for (const prohibida of [
      'doctora',
      'Dra',
      'clínica',
      'consulta',
      'tratamiento',
      'cita',
      'paciente',
      'piel',
    ]) {
      expect(cuerpo.toLowerCase(), prohibida).not.toContain(prohibida.toLowerCase());
    }
  });

  it('se manda al correo que llegó, con el asunto del contrato y en texto plano', async () => {
    const mandados: MailMessage[] = [];
    const mail: MailPort = {
      send: (mensaje) => {
        mandados.push(mensaje);
        return Promise.resolve();
      },
    };

    await new RecoveryMail(mail, RELOJ).sendCode({
      email: 'carla.rojas@gmail.com',
      code: '418203',
      expiresAt: CADUCA,
    });

    expect(mandados).toHaveLength(1);
    expect(mandados[0]?.to).toBe('carla.rojas@gmail.com');
    expect(mandados[0]?.subject).toBe(RECOVERY_SUBJECT);
    // Texto plano: un correo con HTML y una imagen de seguimiento diría cuándo y desde
    // dónde se abrió, y esto lo abre una paciente de una clínica de estética.
    expect(Object.keys(mandados[0] ?? {}).sort()).toEqual(['subject', 'text', 'to']);
  });
});
