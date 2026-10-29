// GET /v1/tenants/mine · «La doctora lee su consulta y, sobre todo, el estado de su
// licencia».
//
// Es la única lectura del tramo que la app pide ANTES de tener nada más: de ella sale si se
// dibuja el aviso ámbar de «Licencia en revisión» o el cobre de «Licencia verificada», y por
// eso su 500 no es alerta sino el estado «sin conexión» con lo último guardado.
//
// DOS COSAS SE DERIVAN AQUÍ Y EN NINGÚN OTRO SITIO:
//   1. `puede`, que la app LEE y no deduce del estado de la licencia.
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
    estado: string;
    enviada_en: string | null;
    respuesta_estimada_en: string | null;
    motivo_rechazo: string | null;
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
    // de tocar la base: una paciente no pertenece a ningún inquilino, así que no hay
    // contexto que abrir ni consulta que leer (OWASP A01, denegar por defecto).
    if (caller.accountRole === 'paciente' || caller.practiceId === null) {
      throw new ContractError('rol_no_corresponde');
    }

    const practice = await this.practices.read({
      accountId: caller.accountId,
      practiceId: caller.practiceId,
    });

    // Un token que dice inquilino y una consulta que no se puede leer es una inconsistencia
    // del servidor, no una sesión inválida: va a `service_failure` con su causa real y la
    // app se queda con lo último guardado. No se inventa una consulta vacía.
    if (practice === null) {
      throw new ServiceFailure(
        FAILURE_PHRASES.readOwnPractice,
        new Error(`el inquilino ${caller.practiceId} no tiene consulta ni licencia que servir`),
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
      estado: practice.license.status,
      enviada_en: practice.license.submittedAt?.toISOString() ?? null,
      respuesta_estimada_en: practice.license.responseEstimatedAt?.toISOString() ?? null,
      motivo_rechazo: practice.license.rejectionReason,
    },
    // `puede` se deriva de la licencia Y DEL CUPO: la consulta en su tope recibe
    // `invitar_pacientes: false` y la pantalla pinta el candado antes de que la doctora
    // escriba el alta de una paciente y la pierda contra un `409`. El recuento es el mismo
    // que ya viaja en `plan.pacientes`: una sola verdad por respuesta.
    puede: capabilities(
      practice.license.status,
      hasRoomForPatients(practice.activePatients, practice.patientLimit),
    ),
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
