// Las reglas de `consultas.md` que no son una consulta: qué puede la consulta, cómo se lee lo
// que el doctor declara de su matrícula y la etiqueta del plan. Sin NestJS, sin Fastify y sin
// `pg`.
//
// LO QUE ESTE ARCHIVO TENÍA Y YA NO, Y ES LA MITAD DE SU TAMAÑO (30 de octubre de 2026):
// `capabilities()` mirando el estado de la licencia, `readLicenseForm()` con la credencial y
// las dos aceptaciones, `isOwnCredentialKey()` y `estimatedResponseAt()` con su cálculo de
// «24 h hábiles». Se fueron con la revisión manual, que el dueño descartó: MedSkin no verifica
// licencias porque no es una asociación médica. No hay estado, no hay documento que validar y
// no hay plazo que prometer, porque no hay nadie esperando al otro lado.

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
 * `puede` · «La app **no** deduce el candado: lo lee. Así, el día que una condición nueva
 * bloquee invitar, no hay que tocar las dos apps.» Por eso esta función existe en el servidor
 * y la tabla de verdad es esta y no la de ninguna pantalla.
 *
 * **LA LICENCIA YA NO ENTRA AQUÍ** (30 de octubre de 2026). Esto miraba
 * `licenseStatus === 'verificada'` y cerraba `invitar_pacientes` y `registrar_sesiones`
 * mientras alguien revisaba. No hay revisión: MedSkin no verifica licencias, así que una
 * consulta puede invitar y registrar desde el alta.
 *
 * QUEDA UNA SOLA CONDICIÓN, y es la que hace que valga la pena que `puede` siga existiendo:
 * `hasRoom`, «quedan cupos en el plan». Entra porque **un campo que se llama `puede` tiene
 * que decir la verdad** (decisión del 28 de octubre): una consulta en su tope con
 * `invitar_pacientes: true` deja que la doctora escriba el alta entera y la pierda contra un
 * `409`. Con el candado puesto antes, la pantalla lo dice primero. El `409` del cupo de
 * `pacientes.md` se queda: es la red por si el cupo se agota entre la pantalla y el envío.
 *
 * `registrar_sesiones` NO depende del cupo: registrar un tratamiento es sobre una ficha que
 * ya existe y no consume ninguno. Con la licencia fuera, es constante — y se queda como clave
 * porque quitarla obligaría a tocar las dos apps para no ganar nada.
 */
export function capabilities(hasRoom: boolean): Capabilities {
  return {
    invitar_pacientes: hasRoom,
    registrar_sesiones: true,
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
 * especialidad de la lista»—, y lo sigue siendo aunque nadie revise: lo que la lista cerrada
 * compra ahora es que el dato se pueda agrupar y contar, que con texto libre no se puede. La
 * misma lista está en `consultas.md`, que es de donde la app saca su desplegable: se edita
 * allí y se copia aquí.
 */
export const SPECIALTIES: readonly string[] = [
  'medicina_estetica',
  'dermatologia',
  'cirugia_plastica',
  'medicina_general',
];

const LICENSE_NUMBER_MAX_LENGTH = 40;
const LICENSE_NUMBER_MIN_LENGTH = 3;

const COUNTRY_SHAPE = /^[A-Z]{2}$/;
/**
 * La lista de países de verdad, sin dependencia y sin tabla escrita a mano: ICU ya la trae
 * y un código sin asignar se delata porque su «nombre» es el propio código.
 */
const COUNTRY_NAMES = new Intl.DisplayNames(['es'], { type: 'region' });

/**
 * Lo único que se comprueba del país es QUE SEA UN PAÍS, y eso es todo lo que queda por
 * comprobar: antes el `400 pais_sin_cobertura` se apoyaba en que «un país sin cobertura lo
 * rechaza a mano quien revisa, con su motivo», y ya no hay nadie revisando. No se acota al
 * país de la consulta a propósito: una clínica de Santa Cruz puede tener una doctora con
 * matrícula argentina, y bloquearla sería negarle el producto por una regla que nadie
 * escribió.
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
};

/**
 * LO QUE EL DOCTOR DECLARA DE SU MATRÍCULA. Tres campos, y el orden de las comprobaciones es
 * el de la tabla de errores del contrato, que es el orden que ve él: primero la matrícula, que
 * es el campo que la pantalla pide arriba.
 *
 * **Y ya no hay un cuarto ni un quinto.** `credencial_clave` —la clave del documento de
 * identidad profesional escaneado—, `declaracion_aceptada` y `terminos_aceptados` se fueron
 * con la revisión. Guardar la foto del documento de identidad de alguien sin que nadie la mire
 * es quedarse con todo el riesgo de custodiarla y ninguno de sus beneficios; y la declaración
 * era «esta credencial es mía y está vigente», una afirmación sobre un documento que ya no se
 * pide. El consentimiento al tratamiento de datos **no se pierde con esto**: no vivía aquí,
 * vive en `consent` y en el alta de la cuenta, que es donde la persona lo da.
 *
 * `practiceId` ya no entra: existía para acotar la clave del objeto al inquilino del token
 * (OWASP A01), y sin clave de objeto no hay nada del cliente que apunte a otra consulta. Lo
 * que escribe esto son tres campos de texto sobre la fila de SU consulta, que es lo que su
 * política de `UPDATE` y su `GRANT` de tres columnas ya acotan en la base.
 */
export type LicenseDeclaration = {
  practiceCountry: string;
  specialty: string;
  licenseNumber: string;
};

export function readLicenseDeclaration(input: unknown): LicenseDeclaration {
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

  return { practiceCountry: country, specialty, licenseNumber };
}

/**
 * LO MISMO, PERO OPCIONAL: es el alta de la consola, donde los tres datos son un bloque que
 * se puede dejar en blanco. El formulario del alta pregunta lo mismo que la app le preguntará
 * después al doctor, así que se recoge una vez y viaja prellenado.
 *
 * Mismas validaciones, y por eso es la misma función: si la consola admitiera una especialidad
 * que la app rechaza, el doctor encontraría su formulario prellenado con algo que no puede
 * guardar.
 */
export type ConsoleLicenseDraft = LicenseDeclaration;

export function readConsoleLicenseDraft(input: unknown): ConsoleLicenseDraft | null {
  if (input === undefined || input === null) return null;
  return readLicenseDeclaration(input);
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, maxLength);
  return trimmed === '' ? null : trimmed;
}
