// PATCH /v1/patients/{id} · corregir los datos de contacto y de contexto.
// POST /v1/patients/{id}/archive · POST /v1/patients/{id}/reactivate.
//
// Los tres piden `pacientes:crear` y recepción no entra en ninguno.
//
// HAY DOS CORREOS Y NO SE UNIFICAN, NUNCA. `patient.email` es el de la ficha, el que este
// `PATCH` cambia; `patient_link.email` es el del acceso, con el que se creó o se reusó la
// cuenta. Nacen iguales y se separan en el primer `PATCH`. Si la ficha ya está vinculada, la
// respuesta lleva `aviso_correo: true` para que la app lo diga: el correo con el que ella entra
// a MedSkin no cambió, y eso solo lo cambia ella.

import { ContractError } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import { PATIENT_CREATE_PERMISSION } from '../../accounts/domain/patient-registration';
import { archiveView, readPatientEdit } from '../domain/editing';
import type { PatientWritePort } from '../domain/ports';
import { practiceCallerOf, type ClockPort } from './list-patients';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class EditPatient {
  constructor(
    private readonly patients: PatientWritePort,
    private readonly clock: ClockPort,
  ) {}

  async run(patientId: string, input: unknown, caller: Caller): Promise<unknown> {
    const asking = practiceCallerOf(caller, PATIENT_CREATE_PERMISSION);
    if (!UUID.test(patientId)) throw new ContractError('paciente_no_existe');

    const edit = readPatientEdit(input, this.clock.now());
    const result = await this.patients.edit(asking, patientId, edit);

    switch (result.outcome) {
      case 'no_patient':
        throw new ContractError('paciente_no_existe');
      case 'archived':
        throw new ContractError('paciente_archivada');
      // La referida tiene que ser una ficha de ESTA consulta, y lo comprueba la base bajo la
      // misma política: un identificador de otra no devuelve fila.
      case 'no_referrer':
        throw new ContractError('referida_no_existe');
      default:
        break;
    }

    return {
      id: patientId,
      // Solo cuando el correo cambió Y la ficha está vinculada: avisar de algo que no pasó
      // enseña a la doctora a ignorar el aviso.
      aviso_correo: edit.email !== undefined && result.linked,
    };
  }

  /** Archivar y reactivar, que son el mismo camino con el estado al revés. */
  async archive(patientId: string, caller: Caller, archived: boolean): Promise<unknown> {
    const asking = practiceCallerOf(caller, PATIENT_CREATE_PERMISSION);
    if (!UUID.test(patientId)) throw new ContractError('paciente_no_existe');

    const result = await this.patients.archive(asking, patientId, archived);
    if (result.outcome === 'no_patient') throw new ContractError('paciente_no_existe');
    // «Una ficha archivada con una cita viva es una paciente que se presenta y no está en la
    // agenda.» El repositorio lo comprueba contra `appointment` desde el 29 de octubre de
    // 2026: hasta entonces esta rama existía y nadie la alcanzaba.
    if (result.outcome === 'future_appointment') throw new ContractError('cita_futura');

    // Idempotente: archivar lo archivado devuelve el mismo 200 con la fecha del archivado de
    // verdad, no la de este reintento.
    return archiveView(result.status, result.archivedAt);
  }
}
