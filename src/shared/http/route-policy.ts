// LA LISTA BLANCA DE RUTAS. `sesion.md`: «El alcance se comprueba en un guardia global,
// antes de cualquier módulo, y POR LISTA BLANCA DE RUTAS. No por lista negra: una ruta
// nueva nace CERRADA para los alcances restringidos, no abierta».
//
// Es lo que hace cumplible la regla de la contraseña temporal: con un `siguiente_paso`
// solo, una app con un error de navegación —o un cliente escrito a mano— se la salta.
//
// Y la tabla lleva además la frase del 500 de cada endpoint, porque es obligatoria y
// cambia por endpoint (`_convenciones.md` · «El 500, en todas partes»). Dos usos, una
// tabla: quien añada una ruta tiene que decidir las dos cosas en el mismo sitio.

import { FAILURE_PHRASES } from '../contract/error-catalog';
import type { Scope } from '../contract/session';
import type { PlatformPermission } from '../platform/platform-token';

/**
 * Las rutas son de TRES tipos, y exactamente uno de los tres campos abre cada una. No es una
 * variante más de lo mismo: el token de la consola lo firma otro servicio con otra llave, no
 * trae `alcance` y no viene de ninguna cuenta de esta región (`plataforma-acceso.md`). Un
 * cuarto estado —dos campos a la vez, o ninguno— no abre nada: el guardia deniega.
 */
export type RoutePolicy = {
  /** `true` solo para los tres endpoints sin `Authorization` del tramo. */
  anonymous?: true;
  /** Los alcances que esta ruta autoriza. Cualquier otro se deniega. */
  scopes?: readonly Scope[];
  /**
   * El permiso de plataforma que esta ruta exige, uno y solo uno. Su presencia es lo que
   * convierte la ruta en ruta de consola: el guardia verifica el token de plataforma en vez
   * del de sesión, y no deja `caller` sino `platform`.
   */
  platformPermission?: PlatformPermission;
  /** La frase completa del `500 fallo_de_servicio` de este endpoint, literal. */
  failurePhrase: string;
};

const ALL_SCOPES: readonly Scope[] = [
  'contrasena_temporal',
  'recuperacion',
  'segundo_factor',
  'completo',
];

/**
 * La clave es `MÉTODO ruta` con la ruta tal y como la registra Fastify, parámetros
 * incluidos (`:sesion_id`). Una ruta que no está aquí se deniega: no hay «por defecto».
 */
export const ROUTE_POLICIES: Readonly<Record<string, RoutePolicy>> = {
  'POST /v1/access': { anonymous: true, failurePhrase: FAILURE_PHRASES.signIn },

  // Los dos de recuperación, sin `Authorization` como el acceso: cuando llegan no hay
  // sesión que leer y por eso corren con `app_anonymous` (`recuperacion.md`).
  'POST /v1/recovery': {
    anonymous: true,
    failurePhrase: FAILURE_PHRASES.requestRecoveryCode,
  },
  'POST /v1/recovery/code': {
    anonymous: true,
    failurePhrase: FAILURE_PHRASES.checkRecoveryCode,
  },

  // Los dos alcances que existen para llegar a esta pantalla, y ningún otro: un token
  // `completo` aquí es `401 token_sin_alcance`, «Esta pantalla ya no corresponde».
  'POST /v1/access/new-password': {
    scopes: ['contrasena_temporal', 'recuperacion'],
    failurePhrase: FAILURE_PHRASES.savePassword,
  },

  // «cualquiera con sesión, de cualquier alcance»: nadie se queda dentro contra su
  // voluntad porque su token sea restringido.
  'DELETE /v1/access': { scopes: ALL_SCOPES, failurePhrase: FAILURE_PHRASES.signOut },

  // `sesion.md`: «cualquiera con sesión, de cualquier alcance». Los tres alcances que
  // llevan `sid`, y NO `recuperacion`, que no es una sesión: su token no trae `sid` porque
  // cuando se acierta el código todavía no hay fila que comprobar, y este endpoint es
  // justamente la fila. Un token de recuperación aquí es `401 token_sin_alcance`.
  //
  // Que el alcance restringido entre es la condición de que sirva para lo que existe: de
  // aquí saca la app qué pantalla abrir, así que negárselo a la sesión que tiene la
  // contraseña temporal la dejaría sin forma de que el servidor le dijera que le toca
  // «Crea tu contraseña». La tabla de alcances de `sesion.md` necesita la misma enmienda
  // que ya se le hizo a `DELETE /v1/access` el 27 de octubre.
  'GET /v1/session': {
    scopes: ['contrasena_temporal', 'segundo_factor', 'completo'],
    failurePhrase: FAILURE_PHRASES.readSession,
  },

  // `sesion.md`: «quien tenga un refresco vivo. NO lleva `Authorization`». Anónima como el
  // acceso y los dos de recuperación: cuando llega no hay token que verificar —acaba de
  // caducar— y la autorización es el refresco, que valida la base con `app_anonymous`
  // contra una función `SECURITY DEFINER` `VOLATILE`. El `practice_id` del token nuevo se
  // copia de la FILA de la sesión: si lo aceptara del cuerpo, sería un cambio de inquilino
  // gratuito.
  'POST /v1/session/refresh': {
    anonymous: true,
    failurePhrase: FAILURE_PHRASES.refreshSession,
  },

  // `cuentas.md` · POST /v1/patients, el alta. Solo `completo`: dar de alta a una paciente no
  // es una pantalla a la que se llegue con la contraseña todavía temporal.
  'POST /v1/patients': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.createPatient,
  },

  // `inquilinos.md` · los dos de la doctora. Solo `completo`: el contrato da
  // `403 contrasena_temporal_pendiente` para estas pantallas, que es exactamente lo que el
  // guardia devuelve cuando el alcance restringido no está en la lista.
  // `pacientes.md` · la lista y la busqueda. Recepcion SI entra: necesita encontrar a la
  // paciente para agendarle, y eso no es abrir su historia. El permiso lo comprueba el caso
  // de uso (`pacientes:leer`), que es quien sabe cual pide cada ruta.
  'GET /v1/patients': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.listPatients,
  },
  // La ficha y sus antecedentes: `historia:leer`, y recepcion NO.
  'GET /v1/patients/:id': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.readPatient,
  },
  'GET /v1/patients/:id/medical-history': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.readPatient,
  },
  // Los antecedentes escritos por LA DOCTORA: ella escribe cualquier campo, siempre, porque es
  // la responsable del expediente. La paciente escribe los suyos por `/v1/links/{id}/medical-form`.
  'PUT /v1/patients/:id/medical-history': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.editPatient,
  },
  // Corregir la ficha, archivar y reactivar: `pacientes:crear`, y recepcion NO.
  'PATCH /v1/patients/:id': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.editPatient,
  },
  'POST /v1/patients/:id/archive': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.archivePatient,
  },
  'POST /v1/patients/:id/reactivate': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.archivePatient,
  },
  // `pacientes.md` · las dos pantallas de la PACIENTE. El alcance es `completo` porque las
  // dos llegan despues de que ella eligio su contrasena; el rol lo comprueba el caso de uso,
  // que devuelve `403 rol_no_corresponde` si llama una doctora.
  'GET /v1/links': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.patientLinks,
  },
  'POST /v1/links/:link_id/accept': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.patientLinks,
  },
  'POST /v1/links/:link_id/reject': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.patientLinks,
  },
  'PUT /v1/links/:link_id/medical-form': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.patientHistory,
  },
  // `negocio.md` · el dinero. Los margenes y los informes son SOLO de la duena, y el asistente
  // clinico no registra cobros: lo comprueba el caso de uso con el permiso de cada uno.
  'POST /v1/payments': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.savePayment },
  'GET /v1/payments': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.readPayments },
  'POST /v1/payments/:id/void': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.savePayment,
  },
  'GET /v1/margins': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.readMargins },
  'GET /v1/inventory': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.readInventory },
  'POST /v1/inventory': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.readInventory },
  'POST /v1/inventory/movements': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.saveMovement,
  },
  'GET /v1/reports': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.readReports },
  'GET /v1/plan': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.readPlan },
  'POST /v1/plan/extend': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.readPlan },
  'POST /v1/my-data/exports': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.requestExport,
  },
  'GET /v1/my-data/exports/:id': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.requestExport,
  },

  // `cuidados.md` · los cuidados, el hilo y los avisos. Casi todos son de la PACIENTE; la
  // consulta entra en el plan —para ver la adherencia— y en el hilo.
  'GET /v1/aftercare': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.readAftercare },
  'POST /v1/aftercare/:step_id/done': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.markCareStep,
  },
  'GET /v1/traffic-light/:session_id': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.readTrafficLight,
  },
  'POST /v1/incidents': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.reportIncident },
  'GET /v1/messages': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.readMessages },
  'POST /v1/messages': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.sendMessage },
  // El dispositivo se registra APENAS entra: por eso vale con la contraseña todavia temporal.
  'POST /v1/devices': {
    scopes: ['contrasena_temporal', 'segundo_factor', 'completo'],
    failurePhrase: FAILURE_PHRASES.saveDevice,
  },
  'DELETE /v1/devices/:device_id': {
    scopes: ['contrasena_temporal', 'segundo_factor', 'completo'],
    failurePhrase: FAILURE_PHRASES.saveDevice,
  },
  'GET /v1/alerts/preferences': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.savePreferences,
  },
  'PUT /v1/alerts/preferences': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.savePreferences,
  },

  // `imagenes.md` · las fotos. Las dos puertas: la consulta y la paciente —ella sube las suyas
  // y compara su progreso, que es lo que vuelve adictivo el avance—.
  'POST /v1/photos/upload-url': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.signUpload },
  'POST /v1/photos/:photo_id/confirm': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.confirmUpload,
  },
  'GET /v1/photos': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.readPhotos },
  'GET /v1/photos/:photo_id/master': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.readMaster,
  },
  'GET /v1/photos/:photo_id/compare': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.comparePhotos,
  },
  'POST /v1/photos/:photo_id/reprocess': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.readPhotos,
  },
  'DELETE /v1/photos/:photo_id': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.deletePhoto,
  },

  // `sesiones.md` · el expediente. `POST /v1/consents` lo llaman las dos puertas —la paciente
  // firma el suyo, o la consulta con ella presente— y el rol lo resuelve el caso de uso.
  'POST /v1/clinical-sessions': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.saveSession,
  },
  'PUT /v1/clinical-sessions/:id/note-draft': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.saveNoteDraft,
  },
  'POST /v1/clinical-sessions/:id/note/sign': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.signNote,
  },
  'POST /v1/clinical-sessions/:id/correction': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.saveCorrection,
  },
  'POST /v1/clinical-sessions/:id/adverse-event': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.saveAdverseEvent,
  },
  'POST /v1/clinical-sessions/:id/void': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.voidSession,
  },
  'GET /v1/lots': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.readLots },
  'POST /v1/lots': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.saveLot },
  'GET /v1/lots/:id/patients': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.readLots },
  'GET /v1/consents/:treatment_id/text': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.readConsentText,
  },
  'POST /v1/consents': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.saveConsent },

  // `agenda.md` · la agenda. `GET /v1/availability`, `POST /v1/appointments` y los de la seña
  // los llaman LAS DOS puertas —la consulta y la paciente—, y quien decide cual es el caso de
  // uso: el rol sale del token, nunca del cuerpo.
  'GET /v1/schedules': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.saveSchedule },
  'PUT /v1/schedules': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.saveSchedule },
  'GET /v1/availability': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.readAvailability,
  },
  'POST /v1/appointments': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.bookAppointment,
  },
  'GET /v1/appointments': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.readAppointments,
  },
  'GET /v1/appointments/:id': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.readAppointments,
  },
  'PATCH /v1/appointments/:id': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.moveAppointment,
  },
  'POST /v1/appointments/:id/cancel': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.cancelAppointment,
  },
  'POST /v1/appointments/:id/deposit': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.saveDeposit,
  },
  'POST /v1/appointments/:id/deposit/confirm': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.saveDeposit,
  },
  'POST /v1/appointments/:id/attendance': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.readAppointments,
  },
  'POST /v1/waitlist': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.saveWaitlist },
  'DELETE /v1/waitlist/:id': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.saveWaitlist,
  },
  'POST /v1/sync': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.syncBatch },

  // `tratamientos.md` · el catalogo de la doctora. El permiso lo comprueba el caso de uso:
  // `catalogo:editar` para el catalogo, `precios:editar` para el dinero, `promociones:editar`
  // para las promociones. Son tres porque una asistente ve el catalogo y no toca el dinero.
  'GET /v1/treatments': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.readTreatments },
  'POST /v1/treatments': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.saveTreatment },
  'PATCH /v1/treatments/:id': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.saveTreatment },
  'POST /v1/treatments/:id/archive': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.saveTreatment,
  },
  'POST /v1/treatments/:id/reactivate': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.saveTreatment,
  },
  'GET /v1/treatments/:id/protocol': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.saveProtocol,
  },
  'PUT /v1/treatments/:id/protocol': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.saveProtocol,
  },
  'GET /v1/treatments/:id/contraindications': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.saveContraindications,
  },
  'PUT /v1/treatments/:id/contraindications': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.saveContraindications,
  },
  'GET /v1/prices': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.savePrices },
  'PUT /v1/prices': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.savePrices },
  'GET /v1/promotions': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.savePromotion },
  'POST /v1/promotions': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.savePromotion },
  'PATCH /v1/promotions/:id': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.savePromotion,
  },
  // Y el de la PACIENTE, que es donde se cumple la regla clinica.
  'GET /v1/catalog': { scopes: ['completo'], failurePhrase: FAILURE_PHRASES.readCatalog },
  'GET /v1/tenants/mine': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.readOwnPractice,
  },
  'POST /v1/tenants/mine/license': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.submitLicense,
  },

  'GET /v1/accounts/mine': {
    scopes: ['contrasena_temporal', 'segundo_factor', 'completo'],
    failurePhrase: FAILURE_PHRASES.readOwnAccount,
  },

  // Solo `completo`: la pantalla pide la contraseña actual, que es justo lo que una sesión
  // restringida no tiene. Y la 0014 le niega el `EXECUTE` del borrado a `app_account`, que
  // es el rol de esa sesión: la frontera está en los dos lados.
  'DELETE /v1/accounts/mine': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.deleteOwnAccount,
  },

  'POST /v1/team': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.createTeamMember,
  },

  // El reenvío del acceso del equipo, que es el endpoint que cierra el hueco del alta: si el
  // relé falla, la cuenta ya existe y reintentar el alta da `409 correo_no_disponible`. Solo
  // `completo`, igual que el alta y que el reenvío de pacientes.
  'POST /v1/team/:member_id/access': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.resendTeamAccess,
  },

  'GET /v1/access/sessions': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.listSessions,
  },
  'DELETE /v1/access/sessions': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.closeSession,
  },
  'DELETE /v1/access/sessions/:session_id': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.closeSession,
  },

  // `cuentas.md`. Solo `completo`: cambiar la contraseña sabiendo la actual no es una
  // pantalla a la que se llegue con un alcance restringido, y la que sí lo es
  // —`contrasena-nueva`— es otra ruta.
  'PATCH /v1/accounts/mine/password': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.changePassword,
  },
  'POST /v1/accounts/:account_id/access': {
    scopes: ['completo'],
    failurePhrase: FAILURE_PHRASES.sendPatientAccess,
  },

  // ---------------------------------------------------------------------------------
  // LA CONSOLA INTERNA · `plataforma-acceso.md`. Las cinco rutas que abre el token de
  // plataforma, con el permiso que cada una pide, copiado de la tabla del contrato.
  //
  // Están aquí ANTES de que existan sus controladores a propósito: una ruta registrada sin
  // política es un `500` que ninguna prueba de unidad ve, y quien escriba el controlador no
  // tiene que acordarse de esto. Una política sin ruta registrada, en cambio, no hace nada:
  // Fastify responde `404 ruta_no_existe` hasta que el controlador exista.
  //
  // `POST /v1/session/suplantacion` NO está, y es la línea que no se cruza: su permiso
  // (`plataforma:suplantar`) está en `propuesto` y sin entrada aquí la ruta no se puede
  // servir ni por descuido.
  // ---------------------------------------------------------------------------------
  'POST /v1/platform/tenants': {
    platformPermission: 'plataforma:inquilinos:crear',
    failurePhrase: FAILURE_PHRASES.createTenant,
  },
  'GET /v1/platform/tenants/:id': {
    platformPermission: 'plataforma:inquilinos:leer',
    failurePhrase: FAILURE_PHRASES.readTenant,
  },
  'POST /v1/platform/tenants/:id/license/decision': {
    platformPermission: 'plataforma:licencias:decidir',
    failurePhrase: FAILURE_PHRASES.decideLicense,
  },
  'POST /v1/platform/accounts/:account_id/access/resend': {
    platformPermission: 'plataforma:acceso:reenviar',
    failurePhrase: FAILURE_PHRASES.resendPlatformAccess,
  },
  'DELETE /v1/platform/accounts/:account_id/lock': {
    platformPermission: 'plataforma:pausa:levantar',
    failurePhrase: FAILURE_PHRASES.liftAccessPause,
  },
};

export function policyFor(method: string, route: string | undefined): RoutePolicy | null {
  if (route === undefined) return null;
  return ROUTE_POLICIES[`${method.toUpperCase()} ${route}`] ?? null;
}
