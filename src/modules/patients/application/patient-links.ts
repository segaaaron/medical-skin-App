// GET /v1/vinculos · POST /v1/vinculos/{id}/aceptar · POST /v1/vinculos/{id}/rechazar
//
// «¿Es esta tu doctora?». LA PACIENTE, Y NADIE MÁS: nunca la doctora. Es el
// `siguiente_paso: "vincular"` de `acceso.md`.
//
// ESTA ES LA ÚNICA LECTURA DEL SISTEMA QUE CRUZA INQUILINOS: `patient_link` filtrado por
// `account_id` y no por `practice_id`. Cruza solo las fichas de quien pregunta, y por eso la
// política de esa tabla tiene dos caras —por `practice_id` para la doctora, por `account_id`
// para la paciente—. `consulta`, `doctora` y `ciudad` salen de las COPIAS que guarda
// `patient_link`: darle política a `app_patient` sobre `practice` abriría todos los inquilinos
// para poder leer uno.

import { ContractError } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import type { LinkRow, PatientLinkPort } from '../domain/ports';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ListedLink = {
  id: string;
  estado: string;
  consulta: string;
  doctora: string;
  ciudad: string | null;
  desde: string;
  ficha_medica_pendiente: boolean;
};

export class PatientLinks {
  constructor(private readonly links: PatientLinkPort) {}

  async list(caller: Caller): Promise<{ vinculos: readonly ListedLink[] }> {
    const rows = await this.links.list(patientOf(caller));
    return { vinculos: rows.map(view) };
  }

  /** Aceptar y rechazar: el mismo camino con el estado al que va. */
  async decide(linkId: string, caller: Caller, accept: boolean): Promise<ListedLink> {
    const account = patientOf(caller);
    // Un `id` que no es un uuid no es de su cuenta: la misma respuesta que uno inventado.
    if (!UUID.test(linkId)) throw new ContractError('vinculo_no_existe');

    const result = await this.links.decide(account, linkId, accept);
    switch (result.outcome) {
      case 'no_link':
        throw new ContractError('vinculo_no_existe');
      // Ya aceptó o ya rechazó. La app no enseña nada: recarga y sigue.
      case 'already_resolved':
        throw new ContractError('vinculo_ya_resuelto');
      default:
        return view(result.row);
    }
  }
}

/**
 * Quien pregunta tiene que ser la paciente. Una doctora recibe `403 rol_no_corresponde`, que es
 * lo que el contrato escribe: «esta pantalla no es de tu cuenta».
 */
export function patientOf(caller: Caller): string {
  if (caller.accountRole !== 'paciente') throw new ContractError('rol_no_corresponde');
  return caller.accountId;
}

function view(row: LinkRow): ListedLink {
  return {
    id: row.id,
    estado: row.status,
    consulta: row.practiceName,
    doctora: row.practitionerName,
    ciudad: row.city,
    // «`desde` es cuándo la dieron de alta, no cuándo aceptó»: para ella, desde cuándo esa
    // consulta la atiende, y eso existe antes de que acepte. No hay columna de «aceptó en».
    desde: row.createdAt.toISOString().slice(0, 10),
    // Pendiente mientras ningún campo de sus antecedentes tenga fuente `paciente`. «La ficha
    // médica no bloquea la app»: esto solo dibuja el recordatorio.
    ficha_medica_pendiente: !row.historyWrittenByPatient,
  };
}
