// GET /v1/patients/{id} · la ficha · y GET /v1/patients/{id}/medical-history.
//
// Recepción NO entra en ninguno de los dos: `historia:leer`. Y abrir una ficha queda en la
// auditoría, con quién y cuándo, sin interruptor — lo escribe el repositorio dentro de la misma
// transacción que la lee, para que no exista el estado «se sirvió y no quedó rastro».

import { ContractError } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import { ageOn, calendarDay } from '../../accounts/domain/patient-registration';
import { PATIENT_CREATE_PERMISSION, readHistory } from '../../accounts/domain/patient-registration';
import { emptyHistoryView, historyView, type HistoryView } from '../domain/history-view';
import type { HistoryWriteRepository } from '../infrastructure/history-write.repository';
import type { PatientFileRow, PatientReadPort } from '../domain/ports';
import { practiceCallerOf, type ClockPort } from './list-patients';

const PERMISSION = 'historia:leer';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PatientFileResponse = {
  id: string;
  nombre: string;
  apellido: string;
  nacimiento: string;
  edad: number;
  correo: string;
  celular: string | null;
  tiene_whatsapp: boolean;
  recordatorios_por: string;
  como_llego: string;
  referida_por: { id: string; nombre_completo: string } | null;
  estado: string;
  alta_en: string;
  vinculo: {
    estado: string;
    correo: string;
    acceso_enviado_en: string | null;
    ya_eligio_contrasena: boolean;
  } | null;
  antecedentes: HistoryView;
  resumen: { sesiones: number; ultima_sesion_en: string | null; proxima_cita_en: string | null };
};

export class ReadPatient {
  constructor(
    private readonly patients: PatientReadPort,
    private readonly clock: ClockPort,
    private readonly historyWriter: HistoryWriteRepository,
  ) {}

  /** La ficha entera. */
  async run(patientId: string, caller: Caller): Promise<PatientFileResponse> {
    const row = await this.find(patientId, caller);

    return {
      id: row.id,
      nombre: row.firstName,
      apellido: row.lastName,
      nacimiento: row.birthDate,
      edad: ageOn(row.birthDate, calendarDay(this.clock.now())),
      correo: row.email,
      celular: row.phone,
      tiene_whatsapp: row.hasWhatsapp,
      recordatorios_por: row.remindersVia,
      como_llego: row.howArrived,
      referida_por:
        row.referredById === null || row.referredByName === null
          ? null
          : { id: row.referredById, nombre_completo: row.referredByName },
      estado: row.status,
      // Una fecha de calendario, no un instante: `alta_en` es el día en que la dio de alta.
      alta_en: row.createdAt.toISOString().slice(0, 10),
      vinculo: await this.linkOf(row, caller),
      antecedentes: row.history === null ? emptyHistoryView(row.createdAt) : historyView(row.history),
      // Los tres del calendario clínico son de los tramos 4 y 5. Cero y nulos, con la misma
      // regla que la lista: la clave viaja para que la app no tenga que distinguir ausencias.
      resumen: { sesiones: 0, ultima_sesion_en: null, proxima_cita_en: null },
    };
  }

  /**
   * LA DOCTORA ESCRIBE CUALQUIER CAMPO, SIEMPRE, y esa asimetría con la paciente es la regla
   * del tramo: ella es la responsable del expediente. Pide `pacientes:crear` —el mismo permiso
   * que el alta— y recepción no entra.
   */
  async writeHistory(patientId: string, input: unknown, caller: Caller): Promise<unknown> {
    const asking = practiceCallerOf(caller, PATIENT_CREATE_PERMISSION);
    if (!UUID.test(patientId)) throw new ContractError('paciente_no_existe');

    const body = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const written = await this.historyWriter.write(
      asking,
      patientId,
      readHistory(input),
      new Set(Object.keys(body)),
    );
    if (written.outcome === 'no_patient') throw new ContractError('paciente_no_existe');
    if (written.outcome === 'archived') throw new ContractError('paciente_archivada');

    // Se devuelve la forma completa, la misma del `GET`: la app no tiene que recargar.
    return { guardado: written.saved, antecedentes: await this.history(patientId, caller) };
  }

  /** Solo los antecedentes, la misma forma que lleva dentro la ficha. */
  async history(patientId: string, caller: Caller): Promise<HistoryView> {
    const row = await this.find(patientId, caller);
    return row.history === null ? emptyHistoryView(row.createdAt) : historyView(row.history);
  }

  private async find(patientId: string, caller: Caller): Promise<PatientFileRow> {
    const asking = practiceCallerOf(caller, PERMISSION);
    // Un `id` que no es un uuid no es de esta consulta: la misma respuesta que uno inventado,
    // y sin consultar nada. Con otra forma la base muere con «invalid input syntax for type
    // uuid» y eso sería un 500 donde el contrato promete un 404.
    if (!UUID.test(patientId)) throw new ContractError('paciente_no_existe');

    const row = await this.patients.file(asking, patientId);
    // Sin fila: no es de esta consulta, o no existe. El 404 cubre los dos a propósito.
    if (row === null) throw new ContractError('paciente_no_existe');
    return row;
  }

  /**
   * `vinculo` sale de `patient_link`, nunca de `account`. Y `ya_eligio_contrasena` sale de una
   * función `SECURITY DEFINER`, porque `app_practitioner` no tiene política sobre `credential`:
   * está para que el botón «Reenviar acceso» aparezca apagado en vez de fallar al pulsarlo.
   */
  private async linkOf(
    row: PatientFileRow,
    caller: Caller,
  ): Promise<PatientFileResponse['vinculo']> {
    if (row.link === null) return null;
    const chosen =
      row.link.accountId === null
        ? false
        : (await this.patients.accessState(practiceCallerOf(caller, PERMISSION), row.link.accountId))
            .passwordChosen === true;

    return {
      estado: row.link.status,
      correo: row.link.email,
      acceso_enviado_en: row.link.accessSentAt?.toISOString() ?? null,
      ya_eligio_contrasena: chosen,
    };
  }
}
