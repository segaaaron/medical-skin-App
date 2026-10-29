// GET /v1/patients · la lista y la búsqueda de la consulta.
//
// Recepción SÍ entra: necesita encontrar a la paciente para agendarle, y eso no es abrir su
// historia. Por eso el permiso es `pacientes:leer` y no `historia:leer`, y por eso `alerta` es
// una palabra y no un dato.

import { ContractError } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import { ageOn, calendarDay } from '../../accounts/domain/patient-registration';
import { alertOf, fullNameOf, readPatientQuery } from '../domain/listing';
import type { PatientReadPort, PracticeCaller } from '../domain/ports';

const PERMISSION = 'pacientes:leer';

export type ListedPatient = {
  id: string;
  nombre_completo: string;
  edad: number;
  celular: string | null;
  vinculo: string;
  ultima_sesion_en: string | null;
  proxima_cita_en: string | null;
  alerta: string | null;
};

export type PatientListResponse = {
  cuantas: number;
  pagina: number;
  por_pagina: number;
  pacientes: readonly ListedPatient[];
};

export interface ClockPort {
  now(): Date;
}

export class ListPatients {
  constructor(
    private readonly patients: PatientReadPort,
    private readonly clock: ClockPort,
  ) {}

  async run(query: Record<string, unknown>, caller: Caller): Promise<PatientListResponse> {
    const asked = readPatientQuery(query);
    const today = calendarDay(this.clock.now());

    const page = await this.patients.list(practiceCallerOf(caller), asked);

    return {
      cuantas: page.total,
      pagina: asked.page,
      por_pagina: asked.perPage,
      pacientes: page.rows.map((row) => ({
        id: row.id,
        nombre_completo: fullNameOf(row),
        edad: ageOn(row.birthDate, today),
        celular: row.phone,
        vinculo: row.linkStatus,
        // Las dos del calendario clínico son de los tramos 4 y 5 y todavía no existen. Van
        // NULAS y no ausentes: la app dibuja «sin sesiones» con el nulo, y quitar la clave la
        // obligaría a distinguir «no hay» de «no se sirve». Mismo criterio que `incidencias`.
        ultima_sesion_en: null,
        proxima_cita_en: null,
        alerta: alertOf(row),
      })),
    };
  }
}

/**
 * Quién pregunta, con su inquilino. Una paciente no tiene consulta que listar y recibe el
 * mismo `403` que una practicante sin el permiso: no se distingue, porque distinguir diría que
 * esta consulta existe.
 */
export function practiceCallerOf(caller: Caller, permission = PERMISSION): PracticeCaller {
  if (caller.practiceId === null || !caller.permissions.includes(permission)) {
    throw new ContractError(
      'sin_permiso',
      undefined,
      permission === PERMISSION
        ? 'No tienes permiso para ver las pacientes de esta consulta.'
        : 'Recepción no puede abrir la ficha de una paciente.',
    );
  }
  return {
    accountId: caller.accountId,
    practiceId: caller.practiceId,
    permissions: caller.permissions,
  };
}
