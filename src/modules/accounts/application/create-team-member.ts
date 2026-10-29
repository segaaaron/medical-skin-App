// POST /v1/team · la dueña da de alta a recepción o a un asistente clínico.
//
// EL ROL SÍ VIAJA EN EL CUERPO Y ES LA ÚNICA EXCEPCIÓN DEL TRAMO, «porque no es el rol de
// autenticación sino el permiso dentro de un inquilino que ya está resuelto»: `account.role`
// sigue siendo `practitioner` y lo pone el servidor.
//
// UN SOLO `409` Y OPACO A PROPÓSITO. El correo puede estar tomado porque la persona ya está
// en este equipo o porque ese correo ya tiene cuenta en la región —una paciente de otra
// consulta—. Dar dos códigos sería el oráculo del padrón que §12.2.1 cierra, así que el
// veredicto de la base es uno (`email_taken`) y la frase no confirma ninguna de las dos
// causas. El caso «la recepcionista que contrato es paciente de otra clínica» hoy no tiene
// salida dentro del producto: el alta se hace con otro correo suyo, y es un límite conocido.
//
// EL ACCESO SALE SOLO POR CORREO: no hay `wa.me` aquí. «La vía por WhatsApp existe porque
// muchas pacientes no abren el correo; quien trabaja en la consulta sí.»

import { z } from 'zod';

import {
  ContractError,
  FAILURE_PHRASES,
  ServiceFailure,
} from '../../../shared/contract/error-catalog';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import type { Caller } from '../../access/application/caller';
import type { PasswordHasher } from '../../access/domain/ports';
// La MISMA comprobación de forma que usa recuperación, y por eso no se reescribe aquí: dice
// que la cadena no tiene forma de correo, sin consultar nada. (Vive en el dominio de
// recuperación porque allí nació; su sitio natural sería un dominio compartido.)
import { readEmail } from '../../recovery/domain/code';
import type { TeamDeliveryFacts } from '../domain/access-delivery';
import type {
  AccountOwner,
  IdempotencyCompletionPort,
  TeamAccessMailPort,
  TeamPort,
} from '../domain/ports';
import { TEAM_PERMISSION, isAssignableTeamRole } from '../domain/team';
import {
  mintTemporaryPassword,
  temporaryPasswordExpiry,
} from '../domain/temporary-password';
import type { AccessBlock, DeliveryClock } from './send-patient-access';

const bodySchema = z.object({
  nombre: z.unknown(),
  apellido: z.unknown(),
  correo: z.unknown(),
  rol: z.unknown(),
});

/** Un nombre entra en un correo y en una fila: se acota como toda entrada del cliente. */
const NAME_MAX_LENGTH = 80;

export type TeamMemberResponse = {
  miembro_id: string;
  cuenta_id: string;
  nombre_completo: string;
  rol: string;
  acceso: AccessBlock;
};

export class CreateTeamMember {
  constructor(
    private readonly team: TeamPort,
    private readonly passwords: PasswordHasher,
    private readonly clock: DeliveryClock,
    private readonly mail: TeamAccessMailPort,
    private readonly idempotency: IdempotencyCompletionPort,
  ) {}

  async run(
    input: unknown,
    caller: Caller,
    /** La clave de la petición. Obligatoria, como en el alta de una paciente. */
    record: IdempotencyRecord,
  ): Promise<TeamMemberResponse> {
    // Autorización por recurso y no solo por rol: el permiso sale de la lista resuelta que
    // viaja en el token (OWASP A01). Que además sea LA DUEÑA lo comprueba la base, que es
    // la única que conoce `practice.owner_account_id`.
    if (!caller.permissions.includes(TEAM_PERMISSION)) throw this.noPermission();

    const body = this.readBody(input);
    const now = this.clock.now();
    const expiresAt = temporaryPasswordExpiry(now);
    const temporary = mintTemporaryPassword();

    const owner = ownerOf(caller);
    const created = await this.team.create({
      owner,
      idempotency: record,
      email: body.email,
      firstName: body.firstName,
      lastName: body.lastName,
      role: body.role,
      hash: await this.passwords.hash(temporary),
      expiresAt,
    });

    // La respuesta original de esta misma petición: no se creó una segunda cuenta y no salió un
    // segundo correo. Lo decidió la misma transacción que habría creado.
    if (created.verdict === 'replayed' && created.replay !== null) {
      return created.replay.response as TeamMemberResponse;
    }

    switch (created.verdict) {
      // La base valida el rol otra vez y ANTES de mirar el correo: un cuerpo mal formado no
      // revela nada del padrón. Si llega aquí es que el cuerpo pasó y la base no.
      case 'role_not_assignable':
        throw new ContractError('rol_no_asignable');
      case 'not_owner':
        throw this.noPermission();
      case 'email_taken':
        // La frase LITERAL de este endpoint. Se pasa explícita desde que el alta de una
        // paciente comparte el código (0021): la genérica del catálogo —la de sin red— ya
        // no puede nombrar al equipo, porque no sería verdadera en el otro endpoint.
        throw new ContractError(
          'correo_no_disponible',
          undefined,
          'Ese correo no se puede usar para el equipo. Dale de alta con otro correo suyo, o escríbenos a hola@medskin.app.',
        );
      default:
        break;
    }

    if (
      created.accountId === null ||
      created.practitionerId === null ||
      created.practiceName === null
    ) {
      // Sin los dos identificadores no hay respuesta, y sin el nombre de la consulta no hay
      // correo que escribir: no se inventa un «tu consulta» para tapar una lectura que
      // falló. Es una inconsistencia del servidor y va a `service_failure` con su causa.
      throw new ServiceFailure(
        FAILURE_PHRASES.createTeamMember,
        new Error('medskin_create_team_member devolvió `created` incompleto'),
      );
    }

    const expiryText = `Caduca el ${this.clock.localLongWhen(expiresAt)}`;
    await this.sendMail(
      {
        firstName: body.firstName,
        email: body.email,
        practiceName: created.practiceName,
        temporaryPassword: temporary,
        expiryText,
      },
      created.accountId,
    );

    const response: TeamMemberResponse = {
      miembro_id: created.practitionerId,
      cuenta_id: created.accountId,
      nombre_completo: `${body.firstName} ${body.lastName}`,
      rol: body.role,
      acceso: {
        via: 'correo',
        // «`enviado` significa que el relé aceptó el mensaje, no que llegó a su bandeja.»
        // Lo segundo no se puede saber desde aquí y prometerlo sería mentir.
        enviado: true,
        // Por correo la temporal NO viaja en la respuesta: el correo lo manda MedSkin, y que
        // la dueña la lea no aporta nada y la expone.
        contrasena_temporal: null,
        caduca_en: expiresAt.toISOString(),
        caduca_en_texto: expiryText,
      },
    };

    // La clave se cierra con la respuesta ya verdadera. Si esto falla, la cuenta existe y el
    // correo salió: el reintento NO puede volver a crearla —la reserva está escrita— y recibe
    // esta misma frase, que manda a reenviarle el acceso.
    try {
      await this.idempotency.complete({ owner, record, status: 201, response });
    } catch (cause) {
      throw new ServiceFailure(FAILURE_PHRASES.createTeamMemberMail, cause);
    }

    return response;
  }

  /**
   * El envío va DENTRO del ciclo de la petición, como el acceso de una paciente por correo:
   * es la única forma de que `enviado` diga la verdad en la misma respuesta.
   *
   * Y cuando el relé falla, la cuenta ya está creada: reintentar el alta devuelve
   * `409 correo_no_disponible`, así que la frase de «puedes volver a intentarlo» sería falsa
   * y se usa otra, que manda a soporte. Es el hueco que `cuentas.md` cierra con
   * `POST /v1/team/{member_id}/access`: el día que exista, esta frase dice «vuelve a
   * mandárselo» y la salida deja de ser un correo a soporte.
   */
  private async sendMail(facts: TeamDeliveryFacts, accountId: string): Promise<void> {
    try {
      await this.mail.sendTeamAccess(facts);
    } catch (cause) {
      // Ni el correo ni la contraseña entran en la causa: solo la cuenta (§10.3).
      // Con el identificador de la cuenta que YA está creada: el reenvío
      // —`POST /v1/team/{member_id}/access`— lo pide, y viajaba solo en el 201 que no llegó.
      throw new ServiceFailure(
        FAILURE_PHRASES.createTeamMemberMail,
        new Error(`no se pudo mandar el acceso del equipo de la cuenta ${accountId}`, { cause }),
        { cuenta_id: accountId },
      );
    }
  }

  private readBody(input: unknown): {
    firstName: string;
    lastName: string;
    email: string;
    role: 'recepcion' | 'asistente_clinico';
  } {
    const parsed = bodySchema.safeParse(input ?? {});
    const data = parsed.success ? parsed.data : undefined;

    const firstName = readName(data?.nombre);
    const lastName = readName(data?.apellido);
    if (firstName === null || lastName === null) throw new ContractError('nombre_vacio');

    // El rol ANTES del correo, en el mismo orden que la base: un cuerpo con `rol: "duena"`
    // no llega a nombrar un correo, y así no hay forma de usar el 400 para medir nada.
    const role = data?.rol;
    if (!isAssignableTeamRole(role)) throw new ContractError('rol_no_asignable');

    return { firstName, lastName, email: this.readEmailOfTeam(data?.correo), role };
  }

  /** La frase del correo vacío es la de este endpoint; el `codigo` es el del catálogo. */
  private readEmailOfTeam(value: unknown): string {
    try {
      return readEmail(value);
    } catch (failure) {
      if (failure instanceof ContractError && failure.code === 'correo_vacio') {
        throw new ContractError(
          'correo_vacio',
          undefined,
          'Hace falta su correo: es por donde le llega su contraseña.',
          'correo',
        );
      }
      throw failure;
    }
  }

  /**
   * «Solo la dueña da de alta al equipo»: la frase es la del contrato, con las palabras de
   * su «Quién puede», y no la de `POST /v1/patients`, que habla de pacientes. Acordada el
   * 28 de octubre al construir esto.
   */
  private noPermission(): ContractError {
    return new ContractError(
      'sin_permiso',
      undefined,
      'Solo la dueña de la consulta puede dar de alta al equipo.',
    );
  }
}

function readName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().slice(0, NAME_MAX_LENGTH);
  return name === '' ? null : name;
}

function ownerOf(caller: Caller): AccountOwner {
  return {
    accountId: caller.accountId,
    practiceId: caller.practiceId,
    accountRole: caller.accountRole,
    sessionId: caller.sessionId,
  };
}
