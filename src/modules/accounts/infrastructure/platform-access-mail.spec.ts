// El correo del reenvío de la consola. Lo que esta prueba defiende:
//
//   · el asunto es el MISMO que el de los otros accesos, «Tu acceso a MedSkin»: lo que se lee
//     en la pantalla bloqueada no dice que soporte estuvo en medio, ni de qué clínica es;
//   · el cuerpo no se presenta en nombre de ninguna doctora —soporte no puede leer quién es—
//     y no saluda por el nombre, porque `app_platform` no lee ese nombre de `account`;
//   · y lleva la contraseña, que es el punto: va aquí y NO en la respuesta del endpoint.

import { describe, expect, it } from 'vitest';

import type { MailMessage, MailPort } from '../../../shared/mail/mailer';
import { platformAccessMailBody, type PlatformDeliveryFacts } from '../domain/access-delivery';
import { ACCESS_SUBJECT } from './patient-access-mail';
import { PlatformAccessMail } from './platform-access-mail';

const ROCIO: PlatformDeliveryFacts = {
  email: 'rocio.vargas@gmail.com',
  temporaryPassword: 'tejado-lila-07',
  expiryText: 'Caduca el jueves 30 a las 18:24',
};

describe('el correo del reenvío de la consola', () => {
  it('lleva el correo con el que entra y la contraseña, que es lo que la respuesta no lleva', () => {
    const cuerpo = platformAccessMailBody(ROCIO);

    expect(cuerpo).toContain('rocio.vargas@gmail.com');
    expect(cuerpo).toContain('tejado-lila-07');
    expect(cuerpo).toContain('Caduca en 72 horas y al entrar eliges la tuya.');
  });

  it('no nombra a ninguna doctora, ninguna clínica, ni a soporte', () => {
    const cuerpo = platformAccessMailBody(ROCIO).toLowerCase();

    for (const prohibida of ['dra.', 'doctora', 'clínica', 'consulta', 'soporte', 'tratamiento']) {
      expect(cuerpo, prohibida).not.toContain(prohibida);
    }
  });

  it('va a su propio correo y con el mismo asunto de siempre', async () => {
    const mandados: MailMessage[] = [];
    const mail: MailPort = {
      send: (mensaje) => {
        mandados.push(mensaje);
        return Promise.resolve();
      },
    };

    await new PlatformAccessMail(mail).sendAccess(ROCIO);

    expect(mandados[0]?.to).toBe('rocio.vargas@gmail.com');
    expect(mandados[0]?.subject).toBe(ACCESS_SUBJECT);
    // Texto plano, sin HTML y sin imagen de seguimiento.
    expect(Object.keys(mandados[0] ?? {}).sort()).toEqual(['subject', 'text', 'to']);
  });
});
