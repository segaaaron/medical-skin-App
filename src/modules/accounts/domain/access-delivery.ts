// El bloque `acceso` de `cuentas.md`: por dónde se le manda el acceso a una paciente y qué
// se le devuelve a la app para que pueda mandarlo.
//
// ESTO EXISTE PORQUE MEDSKIN NO TIENE NÚMERO DE WHATSAPP. No tiene API de Meta y no manda
// mensajes por ella (estado del diseño, 28 oct). Lo único que puede hacer el backend es
// devolver el enlace armado para que la app abra el chat de esa paciente con el texto ya
// puesto, y que el botón de enviar sea el de WhatsApp.
//
// El texto lo redacta el SERVIDOR y no la app: así las dos apps dicen lo mismo y la frase
// se corrige en un sitio.

/** `correo | whatsapp | ninguna`, y `ya_tiene_cuenta` solo sale, nunca entra. */
export const DELIVERY_CHANNELS = ['correo', 'whatsapp', 'ninguna'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

export function isDeliveryChannel(value: unknown): value is DeliveryChannel {
  return typeof value === 'string' && (DELIVERY_CHANNELS as readonly string[]).includes(value);
}

/**
 * Cuándo viaja la temporal en claro, que es la concesión más incómoda del tramo y se asume
 * con los ojos abiertos:
 *
 * | `via`      | ¿viaja? | por qué |
 * |------------|---------|---------|
 * | `whatsapp` | sí      | sin ella no hay mensaje que mandar. Es el costo de no tener número |
 * | `ninguna`  | sí      | la doctora eligió dárselo en persona |
 * | `correo`   | **no**  | el correo lo manda MedSkin; que la doctora la lea no aporta nada y la expone |
 */
export function temporaryTravelsTo(via: DeliveryChannel): boolean {
  return via !== 'correo';
}

/** Lo que la frase del mensaje necesita. Ni un dato clínico: nombre, correo y quién manda. */
export type DeliveryFacts = {
  patientFirstName: string;
  patientEmail: string;
  practitionerName: string;
  temporaryPassword: string;
  /** «Caduca el jueves 30 a las 18:24», ya escrito por el reloj del despliegue. */
  expiryText: string;
};

/**
 * «soy la Dra. Andrea Paz» cuando el nombre guardado trae título, «soy Andrea Paz» cuando
 * no. El artículo pertenece al TÍTULO y no a la plantilla: con «la » fija y un
 * `practitioner_name` sin título —que la base admite— a la paciente le llegaba «soy la
 * Andrea Paz». Y el artículo lo decide el título porque es lo único que tiene género; el
 * nombre no se mira.
 */
const ARTICLE_BY_TITLE: Readonly<Record<string, string>> = { 'Dra.': 'la', 'Dr.': 'el' };

export function presentationOf(practitionerName: string): string {
  const article = ARTICLE_BY_TITLE[practitionerName.split(' ')[0] ?? ''];
  return article === undefined ? practitionerName : `${article} ${practitionerName}`;
}

/**
 * El texto del WhatsApp, literal del contrato. Dice para qué sirve la app en los términos
 * de la propia paciente —«tus tratamientos, tus cuidados y tus citas»— y NO dice ni un dato
 * clínico: ni qué tratamiento, ni cuándo, ni por qué.
 */
export function whatsappText(facts: DeliveryFacts): string {
  return [
    `Hola ${facts.patientFirstName}, soy ${presentationOf(facts.practitionerName)}. Te di de alta en MedSkin para que veas tus tratamientos, tus cuidados y tus citas.`,
    '',
    `Entra con ${facts.patientEmail} y esta contraseña:`,
    facts.temporaryPassword,
    '',
    'Caduca en 72 horas y al entrar eliges la tuya.',
    'medskin.app/entrar',
  ].join('\n');
}

/**
 * El texto de quien YA TIENE CUENTA. Sin contraseña, porque no se le acuña ninguna: «ya
 * tiene la suya», y lo que verá es la pantalla «¿Es esta tu doctora?».
 */
export function whatsappTextForExistingAccount(facts: {
  patientFirstName: string;
  practitionerName: string;
}): string {
  return [
    `Hola ${facts.patientFirstName}, soy ${presentationOf(facts.practitionerName)}. Te di de alta en MedSkin para que veas tus tratamientos, tus cuidados y tus citas.`,
    '',
    'Entra con tu cuenta de siempre y te va a preguntar si soy tu doctora.',
    'medskin.app/entrar',
  ].join('\n');
}

/**
 * El cuerpo del correo del acceso. Hoy dice LO MISMO que el de WhatsApp —son los mismos
 * hechos, para la misma paciente, con la misma contraseña— y por eso reutiliza su texto en
 * vez de copiarlo. Vive con su propio nombre porque son dos canales: el de WhatsApp es
 * literal del contrato y solo cambia ahí, y el del correo puede divergir sin tocarlo.
 *
 * Nada clínico, igual que el otro: ni tratamiento, ni zona del cuerpo, ni por qué. Texto
 * plano, sin HTML y sin imagen de seguimiento (el patrón de `recovery-mail.ts`).
 */
export function accessMailBody(facts: DeliveryFacts): string {
  return whatsappText(facts);
}

/**
 * Lo que necesita el AVISO de quien ya tiene cuenta: a quién se le escribe y quién la dio de
 * alta. Sin contraseña, porque no se le acuña ninguna, y sin un dato clínico.
 */
export type LinkNoticeFacts = {
  patientEmail: string;
  patientFirstName: string;
  practitionerName: string;
};

/**
 * EL CORREO DE QUIEN YA TIENE CUENTA · `POST /v1/patients` con `via: "correo"` cuando el
 * correo ya tenía cuenta en la región.
 *
 * Existe porque esa persona TIENE QUE ENTERARSE de que una consulta la dio de alta: es su
 * identidad la que queda vinculada, y enterarse es lo único que le permite reaccionar
 * (decisión del dueño, 28 de octubre de 2026). Antes no se le mandaba nada y lo único que lo
 * delataba era la pantalla «¿Es esta tu doctora?» la próxima vez que abriera la app.
 *
 * Reutiliza el texto de WhatsApp de ese mismo caso en vez de copiarlo: son los mismos hechos
 * para la misma persona, y ninguno de los dos nombra una contraseña, porque no hay ninguna.
 */
export function linkNoticeMailBody(facts: LinkNoticeFacts): string {
  return whatsappTextForExistingAccount(facts);
}

/**
 * Lo que el correo de la CONSOLA puede decir, que es menos que todo lo demás y no por
 * prudencia: `app_platform` lee de `account` cuatro columnas —«correo, rol, estado y pausa»,
 * literal— y el nombre no está entre ellas. Así que este correo no saluda por el nombre,
 * porque soporte no lo puede leer. Lo que no se puede leer no se filtra.
 */
export type PlatformDeliveryFacts = {
  email: string;
  temporaryPassword: string;
  expiryText: string;
};

/**
 * EL CORREO DEL REENVÍO DE LA CONSOLA · `POST /v1/platform/accounts/{id}/access/resend`.
 *
 * «Va a su propio correo. Soporte no la ve», y es literal: la contraseña está en este cuerpo
 * y NO en la respuesta del endpoint. Plantilla propia y no la de la paciente por dos razones
 * que se tocan: la de la paciente se presenta en nombre de su doctora —«soy la Dra. Andrea
 * Paz»— y soporte no puede leer quién es su doctora ni a qué consulta pertenece, y esta misma
 * ruta sirve también a una cuenta de practicante, donde esa frase sería falsa.
 *
 * Ni un dato clínico, ni el nombre de una clínica, ni quién pidió el reenvío.
 */
export function platformAccessMailBody(facts: PlatformDeliveryFacts): string {
  return [
    'Hola, te mandamos una contraseña temporal para entrar a MedSkin.',
    '',
    `Entra con ${facts.email} y esta contraseña:`,
    facts.temporaryPassword,
    '',
    'Caduca en 72 horas y al entrar eliges la tuya.',
    'medskin.app/entrar',
  ].join('\n');
}

// AQUÍ VIVÍA EL CORREO DEL ALTA DE EQUIPO (`TeamDeliveryFacts` y `teamAccessMailBody`), y se
// fue el 31 de octubre de 2026: quedó huérfano cuando se borró `POST /v1/team` con los tres
// roles en inglés. Nadie lo llamaba desde entonces — una plantilla de correo viva que ningún
// camino puede disparar es la que alguien reusa dentro de seis meses creyendo que está probada.

export function whatsappUrl(phoneE164: string, text: string): string {
  const digits = phoneE164.replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
