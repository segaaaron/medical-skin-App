// Las reglas de `consultas.md` que no son una consulta: qué puede la consulta con su
// licencia, si la lista del primer día se dibuja, cómo se lee el formulario de la licencia y
// cuándo se promete la respuesta. Sin NestJS, sin Fastify y sin `pg`.

import { ContractError } from '../../../shared/contract/error-catalog';

/**
 * `plan.nombre` es constante del borde: la base guarda la clave y el `CHECK`
 * `practice_plan_ck` la acota a estas tres. No hay tabla de planes y no se construye
 * (decisión 37: el plan vive como tres columnas de `practice`).
 */
const PLAN_LABELS: Readonly<Record<string, string>> = {
  individual: 'Individual',
  consultorio: 'Consultorio',
  clinica: 'Clínica',
};

/**
 * Una clave que no esté en la tabla devuelve la clave, no un 500: lo que se pierde es una
 * etiqueta de pantalla, y caerse por una etiqueta dejaría a la doctora sin la licencia, el
 * plan y el primer día, que es todo lo que esta lectura sirve.
 */
export function planLabel(plan: string): string {
  return PLAN_LABELS[plan] ?? plan;
}

export type Capabilities = {
  invitar_pacientes: boolean;
  registrar_sesiones: boolean;
  armar_catalogo: boolean;
  definir_horarios: boolean;
};

/**
 * `puede` · «La app **no** deduce el candado del estado de la licencia: lo lee. Así, el día
 * que una condición nueva bloquee invitar, no hay que tocar las dos apps.» Por eso esta
 * función existe en el servidor y la tabla de verdad es esta y no la de ninguna pantalla.
 * Y ese «día que una condición nueva bloquee invitar» ya llegó: es el cupo del plan.
 *
 * `hasRoom` es «quedan cupos en el plan», y entra porque **un campo que se llama `puede`
 * tiene que decir la verdad** (decisión del 28 de octubre): una consulta en su tope con
 * `invitar_pacientes: true` deja que la doctora escriba el alta entera y la pierda contra un
 * `409`. Con el candado puesto antes, la pantalla lo dice primero. El `409
 * licencia_sin_verificar` y el del cupo de `pacientes.md` se quedan donde están: son la red
 * por si el cupo se agota entre la pantalla y el envío.
 *
 * `registrar_sesiones` NO depende del cupo: registrar un tratamiento es sobre una ficha que
 * ya existe y no consume ninguno.
 *
 * Los dos de arranque están en `true` desde el alta y enviar la licencia no desbloquea nada:
 * «la espera no bloquea el arranque» (`PrimerDia.dc.html` · 1).
 */
export function capabilities(licenseStatus: string, hasRoom: boolean): Capabilities {
  const verified = licenseStatus === 'verificada';
  return {
    invitar_pacientes: verified && hasRoom,
    registrar_sesiones: verified,
    armar_catalogo: true,
    definir_horarios: true,
  };
}

/** «148 de 300»: el recuento es de fichas `activa`, que es el que libera cupo al archivar. */
export function hasRoomForPatients(activePatients: number, patientLimit: number): boolean {
  return activePatients < patientLimit;
}

// ---------------------------------------------------------------------------------------
// El formulario de la licencia
// ---------------------------------------------------------------------------------------

/**
 * EL CATÁLOGO DE LA PRIMERA ENTREGA, decidido por `producto` el 28 de octubre: una consulta
 * de estética la lleva una de estas cuatro en la práctica, y quedarse con `medicina_estetica`
 * sola rechazaría a doctoras reales el primer día.
 *
 * Es lista cerrada a propósito —denegar por defecto es lo que hace cumplible «Elige una
 * especialidad de la lista»—: este campo lo lee a mano quien revisa, y un valor libre
 * convierte un desplegable en un comentario. La misma lista está en `consultas.md`, que es
 * de donde la app saca su desplegable: se edita allí y se copia aquí.
 */
export const SPECIALTIES: readonly string[] = [
  'medicina_estetica',
  'dermatologia',
  'cirugia_plastica',
  'medicina_general',
];

/** `credencial_clave` es la clave de un objeto, no una URL, y estas son las que admite. */
const CREDENTIAL_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.pdf'];
const CREDENTIAL_KEY_MAX_LENGTH = 200;
const LICENSE_NUMBER_MAX_LENGTH = 40;
const LICENSE_NUMBER_MIN_LENGTH = 3;

const COUNTRY_SHAPE = /^[A-Z]{2}$/;
/**
 * La lista de países de verdad, sin dependencia y sin tabla escrita a mano: ICU ya la trae
 * y un código sin asignar se delata porque su «nombre» es el propio código.
 */
const COUNTRY_NAMES = new Intl.DisplayNames(['es'], { type: 'region' });

/**
 * LA COBERTURA POR PAÍS NO ESTÁ DECIDIDA en ningún contrato, así que lo que esto comprueba
 * hoy es que el código sea un país: el `400 pais_sin_cobertura` existe y es alcanzable, y la
 * lista de los países donde MedSkin opera es pregunta para `producto`. Se eligió no
 * inventarla —ni acotarla al país de la consulta— porque una doctora de una clínica de Santa
 * Cruz puede tener su matrícula de Argentina, y bloquearla sería negarle el producto por una
 * regla que nadie escribió. La revisión es a mano: un país sin cobertura lo rechaza la
 * persona que revisa, con su motivo.
 *
 * Lo usan los dos lados: el `pais_ejercicio` de la licencia y el `pais` del alta de una
 * consulta. El código de error es distinto porque las tablas de los dos contratos lo son
 * —`pais_sin_cobertura` allí, `cuerpo_no_valido` aquí—; la comprobación es la misma.
 */
export function isCountry(code: string): boolean {
  return COUNTRY_SHAPE.test(code) && COUNTRY_NAMES.of(code) !== code;
}

export type LicenseFormInput = {
  pais_ejercicio?: unknown;
  especialidad?: unknown;
  matricula?: unknown;
  credencial_clave?: unknown;
  declaracion_aceptada?: unknown;
  terminos_aceptados?: unknown;
};

export type ReadLicenseForm = {
  practiceCountry: string;
  specialty: string;
  licenseNumber: string;
  credentialKey: string;
};

/**
 * El orden de las comprobaciones es el de la tabla de errores del contrato, y es el orden
 * que ve la doctora: primero su matrícula, que es el campo que la pantalla pide arriba.
 *
 * `practiceId` entra para acotar la clave del objeto AL INQUILINO DEL TOKEN: la clave la
 * escribe el cliente, y una clave `lic/<otra consulta>/…` haría que quien revisa abriera por
 * enlace firmado el documento de identidad de otra doctora (OWASP A01). No se comprueba
 * contra la URL que mandó nadie: se compara con la consulta del token.
 */
/**
 * LOS TRES DATOS DE LA LICENCIA QUE PUEDE RECOGER LA CONSOLA · decidido por el dueño el 30 de
 * octubre de 2026.
 *
 * El formulario del alta pregunta lo mismo que la app le preguntará después a la doctora, así
 * que se recoge una vez y viaja prellenado. Lo que NO entra aquí, y es la línea que no se
 * cruza: la credencial escaneada y las dos aceptaciones legales. Un número de matrícula es un
 * DATO —lo teclea quien sea— y una aceptación es un ACTO de ella; que soporte marque «acepto
 * los términos» en su nombre es firmar por otra persona.
 *
 * Por eso esto no deja la licencia `en_revision`: la fila se queda en `sin_enviar`, con los
 * tres campos puestos, y la bandeja de revisión no la ve. Lo que la manda a revisar sigue
 * siendo `POST /v1/tenants/mine/license`, con `readLicenseForm()` entero.
 *
 * Mismas validaciones que allí, a propósito: si la consola admitiera una especialidad que la
 * app rechaza, la doctora encontraría su formulario prellenado con algo que no puede guardar.
 */
export type ConsoleLicenseDraft = {
  practiceCountry: string;
  specialty: string;
  licenseNumber: string;
};

export function readConsoleLicenseDraft(input: unknown): ConsoleLicenseDraft | null {
  if (input === undefined || input === null) return null;
  const body: LicenseFormInput = typeof input === 'object' ? input : {};

  const licenseNumber = text(body.matricula, LICENSE_NUMBER_MAX_LENGTH);
  if (licenseNumber === null || licenseNumber.length < LICENSE_NUMBER_MIN_LENGTH) {
    throw new ContractError('matricula_vacia');
  }

  const country = text(body.pais_ejercicio, 2);
  if (country === null || !isCountry(country)) throw new ContractError('pais_sin_cobertura');

  const specialty = text(body.especialidad, 60);
  if (specialty === null || !SPECIALTIES.includes(specialty)) {
    throw new ContractError('especialidad_desconocida');
  }

  return { practiceCountry: country, specialty, licenseNumber };
}

export function readLicenseForm(input: unknown, practiceId: string): ReadLicenseForm {
  const body: LicenseFormInput = typeof input === 'object' && input !== null ? input : {};

  const licenseNumber = text(body.matricula, LICENSE_NUMBER_MAX_LENGTH);
  if (licenseNumber === null || licenseNumber.length < LICENSE_NUMBER_MIN_LENGTH) {
    throw new ContractError('matricula_vacia');
  }

  const country = text(body.pais_ejercicio, 2);
  if (country === null || !isCountry(country)) throw new ContractError('pais_sin_cobertura');

  const specialty = text(body.especialidad, 60);
  if (specialty === null || !SPECIALTIES.includes(specialty)) {
    throw new ContractError('especialidad_desconocida');
  }

  // Los dos consentimientos ANTES de la credencial, como la tabla del contrato: son lo que
  // la pantalla pide al final y lo que no se puede dar por supuesto. `=== true` y no
  // «verdadero»: un `"true"` de texto o un `1` no son una declaración.
  if (body.declaracion_aceptada !== true) throw new ContractError('declaracion_sin_aceptar');
  if (body.terminos_aceptados !== true) throw new ContractError('terminos_sin_aceptar');

  const credentialKey = text(body.credencial_clave, CREDENTIAL_KEY_MAX_LENGTH);
  if (credentialKey === null) throw new ContractError('credencial_sin_subir');
  if (!isOwnCredentialKey(credentialKey, practiceId)) {
    throw new ContractError('credencial_no_valida');
  }

  return { practiceCountry: country, specialty, licenseNumber, credentialKey };
}

/**
 * Lo que se puede comprobar de la clave SIN el almacén: que es del prefijo de este
 * consulta, que no sale de él con un `..` y que su extensión es de las tres del contrato.
 *
 * **Que el objeto exista, su tipo real y sus 10 MB NO se comprueban aquí** y es un límite de
 * alcance dicho en la entrega: la subida por URL firmada es del tramo 6 (§7.1) y en este
 * tramo no hay puerto de archivos al que preguntar. El mismo `400 credencial_no_valida`
 * queda para cuando lo haya.
 */
export function isOwnCredentialKey(key: string, practiceId: string): boolean {
  if (key.includes('..') || key.includes('//') || key.includes('\\')) return false;
  if (!key.startsWith(`lic/${practiceId}/`)) return false;
  const lower = key.toLowerCase();
  return CREDENTIAL_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, maxLength);
  return trimmed === '' ? null : trimmed;
}

// ---------------------------------------------------------------------------------------
// `respuesta_estimada_en`
// ---------------------------------------------------------------------------------------

const RESPONSE_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

/**
 * «Hasta 24 h hábiles» (`Licencia.dc.html` · 2), y lo calcula el servidor «para que la app
 * no tenga que saber qué día es feriado en Bolivia».
 *
 * Lo que está implementado son las 24 h corridas empujadas fuera del fin de semana, en la
 * zona del despliegue: **hábiles** excluye sábado y domingo, que es lo único que se puede
 * saber sin un calendario. **Los feriados no se descuentan porque no existe ese calendario
 * en ningún sitio** —ni tabla, ni configuración, ni contrato—: es pregunta para `producto` y
 * está dicho en la entrega. La promesa queda corta en un feriado, nunca larga.
 */
export function estimatedResponseAt(now: Date, timeZone: string): Date {
  let moment = new Date(now.getTime() + RESPONSE_HOURS * HOUR_MS);
  // Tope de dos empujes: un fin de semana es como mucho dos días.
  for (let pushed = 0; pushed < 2 && isWeekend(moment, timeZone); pushed += 1) {
    moment = new Date(moment.getTime() + 24 * HOUR_MS);
  }
  return moment;
}

function isWeekend(moment: Date, timeZone: string): boolean {
  // `en-US` y no `es-BO`: lo que se compara es un día de la semana, y el inglés corto es
  // estable. El idioma de la frase que ve la doctora lo pone el reloj del borde.
  const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(moment);
  return day === 'Sat' || day === 'Sun';
}
