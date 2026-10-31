// POST /v1/tenants/mine/license · «El doctor declara su matrícula». **No se revisa: se guarda.**
//
// LO QUE ESTE ARCHIVO ERA HASTA HOY, porque explica por qué es tan corto ahora: mandaba la
// licencia a revisión manual, devolvía `202` —«lo que se creó es un caso de revisión humana,
// no un hecho»—, traducía ocho veredictos de una máquina de estados a cuatro códigos del
// contrato y prometía una fecha de respuesta calculada con «24 h hábiles».
//
// Nada de eso existe. El dueño lo descartó el 30 de octubre de 2026 y su razón es la que
// manda: **MedSkin no es una asociación médica ni un inspector de salud.** Es una herramienta
// que ayuda a un doctor con sus pacientes; el doctor hace su evaluación profesional y responde
// de ella. Se le pide la matrícula, y se guarda tal como él la declara.
//
// `200` y no `202`: no se creó ningún caso que alguien vaya a atender. Y es un FORMULARIO —el
// último `POST` gana—, así que no hay transición que validar ni `409` que devolver.
//
// QUIÉN PUEDE ES LA DUEÑA, Y NO LO DECIDE ESTE ARCHIVO. `consulta:licencia:enviar` sigue sin
// salir de `PERMISSIONS_BY_ROLE` a propósito: la dueña es la cuenta que está en
// `practice.owner_account_id`, que es una FILA y no una lista que alguien pueda editar aquí.
// Lo comprobaba `medskin_license_to_review()`, que se fue con la revisión (migración 0072), y
// ahora lo comprueba el `WHERE` del propio `UPDATE` del repositorio contra `practice`: cero
// filas es `not_owner`. El token NO lo sabe —`Caller` no tiene «soy la dueña»— y no se le va a
// añadir por esto: sería un dato de autorización viajando fuera de la base, revalidado en cada
// petición por quien no es su dueño.

import {
  ContractError,
  FAILURE_PHRASES,
  ServiceFailure,
} from '../../../shared/contract/error-catalog';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import type { Caller } from '../../access/application/caller';
import type { LicenseSubmissionPort, Submission } from '../domain/ports';
import { readLicenseDeclaration } from '../domain/rules';

export type DeclaredLicenseResponse = {
  pais_ejercicio: string;
  especialidad: string;
  matricula: string;
  declarada_en: string;
};

export class SubmitLicense {
  constructor(private readonly licenses: LicenseSubmissionPort) {}

  async run(
    input: unknown,
    caller: Caller,
    /** La clave de la petición. Obligatoria: protege el cupo de cinco al día del reintento. */
    record: IdempotencyRecord,
  ): Promise<DeclaredLicenseResponse> {
    // Una paciente no tiene consulta cuya matrícula declarar. El `codigo` es el del contrato
    // de ESTE endpoint —no tiene `rol_no_corresponde`— con su frase: «Solo la dueña de la
    // consulta puede declarar la matrícula».
    if (caller.accountRole === 'patient' || caller.practiceId === null) throw notOwner();

    const form = readLicenseDeclaration(input);
    // La respuesta se construye DENTRO de la transacción para que se guarde con ella: aquí no
    // hay nada después del `COMMIT` que pueda cambiarla. Y solo se guarda el 200: un `429` no
    // es una respuesta que repetir, y el reintento tiene que poder volver a intentarlo.
    const { submission, replay } = await this.licenses.submit({
      owner: { accountId: caller.accountId, practiceId: caller.practiceId },
      form,
      idempotency: record,
      respond: (saved) =>
        saved.verdict === 'saved' ? { status: 200, response: this.view(form, saved) } : null,
    });

    // La misma petición otra vez: su respuesta original, sin volver a escribir y sin gastar
    // uno de los cinco guardados del día.
    if (replay !== null) return replay.response as DeclaredLicenseResponse;

    return this.view(form, submission);
  }

  private view(
    form: { practiceCountry: string; specialty: string; licenseNumber: string },
    submission: Submission,
  ): DeclaredLicenseResponse {
    // Los dos que no guardan. `not_owner` lo dice la base y no el token: lo compara el
    // `WHERE` del `UPDATE` contra `practice.owner_account_id`.
    if (submission.verdict === 'not_owner') throw notOwner();
    if (submission.verdict === 'too_many') throw new ContractError('demasiados_envios');

    // `declaredAt` lo pone la base en el mismo `UPDATE` —`returning updated_at`— y no se
    // reconstruye aquí con el reloj del proceso, que daría una hora parecida pero distinta de
    // la que quedó escrita.
    //
    // Nulo con `saved` es INALCANZABLE: `returning` devuelve la fila que acabó de escribir. Si
    // pasara, es una inconsistencia del servidor y un 500 con la causa real es la respuesta
    // honesta —«lo que llenaste está guardado en este teléfono»—, no una fecha inventada.
    if (submission.declaredAt === null) {
      throw new ServiceFailure(
        FAILURE_PHRASES.submitLicense,
        new Error('el `update` de la licencia devolvió `saved` sin `updated_at`'),
      );
    }

    return {
      pais_ejercicio: form.practiceCountry,
      especialidad: form.specialty,
      matricula: form.licenseNumber,
      declarada_en: submission.declaredAt.toISOString(),
    };
  }
}

function notOwner(): ContractError {
  return new ContractError(
    'sin_permiso',
    undefined,
    'Solo la dueña de la consulta puede declarar la matrícula.',
  );
}
