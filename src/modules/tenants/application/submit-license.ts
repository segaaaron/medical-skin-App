// POST /v1/tenants/mine/license · «La doctora envía su matrícula a revisión manual».
//
// La credencial NO viaja por aquí: se sube antes por URL firmada (§7.1) y aquí llega su
// clave de objeto. 202 y no 201 porque «lo que se creó es un caso de revisión humana, no un
// hecho»: la revisión es a mano y no hay aprobación automática, ni por un proveedor, ni por
// una heurística.
//
// QUIÉN PUEDE ES LA DUEÑA, Y NO LO DECIDE ESTE ARCHIVO. `consulta:licencia:enviar` no sale
// de la tabla de permisos por rol a propósito (`role.ts`): la dueña es la cuenta que está en
// `practice.owner_account_id`, que es una FILA. Lo comprueba `medskin_license_to_review()`,
// que no recibe ni la cuenta ni la consulta —las toma del contexto— y devuelve `not_owner`.
// Así recepción y el asistente reciben el `403` por lo que la base sabe y no por una lista
// que alguien pueda editar aquí.

import {
  ContractError,
  FAILURE_PHRASES,
  ServiceFailure,
} from '../../../shared/contract/error-catalog';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import type { Caller } from '../../access/application/caller';
import type { ClockPort, LicenseSubmissionPort, Submission } from '../domain/ports';
import {
  capabilities,
  estimatedResponseAt,
  readLicenseForm,
  type Capabilities,
} from '../domain/rules';

export type SubmittedLicenseResponse = {
  estado: string;
  enviada_en: string | null;
  respuesta_estimada_en: string | null;
  puede: Capabilities;
};

export class SubmitLicense {
  constructor(
    private readonly licenses: LicenseSubmissionPort,
    private readonly clock: ClockPort,
    /** La zona del despliegue: lo hábil de «24 h hábiles» se cuenta en el calendario local. */
    private readonly timeZone: string,
  ) {}

  async run(
    input: unknown,
    caller: Caller,
    /** La clave de la petición. Obligatoria: `_convenciones.md` la exige en todo POST que crea. */
    record: IdempotencyRecord,
  ): Promise<SubmittedLicenseResponse> {
    // Una paciente no tiene consulta que enviar. El `codigo` es el del contrato de ESTE
    // endpoint —no tiene `rol_no_corresponde`— con su frase: «Solo la dueña de la consulta
    // puede enviar la licencia».
    if (caller.accountRole === 'paciente' || caller.practiceId === null) throw notOwner();

    const form = readLicenseForm(input, caller.practiceId);
    // La respuesta se construye DENTRO de la transacción para que se guarde con ella: aquí
    // no hay nada después del `COMMIT` que pueda cambiarla, así que la clave se cierra de una
    // sola vez. Y solo se guarda el 202: un `403`, un `409` o un `429` no son una respuesta
    // que repetir, y el reintento tiene que poder volver a intentarlo de verdad.
    const { submission, replay } = await this.licenses.submit({
      owner: { accountId: caller.accountId, practiceId: caller.practiceId },
      form,
      responseEstimatedAt: estimatedResponseAt(this.clock.now(), this.timeZone),
      idempotency: record,
      respond: (sent) =>
        sent.verdict === 'submitted' ? { status: 202, response: this.view(sent) } : null,
    });

    // La misma petición otra vez: su respuesta original, sin reabrir el caso de
    // revisión —volver a llamar a la función daría `already_in_review`, que es un 409 para
    // una petición que salió bien— y sin gastar ninguno de los cinco envíos del día.
    if (replay !== null) return replay.response as SubmittedLicenseResponse;

    return this.view(submission);
  }

  private view(submission: Submission): SubmittedLicenseResponse {
    switch (submission.verdict) {
      case 'submitted':
        break;
      case 'not_owner':
        throw notOwner();
      case 'already_in_review':
        throw new ContractError('licencia_en_revision');
      case 'already_verified':
        throw new ContractError('licencia_ya_verificada');
      case 'too_many':
        throw new ContractError('demasiados_envios');
      // Los tres que quedan NO son errores del contrato y no se les inventa uno:
      //   · `incomplete` es inalcanzable —el `UPDATE` de esta misma transacción escribe las
      //     seis columnas ya validadas— salvo que el `GRANT` de columna o la política
      //     cambien, que es exactamente lo que hay que ver en `service_failure`;
      //   · `no_license` lo cierra la 0015: la fila nace con la consulta;
      //   · `invalid_transition` significa un estado que el `CHECK` no admite.
      // Los tres son inconsistencias del servidor, y un 500 con la causa real es la
      // respuesta honesta: «lo que llenaste está guardado en este teléfono».
      default:
        throw new ServiceFailure(
          FAILURE_PHRASES.submitLicense,
          new Error(
            `medskin_license_to_review devolvió ${submission.verdict} sobre el estado ${
              submission.status ?? 'desconocido'
            }`,
          ),
        );
    }

    if (submission.submittedAt === null || submission.responseEstimatedAt === null) {
      throw new ServiceFailure(
        FAILURE_PHRASES.submitLicense,
        new Error('medskin_license_to_review devolvió `submitted` sin fechas'),
      );
    }

    return {
      estado: submission.status ?? 'en_revision',
      enviada_en: submission.submittedAt.toISOString(),
      respuesta_estimada_en: submission.responseEstimatedAt.toISOString(),
      // La MISMA función que la lectura, con el estado que acaba de devolver la base: «enviar
      // la licencia no desbloquea nada», y eso tiene que decirlo una sola regla. El contrato
      // escribe tres claves en este 202 y cuatro en la lectura; viajan las cuatro, porque dos
      // formas del mismo campo obligan a la app a llevar dos decodificadores (decisión 46).
      //
      // EL CUPO NO SE CONSULTA EN ESTE CAMINO y por eso entra `false`, que es el valor que no
      // afirma cupo libre: el estado que acaba de devolver la base es `en_revision` —la
      // transición solo sale de `sin_enviar` o `rechazada`—, así que `invitar_pacientes` ya es
      // `false` por la licencia y el cupo no cambiaría un solo valor de esta respuesta. Una
      // consulta más para un número que no se ve es una consulta que nadie puede justificar;
      // el cupo se sirve donde se lee, que es `GET /v1/tenants/mine`.
      puede: capabilities(submission.status ?? 'en_revision', false),
    };
  }
}

function notOwner(): ContractError {
  return new ContractError(
    'sin_permiso',
    undefined,
    'Solo la dueña de la consulta puede enviar la licencia.',
  );
}
