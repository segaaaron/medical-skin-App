// Los seis casos de uso del catálogo de la doctora. Cada uno comprueba SU permiso: el del
// catálogo (`catalogo:editar`), el de precios (`precios:editar`) y el de promociones
// (`promociones:editar`) son tres, y el contrato los separa porque una asistente puede ver el
// catálogo y no tocar el dinero.

import { ContractError } from '../../../shared/contract/error-catalog';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import type { Caller } from '../../access/application/caller';
import type {
  CatalogPort,
  CatalogWriter,
  PromotionRow,
  TreatmentRow,
} from '../domain/ports';
import {
  money,
  readContraindications,
  readPrices,
  readPromotion,
  readProtocol,
  readTreatment,
  readTreatmentEdit,
} from '../domain/treatment';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClockPort {
  now(): Date;
}

export class Catalog {
  constructor(
    private readonly catalog: CatalogPort,
    private readonly clock: ClockPort,
  ) {}

  async list(caller: Caller, query: Record<string, unknown>): Promise<unknown> {
    const asking = writerOf(caller, 'catalogo:leer');
    const rows = await this.catalog.list(asking, query.estado === 'todos');
    return { tratamientos: rows.map(treatmentView) };
  }

  async create(input: unknown, caller: Caller, key: IdempotencyRecord): Promise<unknown> {
    const asking = writerOf(caller, 'catalogo:editar');
    const draft = readTreatment(input);

    const result = await this.catalog.create(asking, draft, key, treatmentView);
    if (result.replay !== null) return result.replay;
    if (result.outcome === 'duplicate_name') throw new ContractError('nombre_repetido');
    if (result.outcome === 'no_product') throw new ContractError('producto_no_existe');
    return treatmentView(result.row!);
  }

  async edit(treatmentId: string, input: unknown, caller: Caller): Promise<unknown> {
    const asking = writerOf(caller, 'catalogo:editar');
    this.checkUuid(treatmentId);
    const edit = readTreatmentEdit(input);

    const result = await this.catalog.edit(asking, treatmentId, edit);
    if (result.outcome === 'no_treatment') throw new ContractError('tratamiento_no_existe');
    if (result.outcome === 'duplicate_name') throw new ContractError('nombre_repetido');
    if (result.outcome === 'no_product') throw new ContractError('producto_no_existe');
    if (result.outcome === 'needs_interval') throw new ContractError('intervalo_necesario');
    return treatmentView(result.row!);
  }

  /** Archivar y reactivar: un tratamiento no se borra porque las sesiones lo nombran. */
  async archive(treatmentId: string, caller: Caller, archived: boolean): Promise<unknown> {
    const asking = writerOf(caller, 'catalogo:editar');
    this.checkUuid(treatmentId);
    const result = await this.catalog.archive(asking, treatmentId, archived);
    if (result.outcome === 'no_treatment') throw new ContractError('tratamiento_no_existe');
    // Reactivar es la operación que viola el índice único parcial del nombre: el mismo `409`
    // que daría crear uno con ese nombre, porque es el mismo choque.
    if (result.outcome === 'duplicate_name') throw new ContractError('nombre_repetido');
    return treatmentView(result.row!);
  }

  async protocol(treatmentId: string, caller: Caller): Promise<unknown> {
    const asking = writerOf(caller, 'catalogo:leer');
    this.checkUuid(treatmentId);
    const protocol = await this.catalog.protocol(asking, treatmentId);
    if (protocol === null) throw new ContractError('tratamiento_no_existe');
    return protocolView(protocol);
  }

  async saveProtocol(treatmentId: string, input: unknown, caller: Caller): Promise<unknown> {
    const asking = writerOf(caller, 'catalogo:editar');
    this.checkUuid(treatmentId);
    const saved = await this.catalog.saveProtocol(asking, treatmentId, readProtocol(input));
    if (saved === null) throw new ContractError('tratamiento_no_existe');
    return protocolView(saved);
  }

  async contraindications(treatmentId: string, caller: Caller): Promise<unknown> {
    const asking = writerOf(caller, 'catalogo:leer');
    this.checkUuid(treatmentId);
    const list = await this.catalog.contraindications(asking, treatmentId);
    if (list === null) throw new ContractError('tratamiento_no_existe');
    return { contraindicaciones: list.map(contraindicationView) };
  }

  async saveContraindications(
    treatmentId: string,
    input: unknown,
    caller: Caller,
  ): Promise<unknown> {
    const asking = writerOf(caller, 'catalogo:editar');
    this.checkUuid(treatmentId);
    const saved = await this.catalog.saveContraindications(
      asking,
      treatmentId,
      readContraindications(input),
    );
    if (saved === null) throw new ContractError('tratamiento_no_existe');
    return { contraindicaciones: saved.map(contraindicationView) };
  }

  async prices(caller: Caller): Promise<unknown> {
    const asking = writerOf(caller, 'precios:editar');
    const { rows, currency } = await this.catalog.prices(asking);
    return { precios: rows.map((r) => priceView(r, currency)) };
  }

  async savePrices(input: unknown, caller: Caller): Promise<unknown> {
    const asking = writerOf(caller, 'precios:editar');
    const result = await this.catalog.savePrices(asking, readPrices(input));
    if (result.outcome === 'no_treatment') throw new ContractError('tratamiento_no_existe');
    return { precios: result.rows.map((r) => priceView(r, result.currency)) };
  }

  async promotions(caller: Caller): Promise<unknown> {
    const asking = writerOf(caller, 'promociones:editar');
    const rows = await this.catalog.promotions(asking);
    return { promociones: rows.map(promotionView) };
  }

  async createPromotion(input: unknown, caller: Caller, key: IdempotencyRecord): Promise<unknown> {
    const asking = writerOf(caller, 'promociones:editar');
    const today = this.clock.now().toISOString().slice(0, 10);

    const result = await this.catalog.createPromotion(
      asking,
      readPromotion(input, today),
      key,
      promotionView,
    );
    if (result.replay !== null) return result.replay;
    if (result.outcome === 'duplicate_code') throw new ContractError('codigo_repetido');
    if (result.outcome === 'no_treatment') throw new ContractError('tratamiento_no_existe');
    return promotionView(result.row!);
  }

  /**
   * El `PATCH` de una promoción solo despublica y mueve el cupo. Cambiar el descuento o la
   * vigencia de una promoción viva es otra promoción: ya hay canjes que la referencian y «un
   * informe de noviembre tiene que poder decir cuánto costó la campaña».
   */
  async editPromotion(promotionId: string, input: unknown, caller: Caller): Promise<unknown> {
    const asking = writerOf(caller, 'promociones:editar');
    this.checkUuid(promotionId, 'promocion_no_existe');

    const body = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    const edit: { published?: boolean; quota?: number | null } = {};
    if (body.publicada !== undefined) edit.published = body.publicada === true;
    if (body.cupo !== undefined) {
      edit.quota = body.cupo === null ? null : Number(body.cupo);
      if (edit.quota !== null && (!Number.isInteger(edit.quota) || edit.quota < 1)) {
        throw new ContractError('descuento_fuera_de_rango');
      }
    }

    const row = await this.catalog.editPromotion(asking, promotionId, edit);
    if (row === null) throw new ContractError('promocion_no_existe');
    return promotionView(row);
  }

  private checkUuid(id: string, code: 'tratamiento_no_existe' | 'promocion_no_existe' = 'tratamiento_no_existe'): void {
    // Un identificador que no es un uuid no tiene fila: la misma respuesta que uno inventado,
    // y sin consultar nada. Con otra forma la base muere con «invalid input syntax for uuid».
    if (!UUID.test(id)) throw new ContractError(code);
  }
}

/**
 * Quién escribe, con su inquilino y su permiso. Una paciente no tiene catálogo que editar y
 * recibe el mismo `403` que una recepcionista: no se distingue.
 */
function writerOf(caller: Caller, permission: string): CatalogWriter {
  if (caller.practiceId === null || !caller.permissions.includes(permission)) {
    throw new ContractError(
      'sin_permiso',
      undefined,
      'Solo la dueña de la consulta puede editar el catálogo.',
    );
  }
  return {
    accountId: caller.accountId,
    practiceId: caller.practiceId,
    permissions: caller.permissions,
  };
}

function treatmentView(row: TreatmentRow) {
  return {
    id: row.id,
    nombre: row.name,
    categoria: row.category,
    descripcion: row.description,
    duracion_minutos: row.durationMinutes,
    sesiones_previstas: row.plannedSessions,
    intervalo_minimo_dias: row.minIntervalDays,
    precio: money(row.cents, row.currency),
    requiere_consentimiento: row.requiresConsent,
    visible_para_pacientes: row.visibleToPatients,
    estado: row.status,
    // Lo que decide si se puede archivar sin perder historia.
    veces_aplicado: row.appliedCount,
    insumos: row.supplies.map((s) => ({ producto_id: s.productId, unidades: s.units })),
    creado_en: row.createdAt.toISOString(),
    actualizado_en: row.updatedAt.toISOString(),
  };
}

function protocolView(protocol: {
  steps: readonly { moment: string; offsetHours: number; text: string }[];
  trafficLight: readonly { day: number; normal: string; callIf: string }[];
}) {
  return {
    pasos: protocol.steps.map((s) => ({
      momento: s.moment,
      desfase_horas: s.offsetHours,
      texto: s.text,
    })),
    semaforo: protocol.trafficLight.map((l) => ({
      dia: l.day,
      normal: l.normal,
      llamar_si: l.callIf,
    })),
  };
}

function contraindicationView(item: { key: string; value: string | null; absolute: boolean }) {
  return { clave: item.key, valor: item.value, absoluta: item.absolute };
}

function priceView(row: { treatmentId: string; zone: string | null; cents: number }, currency: string) {
  return {
    tratamiento_id: row.treatmentId,
    zona: row.zone,
    ...money(row.cents, currency),
  };
}

function promotionView(row: PromotionRow) {
  return {
    id: row.id,
    nombre: row.name,
    tratamientos: row.treatmentIds,
    descuento: { tipo: row.discountType, valor: row.discountValue },
    vigencia: { desde: row.startsOn, hasta: row.endsOn },
    cupo: row.quota,
    canjeadas: row.redeemed,
    codigo: row.code,
    segmento: { clave: row.segmentKey, valor: row.segmentValue },
    acumulable: row.stackable,
    publicada: row.published,
  };
}
