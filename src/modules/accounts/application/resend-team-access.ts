// POST /v1/team/{member_id}/access · la dueña vuelve a mandarle el acceso a su equipo.
//
// POR QUÉ EXISTE: si el relé falla después de crear al miembro, la cuenta ya está creada y
// reintentar el alta devuelve `409 correo_no_disponible`. Sin este endpoint quedaba una
// persona con cuenta, con una temporal que nadie recibió, y la única salida era escribir a
// soporte (`cuentas.md` · «El hueco que obliga a un endpoint más»).
//
// ES EL REENVÍO DE PACIENTES CON OTRO SUJETO, a propósito: mismo rol, mismo contador de 3
// por hora y en la MISMA clave de Redis, misma regla de que la contraseña no viaja en la
// respuesta porque va por correo, y mismo 500 que admite que la anterior ya no vale. Lo que
// cambia es que un miembro del equipo no tiene `patient_link`, y por eso la función de base
// es otra.
//
// EL ORDEN, Y ES LO MISMO QUE EN EL DE PACIENTES: el miembro se busca ANTES de acuñar y
// antes de gastar contador. Si se acuñara primero, un `miembro_id` equivocado habría matado
// la temporal de alguien para devolver un 404.

import { ContractError, FAILURE_PHRASES, ServiceFailure } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import type { PasswordHasher } from '../../access/domain/ports';
import type { TeamDeliveryFacts } from '../domain/access-delivery';
import type {
  AccountOwner,
  ResendLimitPort,
  TeamAccessMailPort,
  TeamAccessPort,
} from '../domain/ports';
import { TEAM_PERMISSION } from '../domain/team';
import { mintTemporaryPassword, temporaryPasswordExpiry } from '../domain/temporary-password';
import type { AccessBlock, DeliveryClock } from './send-patient-access';

export class ResendTeamAccess {
  constructor(
    private readonly team: TeamAccessPort,
    private readonly passwords: PasswordHasher,
    private readonly limit: ResendLimitPort,
    private readonly clock: DeliveryClock,
    private readonly mail: TeamAccessMailPort,
  ) {}

  async run(practitionerId: string, caller: Caller): Promise<AccessBlock> {
    // El permiso del token, y además ser LA DUEÑA, que lo comprueba la función antes de
    // mirar al miembro para que sus veredictos no sirvan de sonda.
    if (!caller.permissions.includes(TEAM_PERMISSION)) throw this.noPermission();

    const owner = ownerOf(caller);
    const member = await this.team.forDelivery(owner, practitionerId);
    // Un `miembro_id` de otra consulta, retirado, con la cuenta borrada o el de quien
    // llama: el mismo 404 que uno inventado, y sin gastar contador.
    if (member === null) throw new ContractError('miembro_no_existe');

    if ((await this.limit.count(member.accountId)).tooMany) {
      throw new ContractError('demasiados_reenvios');
    }

    const now = this.clock.now();
    const expiresAt = temporaryPasswordExpiry(now);
    const temporary = mintTemporaryPassword();

    const { outcome, email } = await this.team.resend({
      owner,
      practitionerId,
      accountId: member.accountId,
      hash: await this.passwords.hash(temporary),
      expiresAt,
    });

    switch (outcome) {
      case 'not_owner':
        throw this.noPermission();
      case 'member_not_found':
        throw new ContractError('miembro_no_existe');
      case 'ya_eligio_su_contrasena':
        // La dueña no es dueña del acceso de su recepcionista una vez elegido, igual que la
        // doctora no lo es del de su paciente. La frase es la de este endpoint.
        throw new ContractError(
          'ya_eligio_su_contrasena',
          undefined,
          'Ya eligió su contraseña. Dile que use «Olvidé mi contraseña».',
        );
      default:
        break;
    }

    if (email === null) {
      // `acceso_renovado` sin correo es una inconsistencia del servidor: la temporal está
      // acuñada y no hay a dónde mandarla. Va a `service_failure` con su causa real.
      throw new ServiceFailure(
        FAILURE_PHRASES.resendTeamAccess,
        new Error('medskin_resend_team_access renovó el acceso y no devolvió correo'),
      );
    }

    const expiryText = `Caduca el ${this.clock.localLongWhen(expiresAt)}`;
    await this.sendMail(
      {
        firstName: member.firstName,
        email,
        practiceName: member.practiceName,
        temporaryPassword: temporary,
        expiryText,
      },
      member.accountId,
    );

    return {
      via: 'correo',
      // «El relé aceptó el mensaje», no «llegó a su bandeja»: lo segundo no se puede saber
      // desde aquí y prometerlo sería mentir.
      enviado: true,
      // Por correo la temporal no viaja: que la dueña la lea no aporta nada y expone la
      // credencial de otra persona adulta.
      contrasena_temporal: null,
      caduca_en: expiresAt.toISOString(),
      caduca_en_texto: expiryText,
    };
  }

  /**
   * Un envío que falla es un 500 con la frase del contrato, nunca un 200 que miente. Y la
   * frase admite lo que se perdió —la temporal anterior ya está muerta— sin nombrar ninguna
   * ficha, porque un miembro del equipo no tiene.
   *
   * NO SE COMPENSA NADA, y es la diferencia con el reenvío de pacientes: allí había que
   * devolver `patient_link.access_sent_at` a su valor anterior porque esa columna afirma un
   * envío que ocurrió. Aquí no hay columna equivalente —el equipo no tiene `patient_link`—,
   * así que lo único que queda escrito es la línea de bitácora, que dice «pedido» y es
   * verdad. La salida de quien lo lee es volver a llamar a este mismo endpoint.
   */
  private async sendMail(facts: TeamDeliveryFacts, accountId: string): Promise<void> {
    try {
      await this.mail.sendTeamAccess(facts);
    } catch (cause) {
      // Ni el correo ni la contraseña entran en la causa: solo la cuenta (§10.3). El texto
      // del relé viaja encadenado y `service_failure` enmascara la dirección al escribirlo.
      throw new ServiceFailure(
        FAILURE_PHRASES.resendTeamAccess,
        new Error(`no se pudo reenviar el acceso del equipo de la cuenta ${accountId}`, { cause }),
      );
    }
  }

  /** La frase del contrato para este endpoint: nombra a la dueña, no a recepción. */
  private noPermission(): ContractError {
    return new ContractError(
      'sin_permiso',
      undefined,
      'Solo la dueña de la consulta puede mandar accesos al equipo.',
    );
  }
}

function ownerOf(caller: Caller): AccountOwner {
  return {
    accountId: caller.accountId,
    practiceId: caller.practiceId,
    accountRole: caller.accountRole,
    sessionId: caller.sessionId,
  };
}
