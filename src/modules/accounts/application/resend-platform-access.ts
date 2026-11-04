// POST /v1/platform/accounts/{account_id}/access/resend · «Reenviar la contraseña temporal
// · Va a su propio correo. Soporte no la ve.» (`Consola.dc.html` · 2).
//
// ES EL ÚNICO ENDPOINT DEL TRAMO QUE GENERA UNA CREDENCIAL SIN DEVOLVERLA, y esa diferencia
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
// NO ES IDEMPOTENTE, igual que los otros dos reenvíos: cada llamada genera una contraseña
// nueva y invalida la anterior, así que repetir la respuesta de la primera diría que vale una
// contraseña ya invalidada.

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
  /**
   * EL PIN QUE SE ACABA DE GENERAR, y está aquí por decisión del dueño del 4 de noviembre de
   * 2026, en contra de lo que estas dos rutas dijeron hasta hoy («Va a su propio correo.
   * Soporte no la ve»).
   *
   * EL CASO QUE LO PIDE: soporte genera una temporal nueva, con eso INVALIDA la anterior, y si el
   * correo de la cuenta está mal escrito —que es justo cuando alguien llama a soporte— lo
   * único que ha conseguido es dejar a esa persona sin la que tenía y sin la nueva.
   *
   * LO QUE CUESTA, dicho aquí para que nadie lo descubra dentro de seis meses: quien tiene
   * `plataforma:acceso:reenviar` o `plataforma:acceso:resetear` puede ahora LEER la credencial
   * que genera, y dictarla por teléfono o por chat. Por eso cada llamada deja
   * `credencial_vista: true` en `access_audit`: lo que se concede se puede auditar.
   *
   * LO QUE SIGUE SIN PODERSE, y no es negociable aquí: consultar una contraseña YA EXISTENTE.
   * No se guarda en claro en ninguna parte —solo su hash de Argon2id—, así que lo que viaja
   * es la que esta misma llamada acaba de crear, en el momento en que existe, y nada más.
   */
  contrasena_temporal: string;
};

export class ResendPlatformAccess {
  constructor(
    private readonly accounts: PlatformAccessPort,
    private readonly passwords: PasswordHasher,
    private readonly clock: RegistrationClock,
    private readonly mail: PlatformAccessMailPort,
  ) {}

  /**
   * `force` es el RESETEO (`POST …/access/reset`, 4 de noviembre de 2026): el mismo camino
   * entero —generar, mandar al correo de la persona y devolver el PIN a la consola— contra la
   * función que SÍ sobrescribe una credencial ya elegida. Lo que separa a las dos acciones no es este
   * booleano: es el permiso de la tabla de rutas y el `GRANT EXECUTE` de cada función. Aquí
   * solo cambia a qué función se llama, qué dice la auditoría y qué frase lleva el 500.
   */
  async run(accountId: string, actor: ConsoleActor, force = false): Promise<PlatformResendResponse> {
    const now = this.clock.now();
    const expiresAt = temporaryPasswordExpiry(now);
    const temporary = mintTemporaryPassword();
    const phrase = force
      ? FAILURE_PHRASES.resetPlatformAccess
      : FAILURE_PHRASES.resendPlatformAccess;

    const renewed = await this.accounts.resend({
      actor,
      accountId,
      hash: await this.passwords.hash(temporary),
      expiresAt,
      force,
    });

    // El 404 es uno solo e indistinguible: una cuenta que no existe, una borrada y una de
    // otra región responden lo mismo. Y el 409 es la misma regla que la de la doctora: una
    // contraseña ya elegida no se resetea desde fuera, la recuperación es de ella y de su
    // correo.
    if (renewed.outcome === 'cuenta_no_existe') throw new ContractError('cuenta_no_existe');
    // Con `force` este resultado NO PUEDE volver: `medskin_platform_reset_access` no hace esa
    // pregunta, que es justamente para lo que existe. La rama se queda porque el reenvío sigue
    // siendo el camino normal y es su regla.
    if (renewed.outcome === 'ya_eligio_su_contrasena') {
      throw new ContractError('ya_eligio_su_contrasena');
    }
    if (renewed.email === null || renewed.expiresAt === null) {
      // Sin el correo no hay a dónde escribir, y aquí la temporal ya está generada: no se
      // calla, se registra con su causa.
      throw new ServiceFailure(
        phrase,
        new Error(`el reenvío de la cuenta ${accountId} no devolvió a dónde escribir`),
      );
    }

    const facts: PlatformDeliveryFacts = {
      email: renewed.email,
      temporaryPassword: temporary,
      expiryText: `Caduca el ${this.clock.localLongWhen(renewed.expiresAt)}`,
    };

    // EN LÍNEA Y NO POR COLA, por la misma razón que los otros dos envíos de acceso: por aquí
    // la temporal ya está generada, así que encolar obligaría a meterla EN CLARO en Redis.
    await this.send(facts, accountId, phrase);

    return {
      // `enviado_en` es cuándo el reenvío aceptó el mensaje, no cuándo llegó a su bandeja: lo
      // segundo no se puede saber desde aquí y especificarlo sería informar en falso.
      enviado_en: this.clock.now().toISOString(),
      caduca_en: renewed.expiresAt.toISOString(),
      // Se devuelve DESPUÉS de que el correo saliera, no antes: si el reenvío falla esto es un
      // 500 y la consola no se queda con un PIN que además nadie recibió.
      contrasena_temporal: temporary,
    };
  }

  /**
   * Un envío que falla es un 500, nunca un 200 que informa en falso. Y aquí la frase del contrato sirve
   * tal cual —«puedes volver a intentarlo»— porque es verdad: reintentar vuelve a generar y a
   * mandar, al contrario que en el alta de equipo, donde el reintento daba `409`.
   *
   * No hay nada que compensar: esta ruta no escribe ninguna columna que afirme un envío
   * —`patient_link` no existe para `app_platform`— y la línea de `access_audit` dice
   * `acceso_pedido`, que es verdad aunque el reenvío se cayera.
   */
  private async send(
    facts: PlatformDeliveryFacts,
    accountId: string,
    phrase: string,
  ): Promise<void> {
    try {
      await this.mail.sendAccess(facts);
    } catch (cause) {
      // Ni el correo ni la contraseña entran en la causa: solo la cuenta (§10.3).
      throw new ServiceFailure(
        phrase,
        new Error(`no se pudo mandar el acceso de la cuenta ${accountId}`, { cause }),
      );
    }
  }
}
