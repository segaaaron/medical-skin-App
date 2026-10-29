// DELETE /v1/accounts/mine · borrar mi cuenta desde la pantalla, sin escribirle a soporte.
// Apple lo exige desde 2022 en toda app con cuentas, las cree quien las cree.
//
// EL ORDEN: la contraseña primero, y el borrado después. Se comprueba contra
// `medskin_current_credential()` con Argon2id en Node —el hash no sale de la base por
// ninguna consulta— y un fallo termina aquí: nada se escribe.
//
// LOS TRES `409` NO SON `if`s DE ESTE ARCHIVO. Los comprueba la misma transacción que
// borraría, en el orden del contrato —equipo, pacientes, suscripción—, y aquí solo se
// traducen a su código y a su frase. Igual que el `403`: «recepción y asistente, no» es el
// veredicto `not_allowed` de la función, que no se puede olvidar en un controlador.

import { z } from 'zod';

import {
  ContractError,
  FAILURE_PHRASES,
  ServiceFailure,
} from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import type { ClockPort, PasswordHasher } from '../../access/domain/ports';
import {
  DELETED_ITEMS,
  RETAINED_RECORD,
  dayAndMonth,
  patientsPhrase,
  retentionUntil,
} from '../domain/deletion';
import type {
  AccountDeletionPort,
  AccountOwner,
  DeletionResult,
  OwnCredentialPort,
} from '../domain/ports';

/** `motivo` es opcional y no es un campo de texto libre: la pantalla ofrece una lista. */
const REASON_MAX_LENGTH = 120;

const bodySchema = z.object({ contrasena: z.unknown(), motivo: z.unknown() });

export type DeleteOwnAccountResponse = {
  borrado_en: string;
  se_borro: readonly string[];
  se_conserva: {
    que: string;
    hasta: string;
    por_que: string;
    vuelve_si: string;
  };
};

export class DeleteOwnAccount {
  constructor(
    private readonly credentials: OwnCredentialPort,
    private readonly passwords: PasswordHasher,
    private readonly deletion: AccountDeletionPort,
    private readonly clock: ClockPort,
    /** El plazo legal de la región, de la configuración del despliegue y no de una tabla. */
    private readonly retentionYears: number,
  ) {}

  async run(input: unknown, caller: Caller): Promise<DeleteOwnAccountResponse> {
    const parsed = bodySchema.safeParse(input ?? {});
    const password = typeof parsed.data?.contrasena === 'string' ? parsed.data.contrasena : '';
    const reason = readReason(parsed.data?.motivo);

    const owner = ownerOf(caller);
    const credential = await this.credentials.readMine(owner);
    // Una contraseña vacía se verifica igual que cualquier otra: el mismo camino y el mismo
    // coste, y el mismo 401. Aquí no hay oráculo que cerrar —quien llama ya está dentro—,
    // pero tampoco hay motivo para tener dos caminos donde uno basta.
    const matched =
      credential !== null && (await this.passwords.verify(credential.hash, password, owner));
    if (!matched) {
      throw new ContractError(
        'contrasena_actual_no_coincide',
        undefined,
        // La frase es la de ESTE endpoint, no la de `PATCH …/contrasena`, y el campo que se
        // enciende es el de ESTA pantalla, que se llama `contrasena`.
        'Esa no es tu contraseña.',
        'contrasena',
      );
    }

    const now = this.clock.now();
    const result = await this.deletion.deleteMine({
      owner,
      retentionUntil: retentionUntil(now, this.retentionYears),
      reason,
    });

    return this.answer(result, now, caller);
  }

  private answer(
    result: DeletionResult,
    now: Date,
    caller: Caller,
  ): DeleteOwnAccountResponse {
    switch (result.verdict) {
      case 'not_allowed':
        // La frase es la del contrato, con las palabras de su «Quién puede» («Recepción y
        // asistente, no»). Acordada el 28 de octubre, cuando construir esto levantó que el
        // `403` no figuraba en la tabla de errores de este endpoint.
        throw new ContractError(
          'sin_permiso',
          undefined,
          'Recepción y asistente no pueden borrar su cuenta desde aquí.',
        );
      case 'practice_has_team':
        throw new ContractError('consulta_con_equipo');
      case 'practice_has_patients':
        throw this.withPatients(result.patientCount ?? 0);
      case 'subscription_active':
        throw this.withPlan(result.planRenewsOn);
      case 'no_account':
        // El contexto trae una cuenta que no existe: no hay nada que borrar y no hay
        // respuesta que dar. No se devuelve un 200 que diga que se borró algo.
        throw new ServiceFailure(
          FAILURE_PHRASES.deleteOwnAccount,
          new Error(`la cuenta ${caller.accountId} no existe y su token sí`),
        );
      default: {
        // `deleted` y `already_deleted`: el mismo 200, con la fecha del borrado DE VERDAD.
        // Y por eso `hasta` se calcula sobre ESA fecha y no sobre la de este reintento: lo
        // que se le prometió a quien ya se borró no se reinterpreta.
        const deletedAt = result.deletedAt ?? now;
        return {
          borrado_en: deletedAt.toISOString(),
          se_borro: DELETED_ITEMS,
          se_conserva: {
            que: RETAINED_RECORD.que,
            hasta: retentionUntil(deletedAt, this.retentionYears),
            por_que: RETAINED_RECORD.por_que,
            vuelve_si: RETAINED_RECORD.vuelve_si,
          },
        };
      }
    }
  }

  /** El número sale de la función, y la frase lo interpola: «tiene 148 pacientes». */
  private withPatients(count: number): ContractError {
    return new ContractError(
      'consulta_con_pacientes',
      { pacientes: count },
      `Tu consulta tiene ${patientsPhrase(count)} con su historia clínica. Por ley alguien tiene que seguir siendo responsable de ella, así que primero hay que traspasar o cerrar la consulta. Escríbenos a hola@medskin.app y lo hacemos contigo.`,
    );
  }

  /** La fecha sale de `plan_renews_on`, como texto: una columna `date` no es un instante. */
  private withPlan(renewsOn: string | null): ContractError {
    if (renewsOn === null) {
      throw new ServiceFailure(
        FAILURE_PHRASES.deleteOwnAccount,
        new Error('subscription_active sin plan_renews_on: la frase no se puede escribir'),
      );
    }
    return new ContractError(
      'suscripcion_activa',
      { plan_renueva_en: renewsOn },
      `Tu plan sigue activo hasta el ${dayAndMonth(renewsOn)}. Cancélalo primero y después borra tu cuenta.`,
    );
  }
}

/**
 * El motivo, acotado. La base rechaza más de 120 caracteres con una excepción —«el motivo no
 * es un campo de texto libre»— y eso saldría como un 500 por un campo opcional: se acota
 * aquí, donde el contrato no define ningún error para él.
 */
function readReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const reason = value.trim().slice(0, REASON_MAX_LENGTH);
  return reason === '' ? null : reason;
}

function ownerOf(caller: Caller): AccountOwner {
  return {
    accountId: caller.accountId,
    practiceId: caller.practiceId,
    accountRole: caller.accountRole,
    sessionId: caller.sessionId,
  };
}
