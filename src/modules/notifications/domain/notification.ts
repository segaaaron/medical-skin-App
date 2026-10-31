// LOS AVISOS · lo que se manda, y lo que NUNCA se manda.
//
// La regla que da forma a este archivo es de §11.1 del diseño y del contrato de `cuidados.md`:
// **ningún aviso lleva contenido clínico**. Ni el nombre del tratamiento, ni el de la paciente,
// ni el texto de un mensaje, ni el motivo de una incidencia. Un push se lee en la pantalla de
// bloqueo, sin desbloquear el teléfono, delante de quien esté al lado.
//
// Por eso las frases viven AQUÍ y no en la base: la bandeja de salida guarda una CLAVE
// (`subject_key`) y unos identificadores, y el texto se escribe una vez, se revisa una vez y no
// se puede ensuciar con un `concat` de una consulta. Si mañana una frase cambia, cambia para
// los avisos que todavía no salieron, que es lo correcto.

/** Los tipos de aviso. Es la misma lista que el `CHECK` de `notification_outbox` (0045). */
export const KINDS = [
  'recordatorio_cita',
  'preparacion_previa',
  'cuidado',
  'hueco_libre',
  'promocion',
  'toca_volver',
  'consentimiento_por_firmar',
  'exportacion',
  'incidencia',
  'mensaje',
  'seguridad',
] as const;

export type Kind = (typeof KINDS)[number];
export type Channel = 'push' | 'correo';

export type Notification = {
  id: string;
  practiceId: string;
  accountId: string;
  kind: Kind;
  channel: Channel;
  subjectKey: string;
  /** Identificadores para que la app abra la pantalla. NUNCA texto de nadie. */
  data: Record<string, unknown>;
  attempts: number;
};

/**
 * EL TEXTO DE CADA AVISO, y está escrito para leerse en una pantalla de bloqueo.
 *
 * `title` es lo que suena; `body` lo que se lee debajo. Los dos son neutros a propósito: «Te
 * escribió tu doctora» no dice qué, y eso es lo que hace que se pueda mandar.
 *
 * El `body` del correo lleva la misma frase más la salida: el correo no es más privado que el
 * push —lo abre cualquiera que tenga el teléfono— y la regla es la misma.
 */
export const SUBJECTS: Readonly<Record<string, { title: string; body: string }>> = {
  cita_24h: {
    title: 'Tu cita es mañana',
    body: 'Abre MedSkin para ver la hora y cómo prepararte.',
  },
  cita_2h: { title: 'Tu cita es en dos horas', body: 'Abre MedSkin para ver la hora.' },
  preparacion: {
    title: 'Prepárate para mañana',
    body: 'Tu consulta te dejó indicaciones para antes de la cita.',
  },
  cuidado: { title: 'Toca un cuidado', body: 'Abre MedSkin para ver cuál y marcarlo.' },
  hueco_libre: {
    title: 'Se liberó un horario',
    body: 'Estabas en la lista de espera. Tienes 30 minutos para tomarlo.',
  },
  promocion: { title: 'Tienes una promoción', body: 'Abre MedSkin para verla.' },
  toca_volver: {
    title: 'Toca volver',
    body: 'Ya pasó el tiempo entre sesiones. Abre MedSkin para reservar.',
  },
  consentimiento: {
    title: 'Te falta firmar un consentimiento',
    body: 'Fírmalo antes de tu cita para no perder tiempo en la consulta.',
  },
  exportacion: {
    title: 'Tus datos están listos',
    body: 'Te mandamos un enlace por correo. Dura 24 horas y se usa una vez.',
  },
  incidencia: {
    title: 'Una paciente reportó algo',
    body: 'Abre MedSkin para verlo. Puede necesitar respuesta hoy.',
  },
  mensaje: { title: 'Tienes un mensaje', body: 'Abre MedSkin para leerlo.' },
  // Aquí estaban `licencia_aprobada` y `licencia_rechazada`, los dos avisos de la decisión
  // de la licencia. Se fueron el 30 de octubre de 2026 con la revisión manual: MedSkin no
  // verifica licencias, así que no hay aprobación ni rechazo que avisar.
  seguridad: {
    title: 'Movimiento en tu cuenta',
    body: 'Si no fuiste tú, cambia tu contraseña.',
  },
};

/** La frase de un aviso. Una clave que no está es un error de programación, no un hueco. */
export function textOf(subjectKey: string): { title: string; body: string } {
  const found = SUBJECTS[subjectKey];
  if (found === undefined) {
    throw new Error(`aviso sin frase: ${subjectKey}. Las frases viven en SUBJECTS.`);
  }
  return found;
}

/**
 * LA CLAVE DE DEDUPLICACIÓN, que es la idempotencia de los ocho trabajos de `cuidados.md`.
 *
 * Se arma con lo que IDENTIFICA al aviso y nada más: el programador de recordatorios vuelve a
 * ver la misma cita cada cinco minutos, y lo que impide el segundo aviso es el índice único
 * `notification_dedupe_uq`, no que el trabajo recuerde lo que hizo.
 */
export function dedupe(parts: readonly (string | number)[]): string {
  return parts.join(':');
}
