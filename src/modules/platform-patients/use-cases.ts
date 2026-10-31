// Los cinco casos de uso de `pacientes-consola.md`. Cada uno traduce lo que la base devuelve a
// la forma del contrato, y nada más: la autorización la hizo el guardia contra el token
// firmado, y el aislamiento lo hace la base.
//
// LO QUE SE VIGILA AQUÍ Y EN NINGÚN OTRO SITIO: que la LISTA no devuelva ni un campo que la
// ficha no tenga, y que ninguna de las dos devuelva un campo clínico. La historia tiene su
// endpoint, su permiso y su auditoría; si se cuela por aquí, los tres sobran.

import { ContractError } from '../../shared/contract/error-catalog';
import type { PatientSearch } from './domain';
import {
  PlanFull,
  type ConsoleActor,
  type PatientFile,
  type PatientRow,
  type PlatformPatientsRepository,
} from './repository';

const FICHA_NO_EXISTE = () => new ContractError('paciente_no_existe');

export class ListTenantPatients {
  constructor(private readonly repo: PlatformPatientsRepository) {}

  async run(practiceId: string, search: PatientSearch, actor: ConsoleActor) {
    const salida = await this.repo.list({ actor, practiceId, search });
    if (salida === null) throw new ContractError('consulta_no_existe');

    return {
      cuantas: salida.page.length,
      siguiente: salida.next,
      // Para que la pantalla pinte «148 de 300» ANTES del botón. Quien dice que no hay sitio
      // sigue siendo el `409` del alta: dos pestañas a la vez no se pasan del límite porque
      // la pantalla contó bien.
      plan: { pacientes: salida.patients, limite_pacientes: salida.limit },
      pacientes: salida.page.map(renglon),
    };
  }
}

export class ReadConsolePatient {
  constructor(private readonly repo: PlatformPatientsRepository) {}

  async run(patientId: string, actor: ConsoleActor) {
    const ficha = await this.repo.read({ actor, patientId });
    if (ficha === null) throw FICHA_NO_EXISTE();
    return vista(ficha);
  }
}

export class ReadConsoleHistory {
  constructor(private readonly repo: PlatformPatientsRepository) {}

  /**
   * El `motivo` ya viene validado del borde, y la función de base lo vuelve a exigir. Su
   * `null` es el `404`, y eso NO es una comprobación aparte: la fila de auditoría y la
   * existencia de la paciente son la misma operación, a propósito.
   */
  async run(patientId: string, reason: string, actor: ConsoleActor) {
    const historia = await this.repo.readHistory({ actor, patientId, reason });
    if (historia === null) throw FICHA_NO_EXISTE();
    return { paciente_id: patientId, historia };
  }
}

export class SetConsolePatientStatus {
  constructor(private readonly repo: PlatformPatientsRepository) {}

  async run(patientId: string, status: 'activa' | 'archivada', actor: ConsoleActor) {
    try {
      const fila = await this.repo.setStatus({ actor, patientId, status });
      if (fila === null) throw FICHA_NO_EXISTE();
      return {
        paciente_id: patientId,
        estado: fila.status,
        archivada_en: fila.archivedAt?.toISOString() ?? null,
      };
    } catch (fallo) {
      // Reactivar vuelve a ocupar cupo: la consulta llena recibe el mismo `409` que el alta.
      if (fallo instanceof PlanFull) throw new ContractError('limite_del_plan');
      throw fallo;
    }
  }
}

/**
 * EL RENGLÓN DE LA LISTA · un subconjunto EXACTO de la ficha, y ni un campo más.
 *
 * Es la única lectura de consola que devuelve más de una paciente, así que es la única que
 * puede filtrar el padrón entero por un error de campo. Sin teléfono, sin fecha de nacimiento
 * y sin nada clínico: eso se pide de una en una.
 */
function renglon(row: PatientRow) {
  return {
    id: row.id,
    nombre: row.firstName,
    apellido: row.lastName,
    correo: row.email,
    estado: row.status,
    alta_en: row.createdOn,
    vinculo: row.linkStatus,
  };
}

/** La ficha. Datos de contacto, estado y vínculo. NI UN CAMPO CLÍNICO. */
function vista(f: PatientFile) {
  return {
    ...renglon(f),
    consulta: { id: f.practiceId, nombre: f.practiceName },
    nacimiento: f.birthDate,
    celular: f.phone,
    tiene_whatsapp: f.hasWhatsapp,
    como_llego: f.howArrived,
    archivada_en: f.archivedAt?.toISOString() ?? null,
  };
}
