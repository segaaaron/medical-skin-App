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

/** Lo que la frase del equipo necesita. Ni un dato clínico, igual que la de la paciente. */
export type TeamDeliveryFacts = {
  firstName: string;
  email: string;
  /** El nombre de la consulta a la que la dieron de alta: «Clínica Paz». */
  practiceName: string;
  temporaryPassword: string;
  expiryText: string;
};

/**
 * EL CORREO DEL ACCESO DEL EQUIPO · `POST /v1/equipo`. «El acceso del equipo sale solo por
 * correo: no hay `wa.me` aquí. La vía por WhatsApp existe porque muchas pacientes no abren
 * el correo; quien trabaja en la consulta sí.»
 *
 * ES UNA PLANTILLA MÁS, NO UN MECANISMO MÁS: el envío es el mismo `MailPort` y el asunto es
 * el mismo «Tu acceso a MedSkin». Lo que cambia es la primera frase, porque la de la
 * paciente habla de «tus tratamientos, tus cuidados y tus citas» y eso no es lo que una
 * recepcionista va a ver.
 *
 * El texto NO está en el contrato —`cuentas.md` escribe el de la paciente y el de WhatsApp,
 * no este— y está anotado para `producto`. No dice el rol ni nada clínico: un correo es lo
 * que se lee en la pantalla bloqueada de un teléfono.
 */
export function teamAccessMailBody(facts: TeamDeliveryFacts): string {
  return [
    `Hola ${facts.firstName}, te dieron de alta en el equipo de ${facts.practiceName} en MedSkin.`,
    '',
    `Entra con ${facts.email} y esta contraseña:`,
    facts.temporaryPassword,
    '',
    'Caduca en 72 horas y al entrar eliges la tuya.',
    'medskin.app/entrar',
  ].join('\n');
}

/**
 * El `wa.me` con el texto escapado. El número va SIN el `+` y sin signos, que es lo que
 * `wa.me` admite.
 *
 * El destino es una constante del producto, no una URL que venga del cliente: lo único que
 * el cliente aporta es el número, y ese sale de la ficha de SU paciente, ya validado como
 * E.164 (OWASP A10 · SSRF — y además este enlace no lo abre el servidor, lo abre la app).
 */
export function whatsappUrl(phoneE164: string, text: string): string {
  const digits = phoneE164.replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
