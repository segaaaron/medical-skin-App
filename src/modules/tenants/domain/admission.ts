// El cuerpo del alta de una consulta y el del fallo de una licencia, leídos en el borde.
// `consultas.md` · los dos `POST` de consola. Sin NestJS y sin `pg`.
//
// NINGÚN valor de estos cuerpos autoriza nada: quien llama sale del token de plataforma y el
// consulta sale de la RUTA. Lo que entra aquí son datos de una consulta que todavía no
// existe (OWASP A01).

import { ContractError } from '../../../shared/contract/error-catalog';
import type { Region } from '../../../shared/contract/session';
import type { Decision, NewOwner, NewPractice } from './platform-ports';
import { isCountry , readConsoleLicenseDraft, type ConsoleLicenseDraft } from './rules';

const REGIONS: readonly Region[] = ['eu', 'us', 'latam'];

/**
 * EL LÍMITE DE PACIENTES SALE DEL PLAN Y NO DEL CUERPO (`consultas.md` · reglas de
 * negocio), así que el catálogo vive en el borde: no hay tabla de planes y no se construye
 * (decisión 37).
 *
 * **Solo `consultorio: 300` está escrito en algún sitio** —el 201 de `consultas.md` y
 * «Plan Consultorio · 148 de 300» de `Consola.dc.html`—. Los otros dos números son
 * provisionales y están marcados: es pregunta para `producto`, y está dicho en la entrega.
 *
 * Lo que hace que el riesgo sea acotado: **el límite se COPIA en la fila al crear la
 * consulta**, así que cambiar estos números mañana no mueve el límite de ninguna consulta
 * que ya exista; solo el de las nuevas.
 */
export const PLAN_LIMITS: Readonly<Record<string, number>> = {
  individual: 100,
  consultorio: 300,
  clinica: 1000,
};

const NAME_MIN = 2;
const NAME_MAX = 120;
const PERSON_NAME_MAX = 80;
const INTERNAL_NOTE_MAX = 2000;
const CURRENCY = /^[A-Z]{3}$/;
const REJECTION_MIN = 10;
const REJECTION_MAX = 300;

export type AdmissionForm = {
  practice: Omit<NewPractice, 'patientLimit'> & { patientLimit: number };
  owner: Omit<NewOwner, 'hash' | 'expiresAt'>;
  /**
   * Los tres datos de la licencia que la consola puede recoger, o `null` si el formulario
   * no los pidió. Opcional a propósito: el alta tiene que poder hacerse sin ellos —una
   * doctora que todavía no tiene la matrícula a mano— y la fila de `license` nace igual.
   */
  license: ConsoleLicenseDraft | null;
};

/**
 * `deploymentRegion` entra porque **un despliegue sirve una región** (§7.4) y esta petición
 * escribe en ESTA base: una consulta de `eu` creada desde la consola de `latam` quedaría en
 * la base equivocada y «la región no se cambia después» es la decisión más cara de revertir.
 * El token ya se comprobó contra la región del despliegue en la puerta; esto comprueba el
 * CUERPO, que es otro dato y viene del cliente.
 *
 * El código es `region_no_corresponde` con su frase —«Abre la consola de latam»—, que es
 * exactamente lo que quien llama tiene que hacer. `region_desconocida` queda para una región
 * que no existe en el sistema, que es lo que su frase dice.
 */
export function readAdmission(
  input: unknown,
  deploymentRegion: Region,
  readEmail: (value: unknown) => string,
): AdmissionForm {
  const body = asObject(input);

  const name = text(body.nombre, NAME_MAX);
  if (name === null || name.length < NAME_MIN) throw new ContractError('nombre_vacio');

  const region = REGIONS.find((known) => known === body.region);
  if (region === undefined) throw new ContractError('region_desconocida');
  if (region !== deploymentRegion) {
    throw new ContractError(
      'region_no_corresponde',
      { region },
      `Ese token es de otra región. Abre la consola de ${region}.`,
    );
  }

  const plan = text(body.plan, 40);
  const patientLimit = plan === null ? undefined : PLAN_LIMITS[plan];
  if (plan === null || patientLimit === undefined) throw new ContractError('plan_desconocido');

  // `pais`, `zona_horaria` y `moneda` son obligatorios y NO tienen error propio en la tabla
  // del contrato: son `400 cuerpo_no_valido`, que es el del transporte para «algo de lo que
  // mandaste no está bien». Anotado para `producto`. Los tres los comprueba además la base
  // —`practice_country_ck`— y un valor mal formado reventaría con un 500 que no explica nada.
  const country = text(body.pais, 2);
  if (country === null || !isCountry(country)) throw new ContractError('cuerpo_no_valido');

  const timeZone = text(body.zona_horaria, 60);
  if (timeZone === null || !isTimeZone(timeZone)) throw new ContractError('cuerpo_no_valido');

  const currency = text(body.moneda, 3);
  if (currency === null || !CURRENCY.test(currency)) throw new ContractError('cuerpo_no_valido');

  return {
    practice: {
      name,
      region,
      country,
      timeZone,
      currency,
      plan,
      patientLimit,
      internalNote: text(body.nota_interna, INTERNAL_NOTE_MAX),
    },
    owner: readOwner(body.doctora, readEmail),
    license: readConsoleLicenseDraft(body.licencia),
  };
}

/**
 * La dueña del alta. «Una consulta sin dueña no existe, así que el alta es un solo acto.»
 *
 * Su nombre y su apellido no tienen error propio en la tabla del contrato: se usa
 * `nombre_vacio` —el mismo `codigo`, que es contrato— con la frase de ESTE campo, que es el
 * patrón ya establecido (un `codigo`, dos frases). Anotado para `producto`.
 *
 * Y el correo vacío sale como `correo_mal_escrito`, que es el que la tabla de este endpoint
 * escribe: para quien da el alta, «no mandaste correo» y «eso no es un correo» son el mismo
 * error de formulario.
 */
function readOwner(input: unknown, readEmail: (value: unknown) => string): AdmissionForm['owner'] {
  const body = asObject(input);

  const firstName = text(body.nombre, PERSON_NAME_MAX);
  const lastName = text(body.apellido, PERSON_NAME_MAX);
  if (firstName === null || lastName === null) {
    throw new ContractError(
      'nombre_vacio',
      undefined,
      'Escribe el nombre y el apellido de la doctora.',
      'doctora.nombre',
    );
  }

  try {
    return { firstName, lastName, email: readEmail(body.correo) };
  } catch (failure) {
    const isEmailProblem =
      failure instanceof ContractError &&
      (failure.code === 'correo_vacio' || failure.code === 'correo_mal_escrito');
    if (!isEmailProblem) throw failure;
    // El campo es el del formulario de la consola, que es `doctora.correo` y no `correo`.
    throw new ContractError('correo_mal_escrito', undefined, undefined, 'doctora.correo');
  }
}

/**
 * La decisión de la licencia. `revisada_por` **se ignora si viene** (lo dice el contrato): lo
 * pone el servidor desde el token, y aceptarlo del cuerpo sería dejar que la consola firmara
 * una decisión con el nombre de otra persona (OWASP A01).
 *
 * Una `decision` que no es ninguna de las dos es `400 cuerpo_no_valido`: el contrato no le da
 * código propio y no se inventa uno. Anotado para `producto`.
 */
export function readDecision(input: unknown): Decision {
  const body = asObject(input);
  const decision = body.decision;
  if (decision !== 'verificada' && decision !== 'rechazada') {
    throw new ContractError('cuerpo_no_valido');
  }

  if (decision === 'verificada') return { status: decision, rejectionReason: null };

  const reason = text(body.motivo_rechazo, REJECTION_MAX);
  if (reason === null || reason.length < REJECTION_MIN) {
    throw new ContractError('motivo_rechazo_vacio');
  }
  return { status: decision, rejectionReason: reason };
}

/**
 * La zona horaria se comprueba contra ICU, que es quien tiene la lista de la IANA: una zona
 * inventada hace lanzar al formateador, y eso es la comprobación más corta que existe. Sin
 * dependencia y sin tabla a mano.
 */
function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function asObject(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, maxLength);
  return trimmed === '' ? null : trimmed;
}

/**
 * El cuerpo del correo del alta de la dueña · `Correo.dc.html` · 1. **El texto no está en el
 * contrato** —`consultas.md` nombra el correo y su formato de frase, no su cuerpo— y está
 * anotado para `producto`, igual que el del equipo.
 *
 * Ni un dato clínico y ni una palabra de más: un correo es lo que se lee en la pantalla
 * bloqueada de un teléfono (§11.1). Texto plano, sin HTML y sin imagen de seguimiento.
 */
export function ownerWelcomeMailBody(facts: {
  firstName: string;
  email: string;
  practiceName: string;
  temporaryPassword: string;
  expiryText: string;
}): string {
  return [
    `Hola ${facts.firstName}, ya tienes tu consulta en MedSkin: ${facts.practiceName}.`,
    '',
    `Entra con ${facts.email} y esta contraseña:`,
    facts.temporaryPassword,
    '',
    `${facts.expiryText}. Al entrar eliges la tuya.`,
    'medskin.app/entrar',
  ].join('\n');
}
