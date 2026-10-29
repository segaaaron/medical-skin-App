// Los cuidados, el semáforo, las incidencias, el hilo, los dispositivos y los avisos.

import { ContractError } from '../../../shared/contract/error-catalog';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import type { Caller } from '../../access/application/caller';
import type { AftercareCaller, AftercarePort, CarePlanRow } from '../domain/ports';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERCEIVED = ['leve', 'me_preocupa', 'urgente'];
const PLATFORMS = ['ios', 'android'];
const PERMISSIONS = ['concedido', 'denegado', 'no_preguntado'];

export interface ClockPort {
  now(): Date;
}

export class Aftercare {
  constructor(
    private readonly aftercare: AftercarePort,
    private readonly clock: ClockPort,
  ) {}

  async plans(query: Record<string, unknown>, caller: Caller): Promise<unknown> {
    const asking = this.who(caller, 'historia:leer');
    // La consulta lo lee para ver la ADHERENCIA, y la paciente sabe que la ve: lo dice su
    // propia pantalla. Medir sin avisar es otra cosa.
    const patientId = asking.isPatient ? null : text(query.patient_id ?? query.paciente_id);
    if (!asking.isPatient && patientId === null) throw new ContractError('paciente_no_existe');

    const plans = await this.aftercare.plans(asking, patientId);
    return { planes: plans.map((plan) => this.planView(plan)) };
  }

  async markStep(stepId: string, input: unknown, caller: Caller): Promise<unknown> {
    const asking = this.who(caller, 'historia:leer');
    if (!UUID.test(stepId)) throw new ContractError('paso_no_existe');

    const body = asRecord(input);
    const reported = typeof body.hecho_en === 'string' ? new Date(body.hecho_en) : null;

    const marked = await this.aftercare.markStep(asking, stepId, {
      // El instante que vale es el que la app registró: se puede marcar sin conexión.
      doneAt: reported !== null && !Number.isNaN(reported.getTime()) ? reported : this.clock.now(),
      now: this.clock.now(),
    });
    if (marked.outcome === 'no_step') throw new ContractError('paso_no_existe');
    if (marked.outcome === 'future') throw new ContractError('paso_futuro');
    // No se puede desmarcar: un cuidado cumplido es un hecho de la adherencia.
    return { estado: 'hecho' };
  }

  async trafficLight(sessionId: string, caller: Caller): Promise<unknown> {
    const asking = this.who(caller, 'historia:leer');
    if (!UUID.test(sessionId)) throw new ContractError('sesion_clinica_no_existe');

    const days = await this.aftercare.trafficLight(asking, sessionId);
    if (days === null) throw new ContractError('sesion_clinica_no_existe');

    return {
      dias: days.map((day) => ({ dia: day.day, normal: day.normal, llamar_si: day.callIf })),
      // La salida, siempre: el botón que abre «Algo no va bien».
      si_algo_no_va_bien: 'POST /v1/incidents',
    };
  }

  async reportIncident(
    input: unknown,
    caller: Caller,
    idempotency: IdempotencyRecord,
  ): Promise<unknown> {
    const asking = this.who(caller, 'historia:leer');
    const body = asRecord(input);

    const sessionId = text(body.session_id ?? body.sesion_id);
    if (sessionId === null || !UUID.test(sessionId)) {
      throw new ContractError('sesion_clinica_no_existe');
    }
    const what = text(body.que_pasa, 2000);
    if (what === null) throw new ContractError('texto_vacio');
    // SIN VALOR POR OMISION: una gravedad que el servidor no reconoce es un 400, no un `leve`
    // en silencio. Es el dato que ordena la pantalla de urgencias de la doctora.
    const perceived = enumOf(body.gravedad_percibida, PERCEIVED, 'leve');
    if (perceived === null) throw new ContractError('gravedad_desconocida');

    const reported = await this.aftercare.reportIncident(
      asking,
      {
        sessionId,
        what,
        since: text(body.desde),
        perceived,
        photoIds: Array.isArray(body.fotos) ? body.fotos.filter(isUuid) : [],
      },
      idempotency,
      incidentView,
    );
    if (reported.replay !== null) return reported.replay;
    if (reported.outcome === 'no_session') throw new ContractError('sesion_clinica_no_existe');

    return incidentView({
      id: reported.id!,
      practitioner: reported.practitioner,
      phone: reported.phone,
      notified: reported.notified,
    });
  }

  async messages(query: Record<string, unknown>, caller: Caller): Promise<unknown> {
    const { asking, patientId, practiceId } = await this.thread(caller, query);
    const thread = await this.aftercare.thread(asking, { patientId, practiceId }, false);
    if (thread === 'revoked') throw new ContractError('vinculo_revocado');
    // Un hilo que todavía no existe es un hilo vacío, no un 404 y no una fila nueva: «una
    // paciente, una doctora, un hilo», y nace cuando alguna escribe.
    if (thread === null) return { hilo: { id: null, cerrado: false }, mensajes: [] };

    const before = typeof query.antes_de === 'string' ? new Date(query.antes_de) : null;
    const messages = await this.aftercare.messages(
      asking,
      thread.id,
      before !== null && !Number.isNaN(before.getTime()) ? before : null,
    );

    return {
      hilo: { id: thread.id, cerrado: thread.closedAt !== null },
      mensajes: messages.map((message) => ({
        id: message.id,
        de: message.author,
        texto: message.body,
        enviado_en: message.createdAt.toISOString(),
        leido_en: message.readAt?.toISOString() ?? null,
      })),
    };
  }

  async send(input: unknown, caller: Caller, idempotency: IdempotencyRecord): Promise<unknown> {
    const body = asRecord(input);
    const { asking, patientId, practiceId } = await this.thread(caller, body);

    const text_ = text(body.texto);
    if (text_ === null) throw new ContractError('mensaje_vacio');
    if (text_.length > 2000) throw new ContractError('mensaje_demasiado_largo');

    const thread = await this.aftercare.thread(asking, { patientId, practiceId }, true);
    if (thread === 'revoked') throw new ContractError('vinculo_revocado');
    if (thread === null) throw new ContractError('vinculo_no_existe');

    const sent = await this.aftercare.send(asking, thread.id, text_, idempotency);
    if (sent.replay !== null) return sent.replay;
    if (sent.outcome === 'too_many') throw new ContractError('demasiados_mensajes');
    // El push de este mensaje NO lleva el texto: «Tienes un mensaje de tu doctora». El texto de
    // un mensaje clínico no viaja a una pantalla de bloqueo.
    return { id: sent.id, enviado: true };
  }

  async registerDevice(input: unknown, caller: Caller): Promise<unknown> {
    const asking = this.who(caller, 'historia:leer');
    const body = asRecord(input);

    const token = text(body.token, 512);
    const deviceId = text(body.device_id ?? body.dispositivo_id, 128);
    if (token === null || deviceId === null) throw new ContractError('formato_no_admitido');
    const platform = PLATFORMS.includes(String(body.plataforma))
      ? String(body.plataforma)
      : null;
    if (platform === null) throw new ContractError('formato_no_admitido');

    // Igual que la gravedad: un permiso desconocido NO pasa por `concedido`. Mandarle un push
    // a quien lo denego es la clase de error que nadie reporta y todos recuerdan.
    const permission = enumOf(body.permiso, PERMISSIONS, 'concedido');
    if (permission === null) throw new ContractError('permiso_desconocido');

    await this.aftercare.registerDevice(asking, {
      deviceId,
      token,
      platform,
      appVersion: text(body.version_app, 40),
      permission,
    });
    return { registrado: true };
  }

  async forgetDevice(deviceId: string, caller: Caller): Promise<unknown> {
    const asking = this.who(caller, 'historia:leer');
    const forgotten = await this.aftercare.forgetDevice(asking, deviceId);
    // Idempotente: olvidar lo ya olvidado responde lo mismo. Un dispositivo que ya no está es
    // justo lo que se quería.
    void forgotten;
    return { olvidado: true };
  }

  async preferences(caller: Caller): Promise<unknown> {
    const prefs = await this.aftercare.preferences(this.who(caller, 'historia:leer'));
    return prefsView(prefs);
  }

  async savePreferences(input: unknown, caller: Caller): Promise<unknown> {
    const body = asRecord(input);
    const saved = await this.aftercare.savePreferences(this.who(caller, 'historia:leer'), {
      appointments: boolean_(body.recordatorios_de_cita),
      care: boolean_(body.recordatorios_de_cuidados),
      promotions: boolean_(body.promociones),
      quietFrom: text(body.silencio_desde),
      quietTo: text(body.silencio_hasta),
    });
    return prefsView(saved);
  }

  /** Quién pregunta. Para la paciente no hace falta permiso: lo suyo es suyo. */
  private who(caller: Caller, permission: string): AftercareCaller {
    if (caller.accountRole === 'paciente') {
      return { accountId: caller.accountId, practiceId: null, permissions: [], isPatient: true };
    }
    if (caller.practiceId === null || !caller.permissions.includes(permission)) {
      throw new ContractError(
        'sin_permiso',
        undefined,
        'No tienes permiso para esto en la ficha de esta paciente.',
      );
    }
    return {
      accountId: caller.accountId,
      practiceId: caller.practiceId,
      permissions: caller.permissions,
      isPatient: false,
    };
  }

  /** El hilo: para la paciente por su vínculo, para la consulta por la ficha que pide. */
  private async thread(
    caller: Caller,
    source: Record<string, unknown>,
  ): Promise<{ asking: AftercareCaller; patientId: string; practiceId: string }> {
    const asking = this.who(caller, 'pacientes:leer');
    if (asking.isPatient) {
      const practiceId = text(source.practice_id);
      if (practiceId === null) throw new ContractError('vinculo_no_existe');
      const link = await this.aftercare.linkedPatient(caller.accountId, practiceId);
      if (link === null) throw new ContractError('vinculo_no_existe');
      // Los dos estados que no son `vinculada` son DOS respuestas distintas: «todavía no
      // aceptaste» manda a «¿Es esta tu doctora?», y «ese chat está cerrado» no manda a nada.
      if (link === 'revocada') throw new ContractError('vinculo_revocado');
      if (link === 'invitada') throw new ContractError('vinculo_sin_aceptar');
      if (typeof link === 'string') throw new ContractError('vinculo_no_existe');
      return { asking, patientId: link.patientId, practiceId };
    }
    const patientId = text(source.patient_id ?? source.paciente_id);
    if (patientId === null || !UUID.test(patientId)) throw new ContractError('paciente_no_existe');
    return { asking, patientId, practiceId: asking.practiceId! };
  }

  private planView(plan: CarePlanRow) {
    const now = this.clock.now();
    const done = plan.steps.filter((step) => step.doneAt !== null).length;

    return {
      id: plan.id,
      consulta: plan.practiceName,
      tratamiento: plan.treatmentName,
      sesion_en: plan.sessionAt.toISOString(),
      // UN PASO `futuro` VIAJA IGUAL QUE LOS DEMÁS, y es a propósito: la app lo necesita para
      // agendar su aviso local y que el recordatorio funcione SIN CONEXIÓN.
      pasos: plan.steps.map((step) => ({
        id: step.id,
        aparece_en: step.appearsAt.toISOString(),
        texto: step.text,
        estado: stateOf(step, now),
        hecho_en: step.doneAt?.toISOString() ?? null,
      })),
      adherencia: { hechos: done, de: plan.steps.length },
    };
  }
}

/** `futuro` · `pendiente` · `hecho` · `vencido`. El vencido es el que pasó y no se marcó. */
function stateOf(step: { appearsAt: Date; doneAt: Date | null }, now: Date): string {
  if (step.doneAt !== null) return 'hecho';
  if (step.appearsAt > now) return 'futuro';
  // Dos días de margen antes de darlo por vencido: un cuidado del día 7 que se marca el 8 sigue
  // siendo adherencia, y llamarlo vencido castigaría a quien lo cumplió tarde.
  if (now.getTime() - step.appearsAt.getTime() > 2 * 86_400_000) return 'vencido';
  return 'pendiente';
}

function prefsView(prefs: {
  appointments: boolean;
  care: boolean;
  promotions: boolean;
  quietFrom: string | null;
  quietTo: string | null;
}) {
  return {
    recordatorios_de_cita: prefs.appointments,
    recordatorios_de_cuidados: prefs.care,
    promociones: prefs.promotions,
    silencio_desde: prefs.quietFrom,
    silencio_hasta: prefs.quietTo,
  };
}

/**
 * La respuesta de una incidencia, en un solo sitio: la usa la primera llamada y la guarda la
 * clave de idempotencia, para que el reintento devuelva EL MISMO cuerpo.
 */
function incidentView(answer: {
  id: string;
  practitioner: string | null;
  phone: string | null;
  notified: boolean;
}): unknown {
  return {
    id: answer.id,
    estado: 'recibida',
    // `avisamos_a` SOLO SI SE AVISÓ. Y si no —una consulta sin dueña registrada, que es una
    // columna nullable desde el tramo 1—, la frase dice la verdad: queda registrado y lo verá
    // al abrir la app. Prometer un aviso que no salió es el defecto que este endpoint tenía.
    avisamos_a: answer.notified ? answer.practitioner : null,
    que_sigue: answer.notified
      ? 'Tu doctora lo recibió y te va a responder por el chat.'
      : 'Queda registrado en tu consulta. Lo verán al abrir MedSkin.',
    // VIAJA SIEMPRE, incluso con `leve`: «una app no es un servicio de urgencias y no puede
    // comportarse como si lo fuera». La salida al teléfono es obligatoria en esta respuesta.
    si_es_urgente:
      answer.phone === null
        ? 'Si empeora o tienes fiebre, llama a la consulta.'
        : `Si empeora o tienes fiebre, llama a la consulta: ${answer.phone}.`,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Texto del cliente, y con `max` el TOPE QUE LA BASE YA EXIGE (0055). El tope se comprueba aquí
 * y no solo allí porque un `CHECK` roto es un 500: la paciente tiene que leer «es muy largo»,
 * no «algo salió mal». Y se compara después de recortar, que es lo que se guarda.
 */
function text(value: unknown, max?: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (max !== undefined && trimmed.length > max) throw new ContractError('texto_demasiado_largo');
  return trimmed;
}

/**
 * UN VALOR DE UNA LISTA CERRADA, sin valor por omisión escondido: ausente devuelve el valor por
 * omisión declarado, y cualquier otra cosa —otra cadena, un número, un objeto— devuelve `null`,
 * que quien llama convierte en el 400 de su contrato. `String(unknown)` no vale: un objeto se
 * convierte en `[object Object]` y eso no es el valor que mandó nadie.
 */
function enumOf(value: unknown, allowed: readonly string[], fallback: string): string | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') return null;
  return allowed.includes(value) ? value : null;
}

function boolean_(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
