// Los diez endpoints del expediente. Cada uno comprueba su permiso, y uno comprueba el ROL:
// la nota la firma la doctora y nadie más.

import { ContractError } from '../../../shared/contract/error-catalog';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import type { Caller } from '../../access/application/caller';
import type {
  ClinicalCaller,
  ClinicalPort,
  ConsentPort,
  LotPort,
  SessionRow,
} from '../domain/ports';
import {
  readAdverseEvent,
  readConsent,
  readCorrection,
  readLot,
  readSession,
  readVoidReason,
} from '../domain/session';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClockPort {
  now(): Date;
}

export class ClinicalSessions {
  constructor(
    private readonly sessions: ClinicalPort,
    private readonly clock: ClockPort,
  ) {}

  async create(input: unknown, caller: Caller, idempotency: IdempotencyRecord): Promise<unknown> {
    const asking = clinicalOf(caller, 'sesiones:registrar');
    const draft = readSession(input);

    const created = await this.sessions.create(asking, draft, idempotency, view);
    if (created.replay !== null) return created.replay;
    switch (created.outcome) {
      case 'no_appointment':
        throw new ContractError('cita_no_existe');
      case 'not_attended':
        throw new ContractError('cita_sin_atender');
      case 'already_has_session':
        throw new ContractError('cita_ya_tiene_sesion');
      case 'no_lot':
        throw new ContractError('lote_no_existe');
      case 'expired_lot':
        throw new ContractError('lote_vencido');
      case 'no_stock':
        throw new ContractError('stock_insuficiente');
      default:
        return view(created.row!);
    }
  }

  async saveDraft(sessionId: string, input: unknown, caller: Caller): Promise<unknown> {
    const asking = clinicalOf(caller, 'sesiones:registrar');
    checkUuid(sessionId);
    const body = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    const fields = (typeof body.campos === 'object' && body.campos !== null ? body.campos : {}) as Record<string, unknown>;
    const seenAt = typeof body.visto_en === 'string' ? new Date(body.visto_en) : null;

    const saved = await this.sessions.saveDraft(asking, sessionId, {
      incoming: fields,
      seenAt: seenAt !== null && !Number.isNaN(seenAt.getTime()) ? seenAt : null,
      author: asking.accountId,
      now: this.clock.now(),
    });
    if (saved.outcome === 'no_session') throw new ContractError('sesion_clinica_no_existe');
    if (saved.outcome === 'signed') throw new ContractError('nota_ya_firmada');
    if (saved.outcome !== 'saved') throw new ContractError('sesion_anulada');

    // Los dos valores viajan juntos y decide una persona: ni el servidor ni la app eligen.
    return { guardado: saved.saved, en_conflicto: saved.conflicts };
  }

  async sign(sessionId: string, caller: Caller): Promise<unknown> {
    const asking = clinicalOf(caller, 'sesiones:registrar');
    // SOLO LA DOCTORA, nunca el asistente. No es un permiso de la tabla: es el rol.
    if (!asking.isDoctor) throw new ContractError('solo_la_doctora_firma');
    checkUuid(sessionId);

    const signed = await this.sessions.sign(asking, sessionId, this.clock.now());
    switch (signed.outcome) {
      case 'no_session':
        throw new ContractError('sesion_clinica_no_existe');
      case 'voided':
        throw new ContractError('sesion_anulada');
      case 'empty':
        throw new ContractError('nota_vacia');
      case 'conflicts':
        throw new ContractError('conflictos_sin_resolver');
      case 'no_consent':
        throw new ContractError('consentimiento_pendiente');
      case 'stale_consent':
        throw new ContractError('consentimiento_desactualizado');
      case 'no_practitioner':
        throw new ContractError('practicante_no_activo');
      default:
        break;
    }

    const row = signed.row!;
    return {
      estado: 'firmada',
      firmada_en: row.note?.signedAt?.toISOString() ?? null,
      firmo: { nombre: row.note?.signedBy ?? null },
      // Firmar es lo que programa los cuidados, con el protocolo copiado en ese momento.
      cuidados_programados: signed.aftercare,
      semaforo_entregado: true,
    };
  }

  async correct(sessionId: string, input: unknown, caller: Caller): Promise<unknown> {
    const asking = clinicalOf(caller, 'sesiones:registrar');
    if (!asking.isDoctor) throw new ContractError('solo_la_doctora_firma');
    checkUuid(sessionId);

    const added = await this.sessions.correct(asking, sessionId, readCorrection(input));
    if (added.outcome === 'no_session') throw new ContractError('sesion_clinica_no_existe');
    if (added.outcome === 'not_signed') throw new ContractError('nota_sin_firmar');
    return { id: added.id, estado: 'agregada' };
  }

  async adverseEvent(
    sessionId: string,
    input: unknown,
    caller: Caller,
    idempotency: IdempotencyRecord,
  ): Promise<unknown> {
    const asking = clinicalOf(caller, 'sesiones:registrar');
    checkUuid(sessionId);

    const added = await this.sessions.adverseEvent(
      asking,
      sessionId,
      readAdverseEvent(input),
      idempotency,
    );
    if (added.replay !== null) return added.replay;
    if (added.outcome === 'no_session') throw new ContractError('sesion_clinica_no_existe');
    if (added.outcome === 'no_lot') throw new ContractError('lote_no_existe');
    // Un evento grave NO manda ninguna notificación a la paciente: aparece en la ficha y en
    // `DoctorHoy`. Dar una noticia clínica por push es dar la peor noticia por el peor canal.
    return { id: added.id, estado: 'registrado' };
  }

  async voidSession(sessionId: string, input: unknown, caller: Caller): Promise<unknown> {
    const asking = clinicalOf(caller, 'sesiones:registrar');
    if (!asking.isDoctor) {
      throw new ContractError(
        'sin_permiso',
        undefined,
        'Solo la dueña de la consulta puede anular una sesión.',
      );
    }
    checkUuid(sessionId);

    const voided = await this.sessions.voidSession(
      asking,
      sessionId,
      readVoidReason(input),
      this.clock.now(),
    );
    if (voided.outcome === 'no_session') throw new ContractError('sesion_clinica_no_existe');
    if (voided.outcome === 'signed') throw new ContractError('nota_firmada');
    return { estado: 'anulada', motivo_guardado: true };
  }
}

export class Lots {
  constructor(
    private readonly lots: LotPort,
    private readonly clock: ClockPort,
  ) {}

  async list(caller: Caller): Promise<unknown> {
    const asking = clinicalOf(caller, 'inventario:editar');
    const rows = await this.lots.list(asking);
    return { lotes: rows.map(lotView) };
  }

  async create(input: unknown, caller: Caller, idempotency: IdempotencyRecord): Promise<unknown> {
    const asking = clinicalOf(caller, 'inventario:editar');
    const draft = readLot(input, this.clock.now().toISOString().slice(0, 10));

    const created = await this.lots.create(asking, draft, idempotency, lotView);
    if (created.replay !== null) return created.replay;
    if (created.outcome === 'duplicate_code') throw new ContractError('codigo_de_lote_repetido');
    if (created.outcome === 'no_product') throw new ContractError('producto_no_existe');
    return lotView(created.row!);
  }

  /** La consulta de retiro. Pide `historia:leer` porque devuelve nombres y celulares. */
  async patients(lotId: string, caller: Caller): Promise<unknown> {
    const asking = clinicalOf(caller, 'historia:leer');
    if (!UUID.test(lotId)) throw new ContractError('lote_no_existe');

    const found = await this.lots.patients(asking, lotId);
    if (found === null) throw new ContractError('lote_no_existe');

    return {
      lote: lotView(found.lot),
      cuantas: found.patients.length,
      pacientes: found.patients.map((p) => ({
        paciente_id: p.patientId,
        nombre_completo: p.fullName,
        celular: p.phone,
        sesion_en: p.sessionOn,
        unidades: p.units,
      })),
    };
  }
}

export class Consents {
  constructor(private readonly consents: ConsentPort) {}

  async text(treatmentId: string, caller: Caller): Promise<unknown> {
    if (!UUID.test(treatmentId)) throw new ContractError('tratamiento_no_existe');
    const asking = {
      accountId: caller.accountId,
      practiceId: caller.practiceId,
      isPatient: caller.accountRole === 'patient',
    };

    const text = await this.consents.text(asking, treatmentId);
    if (text === null) throw new ContractError('tratamiento_no_existe');

    return {
      tratamiento_id: text.treatmentId,
      version: text.version,
      texto: text.body,
      // `correcta` viaja en NULL siempre, y además la columna que la guarda no la puede leer el
      // rol de la paciente: la promesa está en los dos sitios.
      preguntas: text.questions.map((question) => ({ ...question, correcta: null })),
    };
  }

  async sign(input: unknown, caller: Caller, idempotency: IdempotencyRecord): Promise<unknown> {
    const isPatient = caller.accountRole === 'patient';
    // «La paciente O LA CONSULTA CON ELLA PRESENTE» (`sesiones.md`), y presente significa en la
    // sala: el permiso es `sesiones:registrar`, el mismo que registra el tratamiento. Era el
    // único endpoint de los tramos 2 al 8 sin ninguna comprobación de permiso, así que
    // recepción —cuyo `historia:leer` es «no» por escrito— podía crear el documento que
    // protege a la doctora en una reclamación sin haber estado delante.
    if (!isPatient) clinicalOf(caller, 'sesiones:registrar');
    const asking = {
      accountId: caller.accountId,
      practiceId: caller.practiceId,
      isPatient,
    };
    const draft = readConsent(input);
    if (Object.keys(draft.answers).length < 3) throw new ContractError('respuestas_incompletas');

    const signed = await this.consents.sign(asking, draft, idempotency);
    if (signed.replay !== null) return signed.replay;
    switch (signed.outcome) {
      case 'no_text':
        throw new ContractError('tratamiento_no_existe');
      case 'stale_version':
        throw new ContractError('version_desactualizada');
      case 'wrong_answers':
        // «Vamos a repasar esto juntas»: la app vuelve al párrafo de ESA pregunta.
        throw new ContractError('respuestas_incorrectas', { fallidas: signed.wrong });
      case 'already':
        throw new ContractError('ya_firmado');
      default:
        return { id: signed.id, estado: 'firmado', version: draft.version };
    }
  }
}

function clinicalOf(caller: Caller, permission: string): ClinicalCaller {
  if (caller.practiceId === null || !caller.permissions.includes(permission)) {
    throw new ContractError(
      'sin_permiso',
      undefined,
      'Recepción no puede registrar sesiones.',
    );
  }
  return {
    accountId: caller.accountId,
    practiceId: caller.practiceId,
    permissions: caller.permissions,
    isDoctor: caller.role === 'doctor',
  };
}

function checkUuid(id: string): void {
  if (!UUID.test(id)) throw new ContractError('sesion_clinica_no_existe');
}

function view(row: SessionRow) {
  return {
    id: row.id,
    estado: row.status,
    paciente_id: row.patientId,
    appointment_id: row.appointmentId,
    nota: {
      estado:
        row.note === null
          ? 'sin_escribir'
          : row.note.signedAt !== null
            ? 'firmada'
            : Object.keys(row.note.fields).length === 0
              ? 'sin_escribir'
              : 'borrador',
    },
    consentimiento: {
      requerido: row.consentRequired,
      estado: row.consentSigned ? 'firmado' : 'pendiente',
    },
    stock_descontado: row.stock.map((s) => ({
      lot_id: s.lotId,
      unidades: s.units,
      quedan: s.left,
    })),
    // Los cuidados se programan AL FIRMAR, no al registrar.
    cuidados_programados: false,
  };
}

function lotView(row: {
  id: string;
  productId: string;
  productName: string;
  code: string;
  expiresOn: string;
  units: number;
  unitsLeft: number;
  costCents: number | null;
}) {
  return {
    id: row.id,
    product_id: row.productId,
    producto: row.productName,
    codigo: row.code,
    vence_en: row.expiresOn,
    unidades: row.units,
    unidades_restantes: row.unitsLeft,
    costo_total: row.costCents === null ? null : { centavos: row.costCents },
  };
}
