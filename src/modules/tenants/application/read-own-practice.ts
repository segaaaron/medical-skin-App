// GET /v1/tenants/mine · «La doctora lee su consulta: su plan, su cupo y lo que declaró».
//
// Es la única lectura del tramo que la app pide ANTES de tener nada más, y por eso su 500 no
// es alerta sino el estado «sin conexión» con lo último guardado.
//
// `licencia` son LOS TRES DATOS DECLARADOS Y LA FECHA, y nada más: no hay estado, porque nadie
// los aprueba (migración 0072). De aquí salía el aviso ámbar de «Licencia en revisión» y el
// cobre de «Licencia verificada»; no salen, porque esos dos estados no existen.
//
// DOS COSAS SE DERIVAN AQUÍ Y EN NINGÚN OTRO SITIO:
//   1. `puede`, que la app LEE y no deduce. Hoy lo cierra UNA sola condición: el cupo.
//   2. `plan.pacientes`, que cuenta solo fichas `activa` — las archivadas NO cuentan contra
//      `limite_pacientes` (decisión 38) y la consola cuenta igual por
//      `medskin_platform_practice_stats()`. Si se separan, la pantalla dice «148 de 300» y
//      la lista muestra otra cosa.

import {
  ContractError,
  FAILURE_PHRASES,
  ServiceFailure,
} from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import type { OwnPracticePort, PracticeSnapshot } from '../domain/ports';
import { capabilities, hasRoomForPatients, planLabel, type Capabilities } from '../domain/rules';

export type PracticeResponse = {
  id: string;
  nombre: string;
  direccion: string | null;
  ciudad: string | null;
  telefono: string | null;
  logo_url: string | null;
  region: string;
  zona_horaria: string;
  moneda: string;
  plan: {
    clave: string;
    nombre: string;
    limite_pacientes: number;
    pacientes: number;
    renueva_en: string | null;
  };
  licencia: {
    pais_ejercicio: string | null;
    especialidad: string | null;
    matricula: string | null;
    declarada_en: string | null;
  };
  puede: Capabilities;
  primer_dia: {
    visible: boolean;
    datos_consulta: boolean;
    horarios: boolean;
    primer_tratamiento: boolean;
  };
};

export class ReadOwnPractice {
  constructor(private readonly practices: OwnPracticePort) {}

  async run(caller: Caller): Promise<PracticeResponse> {
    // «403 rol_no_corresponde · Llama una paciente». Se decide por el rol del token y antes
    // de tocar la base: una paciente no pertenece a ninguna consulta, así que no hay
    // contexto que abrir ni consulta que leer (OWASP A01, denegar por defecto).
    if (caller.accountRole === 'patient' || caller.practiceId === null) {
      throw new ContractError('rol_no_corresponde');
    }

    const practice = await this.practices.read({
      accountId: caller.accountId,
      practiceId: caller.practiceId,
    });

    // Un token que dice consulta y una consulta que no se puede leer es una inconsistencia
    // del servidor, no una sesión inválida: va a `service_failure` con su causa real y la
    // app se queda con lo último guardado. No se inventa una consulta vacía.
    if (practice === null) {
      throw new ServiceFailure(
        FAILURE_PHRASES.readOwnPractice,
        new Error(`la consulta ${caller.practiceId} no tiene fila que servir`),
      );
    }

    return view(practice);
  }
}

function view(practice: PracticeSnapshot): PracticeResponse {
  return {
    id: practice.id,
    nombre: practice.name,
    direccion: practice.address,
    ciudad: practice.city,
    telefono: practice.phone,
    logo_url: practice.logoUrl,
    region: practice.region,
    zona_horaria: practice.timeZone,
    moneda: practice.currency,
    plan: {
      clave: practice.plan,
      nombre: planLabel(practice.plan),
      limite_pacientes: practice.patientLimit,
      pacientes: practice.activePatients,
      renueva_en: practice.planRenewsOn,
    },
    licencia: {
      pais_ejercicio: practice.license.practiceCountry,
      especialidad: practice.license.specialty,
      matricula: practice.license.licenseNumber,
      declarada_en: practice.license.declaredAt?.toISOString() ?? null,
    },
    // `puede` se deriva DEL CUPO, y ya no de la licencia: la consulta en su tope recibe
    // `invitar_pacientes: false` y la pantalla pinta el candado antes de que la doctora
    // escriba el alta de una paciente y la pierda contra un `409`. El recuento es el mismo
    // que ya viaja en `plan.pacientes`: una sola verdad por respuesta.
    puede: capabilities(hasRoomForPatients(practice.activePatients, practice.patientLimit)),
    primer_dia: {
      // «`visible: false` cuando las tres están hechas Y LA APP YA LA MOSTRÓ UNA VEZ MÁS»:
      // ese «una vez más» es `first_day_dismissed`, la columna que existe justo porque no se
      // deduce de las otras tres (migración 0000). Con las tres hechas y sin cerrar, la
      // lista se dibuja otra vez con su «Esta lista desaparece la próxima vez».
      visible: !practice.firstDay.dismissed,
      datos_consulta: practice.firstDay.practiceData,
      horarios: practice.firstDay.schedule,
      primer_tratamiento: practice.firstDay.firstTreatment,
    },
  };
}
