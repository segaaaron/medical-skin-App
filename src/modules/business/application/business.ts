// Los once endpoints del negocio. Los márgenes y los informes son SOLO de la dueña: «es el
// número que dice cuánto gana la consulta».

import { ContractError } from '../../../shared/contract/error-catalog';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import type { Caller } from '../../access/application/caller';
import { REPORTS, readMovement, readPayment } from '../domain/business';
import type { BusinessCaller, BusinessPort, MarginRow, PaymentRow } from '../domain/ports';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** El presupuesto de disco por ficha, de `servicios.md`: 120 fotos × ~1,6 MB. */
const BYTES_PER_PATIENT = 120 * 1_600_000;

export class Business {
  constructor(private readonly business: BusinessPort) {}

  async charge(input: unknown, caller: Caller, idempotency: IdempotencyRecord): Promise<unknown> {
    // El asistente clínico NO registra cobros, y es del contrato: `cobros:registrar` lo tienen
    // la doctora y recepción.
    const asking = this.who(caller, 'cobros:registrar', 'El asistente clínico no registra cobros.');
    const draft = readPayment(input);

    const charged = await this.business.charge(asking, draft, idempotency);
    if (charged.replay !== null) return charged.replay;
    if (charged.outcome === 'no_session') throw new ContractError('sesion_clinica_no_existe');
    if (charged.outcome === 'already') throw new ContractError('ya_cobrado');
    if (charged.outcome === 'no_credit') {
      throw new ContractError('credito_insuficiente', { disponible: { centavos: charged.credit } });
    }
    return paymentView(charged.row!, false);
  }

  async payments(query: Record<string, unknown>, caller: Caller): Promise<unknown> {
    const asking = this.reader(caller, 'cobros:registrar');
    const rows = await this.business.payments(asking, {
      patientId: asking.isPatient ? null : text(query.patient_id ?? query.paciente_id),
      from: text(query.desde),
      to: text(query.hasta),
    });
    return { cobros: rows.map((row) => paymentView(row, asking.isPatient)) };
  }

  async voidPayment(paymentId: string, input: unknown, caller: Caller): Promise<unknown> {
    const asking = this.who(caller, 'cobros:registrar', 'El asistente clínico no registra cobros.');
    if (!UUID.test(paymentId)) throw new ContractError('cobro_no_existe');

    const reason = text(asRecord(input).motivo);
    if (reason === null) throw new ContractError('merma_sin_motivo');

    const voided = await this.business.voidPayment(asking, paymentId, reason);
    if (voided.outcome === 'no_payment') throw new ContractError('cobro_no_existe');
    // La anulación es OTRA FILA: las dos quedan. Es contabilidad.
    return { anulacion_id: voided.id, estado: 'anulado' };
  }

  async margins(query: Record<string, unknown>, caller: Caller): Promise<unknown> {
    const asking = this.who(
      caller,
      'margenes:leer',
      'Solo la dueña de la consulta puede ver los márgenes.',
    );

    const { rows, withoutCost, currency } = await this.business.margins(asking, {
      from: text(query.desde),
      to: text(query.hasta),
    });

    return {
      moneda: currency,
      periodo: { desde: text(query.desde), hasta: text(query.hasta) },
      filas: rows.map((row) => marginView(row, currency)),
      // EXISTE PARA NO MENTIR: las sesiones de un lote sin costo registrado NO entran en el
      // margen y se cuentan aparte. «Asumir costo cero daría un margen del 100 % y una decisión
      // de negocio tomada sobre un número inventado.»
      sin_costo_conocido:
        withoutCost === 0
          ? null
          : { sesiones: withoutCost, por_que: 'lotes sin costo registrado' },
    };
  }

  async inventory(caller: Caller): Promise<unknown> {
    const asking = this.who(caller, 'inventario:editar', 'No tienes permiso para el inventario.');
    const products = await this.business.inventory(asking);
    return {
      productos: products.map((product) => ({
        id: product.productId,
        nombre: product.name,
        unidades: product.unitsLeft,
        lotes: product.lots.map((lot) => ({
          id: lot.id,
          codigo: lot.code,
          vence_en: lot.expiresOn,
          unidades: lot.unitsLeft,
        })),
      })),
    };
  }

  async addProduct(input: unknown, caller: Caller, idempotency: IdempotencyRecord): Promise<unknown> {
    const asking = this.who(caller, 'inventario:editar', 'No tienes permiso para el inventario.');
    const body = asRecord(input);
    const name = text(body.nombre);
    if (name === null) throw new ContractError('nombre_vacio');

    const added = await this.business.addProduct(
      asking,
      { name, unit: text(body.unidad) ?? 'unidad' },
      idempotency,
    );
    if (added.replay !== null) return added.replay;
    return { id: added.id, nombre: name };
  }

  async move(input: unknown, caller: Caller, idempotency: IdempotencyRecord): Promise<unknown> {
    const asking = this.who(caller, 'inventario:editar', 'No tienes permiso para el inventario.');
    const draft = readMovement(input);

    const moved = await this.business.move(asking, draft, idempotency);
    if (moved.replay !== null) return moved.replay;
    if (moved.outcome === 'no_lot') throw new ContractError('lote_no_existe');
    // «Un inventario negativo no es un dato, es un error que se arrastra.»
    if (moved.outcome === 'negative') {
      throw new ContractError('stock_negativo', { quedan: moved.left });
    }
    return { quedan: moved.left };
  }

  async report(query: Record<string, unknown>, caller: Caller): Promise<unknown> {
    const asking = this.who(
      caller,
      'informes:leer',
      'Solo la dueña de la consulta puede ver los informes.',
    );
    const kind = REPORTS.find((known) => known === query.informe) ?? 'ingresos';

    const report = await this.business.report(asking, {
      kind,
      from: text(query.desde),
      to: text(query.hasta),
    });
    // Menos de cinco pacientes y el agregado no se devuelve: con dos filas, un «promedio»
    // identifica a las dos.
    if (report.suppressed) return { informe: kind, suprimido: true, por_que: 'menos_de_cinco' };
    return { informe: kind, filas: report.rows };
  }

  async plan(caller: Caller): Promise<unknown> {
    const asking = this.who(caller, 'equipo:crear', 'Solo la dueña de la consulta ve su plan.');
    const plan = await this.business.plan(asking);
    if (plan === null) throw new ContractError('inquilino_no_existe');

    const limitBytes = plan.patientLimit * BYTES_PER_PATIENT;
    return {
      plan: plan.plan,
      limite_pacientes: plan.patientLimit,
      pacientes: plan.patients,
      almacenamiento_usado: plan.photoBytes,
      almacenamiento_limite: limitBytes,
      renueva_en: plan.renewsOn,
      // El aviso llega al 80 %, no al 100 %: «Te quedan 60 pacientes de tu plan».
      aviso:
        plan.patients >= plan.patientLimit * 0.8
          ? `Te quedan ${Math.max(0, plan.patientLimit - plan.patients)} pacientes de tu plan.`
          : null,
    };
  }

  async requestPlan(input: unknown, caller: Caller): Promise<unknown> {
    const asking = this.who(caller, 'equipo:crear', 'Solo la dueña de la consulta amplía el plan.');
    const body = asRecord(input);
    const wanted = text(body.plan);
    if (wanted === null) throw new ContractError('nombre_vacio');

    // NO COBRA: crea una solicitud y avisa a la plataforma, que lo resuelve desde la consola.
    const id = await this.business.requestPlan(asking, wanted, text(body.nota));
    return {
      id,
      estado: 'pedida',
      que_sigue: 'MedSkin lo revisa y te confirma. No se te cobró nada.',
    };
  }

  async requestExport(caller: Caller): Promise<unknown> {
    const asking = this.reader(caller, 'informes:leer');
    const asked = await this.business.requestExport(asking);
    if (asked.outcome === 'too_soon') throw new ContractError('exportacion_reciente');

    return {
      id: asked.id,
      estado: 'pedida',
      como_llega: 'Te llega por correo, con un enlace de 24 horas y un solo uso.',
      // LA DECISIÓN INCÓMODA, DICHA SIN ESCONDERLA.
      no_incluye:
        'Tu historia clínica completa, con las notas de tu doctora, la pides directamente a tu consulta: ellos tienen que dártela.',
    };
  }

  async exportStatus(exportId: string, caller: Caller): Promise<unknown> {
    const asking = this.reader(caller, 'informes:leer');
    if (!UUID.test(exportId)) throw new ContractError('exportacion_vencida');

    const status = await this.business.exportStatus(asking, exportId);
    if (status === null) throw new ContractError('exportacion_vencida');
    if (status.expiresAt !== null && status.expiresAt < new Date()) {
      throw new ContractError('exportacion_vencida');
    }
    return { estado: status.status, caduca_en: status.expiresAt?.toISOString() ?? null };
  }

  /** Quien escribe o mira dinero: siempre la consulta, nunca la paciente. */
  private who(caller: Caller, permission: string, message: string): BusinessCaller {
    if (
      caller.accountRole === 'paciente' ||
      caller.practiceId === null ||
      !caller.permissions.includes(permission)
    ) {
      throw new ContractError('sin_permiso', undefined, message);
    }
    return {
      accountId: caller.accountId,
      practiceId: caller.practiceId,
      permissions: caller.permissions,
      isPatient: false,
      isDoctor: caller.role === 'doctora',
    };
  }

  /** Lecturas que la paciente SÍ hace: sus cobros y su exportación. */
  private reader(caller: Caller, permission: string): BusinessCaller {
    if (caller.accountRole === 'paciente') {
      return {
        accountId: caller.accountId,
        practiceId: null,
        permissions: [],
        isPatient: true,
        isDoctor: false,
      };
    }
    return this.who(caller, permission, 'No tienes permiso para esto.');
  }
}

function paymentView(row: PaymentRow, forPatient: boolean) {
  return {
    id: row.id,
    concepto: row.concept,
    importe: { centavos: row.cents },
    cobrado_en: row.chargedAt.toISOString(),
    anulado: row.voidedAt !== null,
    // La paciente ve «solo el importe, el concepto y la fecha»: ni la referencia bancaria de la
    // consulta, ni el medio con el que la doctora lo registró.
    ...(forPatient
      ? {}
      : {
          medio: row.method,
          referencia: row.reference,
          credito_usado: { centavos: row.creditUsedCents },
          session_id: row.sessionId,
          patient_id: row.patientId,
        }),
  };
}

function marginView(row: MarginRow, currency: string) {
  return {
    tratamiento: row.treatment,
    sesiones: row.sessions,
    cobrado: { centavos: row.chargedCents, moneda: currency },
    costo_producto: { centavos: row.costCents, moneda: currency },
    margen: { centavos: row.marginCents, moneda: currency },
    margen_porcentaje: row.marginPercent,
    unidades_consumidas: row.units,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
