// POST /v1/platform/accounts/{account_id}/access/resend · «Reenviar la contraseña temporal
// · Va a su propio correo. Soporte no la ve.» (`Consola.dc.html` · 2).
//
// ES EL ÚNICO ENDPOINT DEL TRAMO QUE ACUÑA UNA CREDENCIAL SIN DEVOLVERLA, y esa diferencia
// con el reenvío de la doctora es la razón de que exista: soporte no es parte de la relación
// médico-paciente, así que no puede dictarle la contraseña a nadie —no la tiene—. La
// respuesta es `{ enviado_en, caduca_en }` y nada más, y eso no se cumple aquí: lo cumple la
// base, porque la función devuelve dos columnas y ninguna es la contraseña.
//
// EL PERMISO NO SE VUELVE A COMPROBAR. Si este caso de uso corre, `plataforma:acceso:reenviar`
// ya venía en un token firmado por el servicio de plataforma y lo verificó el guardia.
// Comprobarlo dos veces son dos autorizaciones que se pueden desacordar, y la que manda es la
// de la tabla de rutas.
//
// NO ES IDEMPOTENTE, igual que los otros dos reenvíos: cada llamada acuña una contraseña
// nueva y mata la anterior, así que repetir la respuesta de la primera diría que vale una
// contraseña ya muerta.

import {
  ContractError,
  FAILURE_PHRASES,
  ServiceFailure,
} from '../../../shared/contract/error-catalog';
import type { PasswordHasher } from '../../access/domain/ports';
import type { PlatformDeliveryFacts } from '../domain/access-delivery';
import type {
  ConsoleActor,
  PlatformAccessMailPort,
  PlatformAccessPort,
} from '../domain/ports';
import { mintTemporaryPassword, temporaryPasswordExpiry } from '../domain/temporary-password';
import type { RegistrationClock } from './register-patient';

export type PlatformResendResponse = {
  enviado_en: string;
  caduca_en: string;
};

export class ResendPlatformAccess {
  constructor(
    private readonly accounts: PlatformAccessPort,
    private readonly passwords: PasswordHasher,
    private readonly clock: RegistrationClock,
    private readonly mail: PlatformAccessMailPort,
  ) {}

  async run(accountId: string, actor: ConsoleActor): Promise<PlatformResendResponse> {
    const now = this.clock.now();
    const expiresAt = temporaryPasswordExpiry(now);
    const temporary = mintTemporaryPassword();

    const renewed = await this.accounts.resend({
      actor,
      accountId,
      hash: await this.passwords.hash(temporary),
      expiresAt,
    });

    // El 404 es uno solo e indistinguible: una cuenta que no existe, una borrada y una de
    // otra región responden lo mismo. Y el 409 es la misma regla que la de la doctora: una
    // contraseña ya elegida no se resetea desde fuera, la recuperación es de ella y de su
    // correo.
    if (renewed.outcome === 'cuenta_no_existe') throw new ContractError('cuenta_no_existe');
    if (renewed.outcome === 'ya_eligio_su_contrasena') {
      throw new ContractError('ya_eligio_su_contrasena');
    }
    if (renewed.email === null || renewed.expiresAt === null) {
      // Sin el correo no hay a dónde escribir, y aquí la temporal ya está acuñada: no se
      // calla, se registra con su causa.
      throw new ServiceFailure(
        FAILURE_PHRASES.resendPlatformAccess,
        new Error(`el reenvío de la cuenta ${accountId} no devolvió a dónde escribir`),
      );
    }

    const facts: PlatformDeliveryFacts = {
      email: renewed.email,
      temporaryPassword: temporary,
      expiryText: `Caduca el ${this.clock.localLongWhen(renewed.expiresAt)}`,
    };

    // EN LÍNEA Y NO POR COLA, por la misma razón que los otros dos envíos de acceso: por aquí
    // la temporal ya está acuñada, así que encolar obligaría a meterla EN CLARO en Redis.
    await this.send(facts, accountId);

    return {
      // `enviado_en` es cuándo el relé aceptó el mensaje, no cuándo llegó a su bandeja: lo
      // segundo no se puede saber desde aquí y prometerlo sería mentir.
      enviado_en: this.clock.now().toISOString(),
      caduca_en: renewed.expiresAt.toISOString(),
    };
  }

  /**
   * Un envío que falla es un 500, nunca un 200 que miente. Y aquí la frase del contrato sirve
   * tal cual —«puedes volver a intentarlo»— porque es verdad: reintentar vuelve a acuñar y a
   * mandar, al contrario que en el alta de equipo, donde el reintento daba `409`.
   *
   * No hay nada que compensar: esta ruta no escribe ninguna columna que afirme un envío
   * —`patient_link` no existe para `app_platform`— y la línea de `access_audit` dice
   * `acceso_pedido`, que es verdad aunque el relé se cayera.
   */
  private async send(facts: PlatformDeliveryFacts, accountId: string): Promise<void> {
    try {
      await this.mail.sendAccess(facts);
    } catch (cause) {
      // Ni el correo ni la contraseña entran en la causa: solo la cuenta (§10.3).
      throw new ServiceFailure(
        FAILURE_PHRASES.resendPlatformAccess,
        new Error(`no se pudo reenviar el acceso de la cuenta ${accountId}`, { cause }),
      );
    }
  }
}
