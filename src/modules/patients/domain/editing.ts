// El cuerpo del `PATCH /v1/pacientes/{id}` y la respuesta del archivado.
//
// MEZCLA POR CAMPO, CON EL SERVIDOR COMO ÁRBITRO (§9.3): un `PATCH` que no nombra un campo no
// lo toca, así que dos dispositivos que tocan campos distintos no se pisan. Por eso cada campo
// se lee como «ausente» o «este valor», nunca como «null quiere decir vacío».
//
// Y LAS REGLAS DE CADA CAMPO SON LAS DEL ALTA, importadas: dos lectores del mismo campo
// divergen el día que uno cambia. Lo único que este endpoint no acepta es `estado` y nada del
// vínculo: archivar tiene su propia puerta y el vínculo es de la paciente.

import { ContractError } from '../../../shared/contract/error-catalog';
import {
  asRecord,
  readBirthDate,
  readHowArrived,
  readName,
  readPatientEmail,
  readPhone,
  readReminders,
} from '../../accounts/domain/patient-registration';

/** Lo que el `PATCH` puede cambiar. Ausente = no se toca. */
export type PatientEdit = {
  firstName?: string;
  lastName?: string;
  birthDate?: string;
  email?: string;
  phone?: string | null;
  hasWhatsapp?: boolean;
  remindersVia?: string;
  howArrived?: string;
  referredBy?: string | null;
};

export function readPatientEdit(input: unknown, now: Date): PatientEdit {
  const body = asRecord(input);
  const edit: PatientEdit = {};

  if (body.nombre !== undefined) {
    const name = readName(body.nombre);
    if (name === null) throw new ContractError('nombre_vacio');
    edit.firstName = name;
  }
  if (body.apellido !== undefined) {
    const name = readName(body.apellido);
    if (name === null) throw new ContractError('nombre_vacio');
    edit.lastName = name;
  }
  if (body.nacimiento !== undefined) edit.birthDate = readBirthDate(body.nacimiento, now);
  if (body.correo !== undefined) edit.email = readPatientEmail(body.correo);
  if (body.celular !== undefined) edit.phone = readPhone(body.celular);
  if (body.tiene_whatsapp !== undefined) edit.hasWhatsapp = body.tiene_whatsapp === true;
  if (body.recordatorios_por !== undefined) {
    edit.remindersVia = readReminders(body.recordatorios_por);
  }
  if (body.como_llego !== undefined || body.referida_por !== undefined) {
    const arrived = readHowArrived(body.como_llego, body.referida_por);
    edit.howArrived = arrived.howArrived;
    edit.referredBy = arrived.referredBy;
  }

  // Un `PATCH` vacío no es un error del contrato, pero tampoco una escritura: sin esto haría
  // un `UPDATE` sin columnas, que es sintaxis inválida en Postgres y un 500 por nada.
  if (Object.keys(edit).length === 0) throw new ContractError('nada_que_cambiar');

  // El celular y la casilla de WhatsApp viajan juntos aunque el cuerpo traiga uno solo:
  // quitar el número y dejar la casilla marcada deja una ficha que promete un chat que no
  // existe. Si el `PATCH` borra el celular, la casilla se apaga.
  if (edit.phone === null) edit.hasWhatsapp = false;

  return edit;
}

/** La respuesta de archivar y de reactivar, literal del contrato. */
export function archiveView(status: string, archivedAt: Date | null) {
  return {
    estado: status,
    archivada_en: archivedAt?.toISOString() ?? null,
    se_conserva: {
      que: 'expediente_clinico',
      por_que: 'Tienes que conservar su historia clínica por ley.',
      vuelve_si: 'La reactivas.',
    },
  };
}
