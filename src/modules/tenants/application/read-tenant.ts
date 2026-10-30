// GET /v1/platform/tenants/{id} · «La ficha de un consultorio en la consola interna».
//
// ES EL CONTRATO DE LA REGLA QUE DEFINE ESA PANTALLA: **soporte ve metadatos y estados,
// nunca contenido de pacientes.** No hay un solo campo de paciente en esta respuesta, y
// `incidencias` cuenta cuántas, nunca cuáles.
//
// Y la garantía importante es la inversa de «qué ve otra consulta»: `app_platform` no tiene
// ninguna política que le permita leer `patient`, `medical_history`, `session_note`, `photo`
// ni `message`. No es un filtro en el código de este endpoint; es que la consulta no
// devuelve filas ni escribiéndola a mano.

import {
  ContractError,
  FAILURE_PHRASES,
  ServiceFailure,
} from '../../../shared/contract/error-catalog';
import type { PlatformActor, TenantFile, TenantFilePort } from '../domain/platform-ports';

export type TenantFileResponse = {
  id: string;
  nombre: string;
  plan: { clave: string; pacientes: number; limite_pacientes: number };
  region: string;
  region_etiqueta: string;
  alta_en: string;
  /**
   * Los tres datos viajan junto al estado: antes, en cuanto alguien decidía, la matrícula y
   * la especialidad desaparecían de la consola y quien aprobó no podía comprobar qué aprobó.
   * Son nulos mientras nadie los haya puesto — ni la consola al dar de alta, ni ella al
   * enviar su licencia.
   */
  licencia: {
    estado: string;
    verificada_en: string | null;
    pais_ejercicio: string | null;
    especialidad: string | null;
    matricula: string | null;
  };
  versiones_app: { ios: string | null; android: string | null };
  doctora: {
    cuenta_id: string;
    correo: string;
    estado: string;
    pausa_hasta: string | null;
    sesiones_activas: number;
  };
  incidencias: readonly { clave: string; cuantas: number; causa: string }[];
};

export class ReadTenant {
  constructor(
    private readonly files: TenantFilePort,
    /** «Bolivia · bo-1». Sale de la configuración del despliegue, no de la base (decisión 6). */
    private readonly regionLabel: string,
  ) {}

  async run(practiceId: string, actor: PlatformActor): Promise<TenantFileResponse> {
    const file = await this.files.read({ actor, practiceId });
    // El `id` viene de la RUTA y no autoriza nada: se busca bajo la política de
    // `app_platform` y sin fila la respuesta es la misma que la de un `id` inventado.
    if (file === null) throw new ContractError('consulta_no_existe');

    const owner = file.owner;
    if (owner === null) {
      // «Una consulta sin dueña no existe»: el alta las crea en el mismo acto y en la misma
      // transacción. Una consulta sin ella es una inconsistencia del servidor, y la ficha de
      // la consola no se sirve a medias con un `doctora: null` que la pantalla no sabe
      // pintar. Va a `service_failure` con su causa.
      throw new ServiceFailure(
        FAILURE_PHRASES.readTenant,
        new Error(`la consulta ${practiceId} no tiene dueña que servir`),
      );
    }

    return view(file, owner, this.regionLabel);
  }
}

function view(
  file: TenantFile,
  owner: NonNullable<TenantFile['owner']>,
  regionLabel: string,
): TenantFileResponse {
  return {
    id: file.id,
    nombre: file.name,
    plan: {
      clave: file.plan,
      // El MISMO recuento que ve la doctora: `status = 'activa'`, porque las archivadas no
      // cuentan contra el límite del plan (decisión 38). Si se separaran, la pantalla diría
      // «148 de 300» y la lista de la doctora mostraría otra cosa.
      pacientes: file.activePatients,
      limite_pacientes: file.patientLimit,
    },
    region: file.region,
    region_etiqueta: regionLabel,
    alta_en: file.createdOn,
    licencia: {
      estado: file.license.status,
      // `verificada_en` solo cuando está verificada: con `rechazada` esa fecha es la del
      // rechazo, y un campo que se llama así diciendo cuándo se rechazó sería falso.
      verificada_en:
        file.license.status === 'verificada'
          ? (file.license.decidedAt?.toISOString() ?? null)
          : null,
      pais_ejercicio: file.license.practiceCountry,
      especialidad: file.license.specialty,
      matricula: file.license.licenseNumber,
    },
    // «La versión de la sesión viva vista más recientemente, no la de la dueña» (decisión
    // 40): la pregunta de la pantalla es «qué versión están corriendo», y una sesión
    // revocada no cuenta. Sin sesiones que contar, los dos son nulos.
    versiones_app: { ios: file.appVersions.ios, android: file.appVersions.android },
    doctora: {
      cuenta_id: owner.accountId,
      correo: owner.email,
      estado: owner.status,
      pausa_hasta: owner.lockedUntil?.toISOString() ?? null,
      sesiones_activas: owner.liveSessions,
    },
    // `incidencias` se alimenta de las fotos (tramo 6) y de las notificaciones (tramo 7),
    // que todavía no existen: «hasta entonces es `[]`, y la pantalla dibuja su estado vacío,
    // no un error». El campo existe desde el día uno para que la consola no cambie de forma
    // cuando esos tramos lo llenen.
    incidencias: [],
  };
}
