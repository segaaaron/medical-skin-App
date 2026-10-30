// El catálogo de la doctora, con `app_practitioner` y `withTenantContext()`. Ninguna consulta
// lleva `where practice_id`: lo acota la política de cada tabla sobre esa columna.
//
// LA MONEDA SALE DE `practice.currency` Y NO DEL CLIENTE, y por eso cada lectura la trae: es el
// único sitio donde vive.

import type { Pool, PoolClient } from 'pg';

import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import { claim, complete, release } from '../../../shared/idempotency/idempotency-rows';
import type {
  CatalogPort,
  CatalogWriter,
  PromotionRow,
  TreatmentRow,
} from '../domain/ports';
import type {
  Contraindication,
  PriceRow,
  ProtocolStep,
  PromotionDraft,
  TrafficLight,
  TreatmentDraft,
} from '../domain/treatment';

function contextOf(caller: CatalogWriter): TenantContext {
  return { role: 'app_practitioner', practiceId: caller.practiceId, accountId: caller.accountId };
}

/** Las columnas que el `PATCH` puede tocar, y ni una más. */
const COLUMNS: Readonly<Record<string, string>> = {
  name: 'name',
  category: 'category',
  description: 'description',
  durationMinutes: 'duration_minutes',
  plannedSessions: 'planned_sessions',
  minIntervalDays: 'min_interval_days',
  requiresConsent: 'requires_consent',
  visibleToPatients: 'visible_to_patients',
};

const TREATMENT_SELECT = `
  select t.id, t.name, t.category, t.description, t.duration_minutes, t.planned_sessions,
         t.min_interval_days, t.requires_consent, t.visible_to_patients, t.status,
         t.applied_count, t.created_at, t.updated_at,
         (select cents from price p where p.treatment_id = t.id and p.zone is null) as base_cents,
         (select currency from practice) as currency
    from treatment t`;

export class CatalogRepository implements CatalogPort {
  constructor(private readonly pool: Pool) {}

  async list(caller: CatalogWriter, includeArchived: boolean): Promise<readonly TreatmentRow[]> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query<Record<string, unknown>>(
        `${TREATMENT_SELECT}
          where ($1::boolean or t.status = 'activo')
          order by t.created_at desc nulls first, t.id`,
        [includeArchived],
      );
      return rows.map(mapTreatment);
    });
  }

  async create(
    caller: CatalogWriter,
    draft: TreatmentDraft,
    idempotency: IdempotencyRecord,
    render: (row: TreatmentRow) => unknown,
  ): Promise<{ outcome: 'created' | 'duplicate_name' | 'no_product'; row: TreatmentRow | null; replay: unknown }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // La reserva ANTES de escribir nada, como los otros cinco `POST` que crean algo: lo que
      // serializa es la clave primaria `(account_id, key)`.
      const replay = await claim<unknown>(c, {
        record: idempotency,
        accountId: caller.accountId,
        practiceId: caller.practiceId,
        unfinished: 'No pudimos guardar el tratamiento, y puede que sí se haya guardado.',
      });
      if (replay !== null) return { outcome: 'created', row: null, replay: replay.response };

      // Los insumos apuntan a `product` de ESTA consulta: la política lo garantiza, así que un
      // identificador de otra no devuelve fila y eso es el 404 del contrato.
      for (const supply of draft.supplies) {
        const { rows } = await c.query(`select 1 from product where id = $1`, [supply.productId]);
        if (rows.length === 0) {
          await release(c, { record: idempotency, accountId: caller.accountId });
          return { outcome: 'no_product', row: null, replay: null };
        }
      }

      let id: string;
      // UN `SAVEPOINT`, Y NO ES UN ADORNO: en Postgres una violación de restricción aborta la
      // TRANSACCIÓN ENTERA, no la sentencia. Sin esto, el `release()` del `catch` muere con
      // «current transaction is aborted» y lo que recibe quien llama es un 500 donde el
      // contrato promete un 409. Medido el 28 de octubre con su prueba.
      await c.query('savepoint before_insert');
      try {
        const { rows } = await c.query<{ id: string }>(
          `insert into treatment (practice_id, name, category, description, duration_minutes,
                                  planned_sessions, min_interval_days, requires_consent,
                                  visible_to_patients)
           values (medskin_current_practice(), $1, $2, $3, $4, $5, $6, $7, $8)
           returning id`,
          [
            draft.name,
            draft.category,
            draft.description,
            draft.durationMinutes,
            draft.plannedSessions,
            draft.minIntervalDays,
            draft.requiresConsent,
            draft.visibleToPatients,
          ],
        );
        id = rows[0]!.id;
        await c.query('release savepoint before_insert');
      } catch (failure) {
        // `23505` es el índice único parcial del nombre entre los activos: el `409` lo decide
        // la base, no una lectura previa que otra transacción podría invalidar.
        if (isUnique(failure)) {
          await c.query('rollback to savepoint before_insert');
          await release(c, { record: idempotency, accountId: caller.accountId });
          return { outcome: 'duplicate_name', row: null, replay: null };
        }
        throw failure;
      }

      // El precio base nace con el tratamiento: «un tratamiento sin precio base no se ofrece».
      await c.query(
        `insert into price (practice_id, treatment_id, zone, cents)
         values (medskin_current_practice(), $1, null, $2)`,
        [id, draft.cents],
      );
      await this.replaceSupplies(c, id, draft.supplies);

      const row = await this.readOne(c, id);
      if (row === null) throw new Error(`el tratamiento ${id} no se pudo releer tras crearlo`);

      // LO QUE SE GUARDA ES LO QUE EL CLIENTE RECIBIO, no la fila interna: un reintento tiene
      // que devolver el MISMO cuerpo, y la fila lleva nombres en ingles que el contrato no
      // tiene. `render` es la misma vista que usa la respuesta de la primera llamada.
      await complete(c, {
        record: idempotency,
        accountId: caller.accountId,
        status: 201,
        response: render(row),
      });
      return { outcome: 'created', row, replay: null };
    });
  }

  async edit(
    caller: CatalogWriter,
    treatmentId: string,
    edit: Partial<TreatmentDraft>,
  ): Promise<{
    outcome: 'edited' | 'no_treatment' | 'duplicate_name' | 'no_product' | 'needs_interval';
    row: TreatmentRow | null;
  }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows: found } = await c.query(`select 1 from treatment where id = $1 for update`, [
        treatmentId,
      ]);
      if (found.length === 0) return { outcome: 'no_treatment', row: null };

      const fields = Object.keys(edit).filter((f) => f in COLUMNS);
      if (fields.length > 0) {
        const sets = fields.map((f, i) => `${COLUMNS[f]} = $${i + 2}`);
        const values = fields.map((f) => (edit as Record<string, unknown>)[f]);
        await c.query('savepoint before_update');
        try {
          await c.query(
            `update treatment set ${sets.join(', ')}, updated_at = now() where id = $1`,
            [treatmentId, ...values],
          );
          await c.query('release savepoint before_update');
        } catch (failure) {
          if (isUnique(failure)) {
            // Lo mismo que en el alta: sin volver al punto, la transacción queda abortada y
            // la relectura de abajo moriría en vez de devolver el 409.
            await c.query('rollback to savepoint before_update');
            return { outcome: 'duplicate_name', row: null };
          }
          // La REGLA CLÍNICA la sostiene `treatment_interval_ck`, y el `PATCH` puede violarla
          // de dos maneras: quitando el intervalo o subiendo las sesiones previstas. El alta
          // la comprueba en el dominio y da `intervalo_necesario`; aquí se traduce la
          // restricción, que es la que ve el valor FINAL de la fila tras mezclar los campos
          // —el dominio solo ve los que vinieron en el cuerpo—.
          if (isCheck(failure, 'treatment_interval_ck')) {
            await c.query('rollback to savepoint before_update');
            return { outcome: 'needs_interval', row: null };
          }
          throw failure;
        }
      }

      // «Cambiar el precio no reescribe la historia»: esto mueve el precio base de HOY en
      // adelante, y las citas ya agendadas conservan el que se les copió al agendar.
      if (edit.cents !== undefined) {
        await c.query(
          `insert into price (practice_id, treatment_id, zone, cents)
           values (medskin_current_practice(), $1, null, $2)
           on conflict (practice_id, treatment_id) where zone is null
           do update set cents = excluded.cents, updated_at = now()`,
          [treatmentId, edit.cents],
        );
      }
      if (edit.supplies !== undefined) {
        for (const supply of edit.supplies) {
          const { rows } = await c.query(`select 1 from product where id = $1`, [supply.productId]);
          if (rows.length === 0) return { outcome: 'no_product', row: null };
        }
        await this.replaceSupplies(c, treatmentId, edit.supplies);
      }

      return { outcome: 'edited', row: await this.readOne(c, treatmentId) };
    });
  }

  async archive(
    caller: CatalogWriter,
    treatmentId: string,
    archived: boolean,
  ): Promise<{ outcome: 'done' | 'no_treatment' | 'duplicate_name'; row: TreatmentRow | null }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      // Un tratamiento NO se borra: se archiva. `session_note` y `appointment` lo referencian.
      //
      // Y el `savepoint` por la misma razón que en el alta: `treatment_practice_name_uq` es
      // PARCIAL —`WHERE status = 'activo'`—, así que la operación que lo viola es REACTIVAR
      // uno cuyo nombre ya volvió a usar otro activo. Sin volver al punto, la transacción
      // queda abortada y la relectura de abajo moriría con un 500 donde el resto del módulo
      // da `409 nombre_repetido`.
      let found: boolean;
      await c.query('savepoint before_status');
      try {
        const { rows } = await c.query<{ id: string }>(
          `update treatment set status = $2, updated_at = now() where id = $1 returning id`,
          [treatmentId, archived ? 'archivado' : 'activo'],
        );
        found = rows.length > 0;
        await c.query('release savepoint before_status');
      } catch (failure) {
        if (isUnique(failure)) {
          await c.query('rollback to savepoint before_status');
          return { outcome: 'duplicate_name' as const, row: null };
        }
        throw failure;
      }
      if (!found) return { outcome: 'no_treatment' as const, row: null };
      return { outcome: 'done' as const, row: await this.readOne(c, treatmentId) };
    });
  }

  async protocol(
    caller: CatalogWriter,
    treatmentId: string,
  ): Promise<{ steps: readonly ProtocolStep[]; trafficLight: readonly TrafficLight[] } | null> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => this.readProtocol(c, treatmentId));
  }

  async saveProtocol(
    caller: CatalogWriter,
    treatmentId: string,
    protocol: { steps: readonly ProtocolStep[]; trafficLight: readonly TrafficLight[] },
  ): Promise<{ steps: readonly ProtocolStep[]; trafficLight: readonly TrafficLight[] } | null> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query(`select 1 from treatment where id = $1 for update`, [
        treatmentId,
      ]);
      if (rows.length === 0) return null;

      // Reemplazo entero y no mezcla: el `PUT` es la lista completa, y es idempotente —el
      // mismo cuerpo dos veces deja lo mismo—. «Cambiar el protocolo no cambia los planes de
      // cuidado ya generados»: esos se copian al registrar la sesión, en el tramo 5.
      await c.query(`delete from treatment_protocol_step where treatment_id = $1`, [treatmentId]);
      for (const step of protocol.steps) {
        await c.query(
          `insert into treatment_protocol_step (practice_id, treatment_id, moment, offset_hours,
                                                text)
           values (medskin_current_practice(), $1, $2, $3, $4)`,
          [treatmentId, step.moment, step.offsetHours, step.text],
        );
      }
      await c.query(`delete from treatment_traffic_light where treatment_id = $1`, [treatmentId]);
      for (const light of protocol.trafficLight) {
        await c.query(
          `insert into treatment_traffic_light (practice_id, treatment_id, day, normal, call_if)
           values (medskin_current_practice(), $1, $2, $3, $4)`,
          [treatmentId, light.day, light.normal, light.callIf],
        );
      }
      return this.readProtocol(c, treatmentId);
    });
  }

  async contraindications(
    caller: CatalogWriter,
    treatmentId: string,
  ): Promise<readonly Contraindication[] | null> {
    return withTenantContext(this.pool, contextOf(caller), async (c) =>
      this.readContraindications(c, treatmentId),
    );
  }

  async saveContraindications(
    caller: CatalogWriter,
    treatmentId: string,
    list: readonly Contraindication[],
  ): Promise<readonly Contraindication[] | null> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query(`select 1 from treatment where id = $1 for update`, [
        treatmentId,
      ]);
      if (rows.length === 0) return null;

      await c.query(`delete from treatment_contraindication where treatment_id = $1`, [treatmentId]);
      for (const item of list) {
        await c.query(
          `insert into treatment_contraindication (practice_id, treatment_id, key, value, absolute)
           values (medskin_current_practice(), $1, $2, $3, $4)`,
          [treatmentId, item.key, item.value, item.absolute],
        );
      }
      return this.readContraindications(c, treatmentId);
    });
  }

  async prices(caller: CatalogWriter): Promise<{ rows: readonly PriceRow[]; currency: string }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query<{ treatment_id: string; zone: string | null; cents: number }>(
        `select treatment_id, zone, cents from price order by treatment_id, zone nulls first`,
      );
      return {
        rows: rows.map((r) => ({ treatmentId: r.treatment_id, zone: r.zone, cents: r.cents })),
        currency: await this.currency(c),
      };
    });
  }

  async savePrices(
    caller: CatalogWriter,
    rows: readonly PriceRow[],
  ): Promise<{ outcome: 'saved' | 'no_treatment'; rows: readonly PriceRow[]; currency: string }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      for (const row of rows) {
        const { rows: found } = await c.query(`select 1 from treatment where id = $1`, [
          row.treatmentId,
        ]);
        if (found.length === 0) {
          return { outcome: 'no_treatment', rows: [], currency: '' };
        }
      }

      for (const row of rows) {
        // Dos índices únicos parciales —base y zona— y por eso dos `on conflict` distintos.
        if (row.zone === null) {
          await c.query(
            `insert into price (practice_id, treatment_id, zone, cents)
             values (medskin_current_practice(), $1, null, $2)
             on conflict (practice_id, treatment_id) where zone is null
             do update set cents = excluded.cents, updated_at = now()`,
            [row.treatmentId, row.cents],
          );
        } else {
          await c.query(
            `insert into price (practice_id, treatment_id, zone, cents)
             values (medskin_current_practice(), $1, $2, $3)
             on conflict (practice_id, treatment_id, zone) where zone is not null
             do update set cents = excluded.cents, updated_at = now()`,
            [row.treatmentId, row.zone, row.cents],
          );
        }
      }

      const { rows: saved } = await c.query<{ treatment_id: string; zone: string | null; cents: number }>(
        `select treatment_id, zone, cents from price order by treatment_id, zone nulls first`,
      );
      return {
        outcome: 'saved',
        rows: saved.map((r) => ({ treatmentId: r.treatment_id, zone: r.zone, cents: r.cents })),
        currency: await this.currency(c),
      };
    });
  }

  async promotions(caller: CatalogWriter): Promise<readonly PromotionRow[]> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const { rows } = await c.query<Record<string, unknown>>(
        `select p.*, (select currency from practice) as currency,
                to_char(p.starts_on, 'YYYY-MM-DD') as starts_on_text,
                to_char(p.ends_on, 'YYYY-MM-DD') as ends_on_text,
                coalesce((select array_agg(pt.treatment_id::text)
                            from promotion_treatment pt where pt.promotion_id = p.id), '{}') as treatments
           from promotion p
          order by p.ends_on desc nulls first, p.id`,
      );
      return rows.map(mapPromotion);
    });
  }

  async createPromotion(
    caller: CatalogWriter,
    draft: PromotionDraft,
    idempotency: IdempotencyRecord,
    render: (row: PromotionRow) => unknown,
  ): Promise<{ outcome: 'created' | 'duplicate_code' | 'no_treatment'; row: PromotionRow | null; replay: unknown }> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const replay = await claim<unknown>(c, {
        record: idempotency,
        accountId: caller.accountId,
        practiceId: caller.practiceId,
        unfinished: 'No pudimos crear la promoción, y puede que sí se haya creado.',
      });
      if (replay !== null) return { outcome: 'created', row: null, replay: replay.response };

      for (const id of draft.treatmentIds) {
        const { rows } = await c.query(`select 1 from treatment where id = $1`, [id]);
        if (rows.length === 0) {
          await release(c, { record: idempotency, accountId: caller.accountId });
          return { outcome: 'no_treatment', row: null, replay: null };
        }
      }

      let id: string;
      await c.query('savepoint before_insert');
      try {
        const { rows } = await c.query<{ id: string }>(
          `insert into promotion (practice_id, name, discount_type, discount_value, starts_on,
                                  ends_on, quota, code, segment_key, segment_value, stackable)
           values (medskin_current_practice(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           returning id`,
          [
            draft.name,
            draft.discountType,
            draft.discountValue,
            draft.startsOn,
            draft.endsOn,
            draft.quota,
            draft.code,
            draft.segmentKey,
            draft.segmentValue,
            draft.stackable,
          ],
        );
        id = rows[0]!.id;
        await c.query('release savepoint before_insert');
      } catch (failure) {
        if (isUnique(failure)) {
          await c.query('rollback to savepoint before_insert');
          await release(c, { record: idempotency, accountId: caller.accountId });
          return { outcome: 'duplicate_code', row: null, replay: null };
        }
        throw failure;
      }

      for (const treatmentId of draft.treatmentIds) {
        await c.query(
          `insert into promotion_treatment (practice_id, promotion_id, treatment_id)
           values (medskin_current_practice(), $1, $2)`,
          [id, treatmentId],
        );
      }

      const row = await this.readPromotion(c, id);
      if (row === null) throw new Error(`la promoción ${id} no se pudo releer tras crearla`);
      await complete(c, {
        record: idempotency,
        accountId: caller.accountId,
        status: 201,
        response: render(row),
      });
      return { outcome: 'created', row, replay: null };
    });
  }

  /** El `PATCH`: solo despublicar y el cupo. Lo demás se crea de nuevo, no se reescribe. */
  async editPromotion(
    caller: CatalogWriter,
    promotionId: string,
    edit: { published?: boolean; quota?: number | null },
  ): Promise<PromotionRow | null> {
    return withTenantContext(this.pool, contextOf(caller), async (c) => {
      const sets: string[] = [];
      const values: unknown[] = [promotionId];
      if (edit.published !== undefined) {
        sets.push(`published = $${values.length + 1}`);
        values.push(edit.published);
      }
      if (edit.quota !== undefined) {
        sets.push(`quota = $${values.length + 1}`);
        values.push(edit.quota);
      }
      if (sets.length === 0) return this.readPromotion(c, promotionId);

      const { rows } = await c.query<{ id: string }>(
        `update promotion set ${sets.join(', ')}, updated_at = now() where id = $1 returning id`,
        values,
      );
      if (rows.length === 0) return null;
      return this.readPromotion(c, promotionId);
    });
  }

  // -----------------------------------------------------------------------------------
  // Lecturas internas, dentro de la transacción que las pidió
  // -----------------------------------------------------------------------------------

  private async readOne(c: PoolClient, id: string): Promise<TreatmentRow | null> {
    const { rows } = await c.query<Record<string, unknown>>(`${TREATMENT_SELECT} where t.id = $1`, [
      id,
    ]);
    const row = rows[0];
    if (row === undefined) return null;
    const mapped = mapTreatment(row);
    const { rows: supplies } = await c.query<{ product_id: string; units: number }>(
      `select product_id, units from treatment_supply where treatment_id = $1 order by product_id`,
      [id],
    );
    return {
      ...mapped,
      supplies: supplies.map((s) => ({ productId: s.product_id, units: s.units })),
    };
  }

  private async readProtocol(
    c: PoolClient,
    treatmentId: string,
  ): Promise<{ steps: readonly ProtocolStep[]; trafficLight: readonly TrafficLight[] } | null> {
    const { rows: found } = await c.query(`select 1 from treatment where id = $1`, [treatmentId]);
    if (found.length === 0) return null;

    const { rows: steps } = await c.query<{ moment: string; offset_hours: number; text: string }>(
      `select moment, offset_hours, text from treatment_protocol_step
        where treatment_id = $1 order by moment, offset_hours`,
      [treatmentId],
    );
    const { rows: lights } = await c.query<{ day: number; normal: string; call_if: string }>(
      `select day, normal, call_if from treatment_traffic_light
        where treatment_id = $1 order by day`,
      [treatmentId],
    );
    return {
      steps: steps.map((s) => ({ moment: s.moment, offsetHours: s.offset_hours, text: s.text })),
      trafficLight: lights.map((l) => ({ day: l.day, normal: l.normal, callIf: l.call_if })),
    };
  }

  private async readContraindications(
    c: PoolClient,
    treatmentId: string,
  ): Promise<readonly Contraindication[] | null> {
    const { rows: found } = await c.query(`select 1 from treatment where id = $1`, [treatmentId]);
    if (found.length === 0) return null;
    const { rows } = await c.query<{ key: string; value: string | null; absolute: boolean }>(
      `select key, value, absolute from treatment_contraindication
        where treatment_id = $1 order by key`,
      [treatmentId],
    );
    return rows;
  }

  private async readPromotion(c: PoolClient, id: string): Promise<PromotionRow | null> {
    const { rows } = await c.query<Record<string, unknown>>(
      `select p.*, (select currency from practice) as currency,
              to_char(p.starts_on, 'YYYY-MM-DD') as starts_on_text,
              to_char(p.ends_on, 'YYYY-MM-DD') as ends_on_text,
              coalesce((select array_agg(pt.treatment_id::text)
                          from promotion_treatment pt where pt.promotion_id = p.id), '{}') as treatments
         from promotion p where p.id = $1`,
      [id],
    );
    return rows[0] === undefined ? null : mapPromotion(rows[0]);
  }

  private async replaceSupplies(
    c: PoolClient,
    treatmentId: string,
    supplies: readonly { productId: string; units: number }[],
  ): Promise<void> {
    await c.query(`delete from treatment_supply where treatment_id = $1`, [treatmentId]);
    for (const supply of supplies) {
      await c.query(
        `insert into treatment_supply (practice_id, treatment_id, product_id, units)
         values (medskin_current_practice(), $1, $2, $3)`,
        [treatmentId, supply.productId, supply.units],
      );
    }
  }

  private async currency(c: PoolClient): Promise<string> {
    const { rows } = await c.query<{ currency: string }>(`select currency from practice`);
    return rows[0]?.currency ?? '';
  }
}

function mapTreatment(row: Record<string, unknown>): TreatmentRow {
  return {
    id: row.id as string,
    name: row.name as string,
    category: row.category as string,
    description: (row.description as string | null) ?? null,
    durationMinutes: row.duration_minutes as number,
    plannedSessions: row.planned_sessions as number,
    minIntervalDays: (row.min_interval_days as number | null) ?? null,
    requiresConsent: row.requires_consent as boolean,
    visibleToPatients: row.visible_to_patients as boolean,
    status: row.status as string,
    appliedCount: row.applied_count as number,
    cents: (row.base_cents as number | null) ?? 0,
    currency: (row.currency as string | null) ?? '',
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    supplies: [],
  };
}

function mapPromotion(row: Record<string, unknown>): PromotionRow {
  return {
    id: row.id as string,
    name: row.name as string,
    discountType: row.discount_type as string,
    discountValue: row.discount_value as number,
    // LA FECHA LA FORMATEA LA BASE, con el formato escrito. `p.*` trae `starts_on` como un
    // `Date` de JavaScript —`node-postgres` convierte `date` (oid 1082) a medianoche LOCAL—, así
    // que el `String(...).slice(0, 10)` que había aquí servía **`"Fri Oct 30"`** a la app en
    // `vigencia: { desde, hasta }`. Y `toISOString()` tampoco vale: medianoche local en una zona
    // con desplazamiento positivo cae el día ANTERIOR en UTC, o sea que la vigencia se movería un
    // día según dónde corra el proceso.
    startsOn: row.starts_on_text as string,
    endsOn: row.ends_on_text as string,
    quota: (row.quota as number | null) ?? null,
    redeemed: row.redeemed as number,
    code: (row.code as string | null) ?? null,
    segmentKey: row.segment_key as string,
    segmentValue: (row.segment_value as number | null) ?? null,
    stackable: row.stackable as boolean,
    published: row.published as boolean,
    currency: (row.currency as string | null) ?? '',
    treatmentIds: (row.treatments as string[] | null) ?? [],
  };
}

/** `23505 unique_violation`: el `409` lo decide la base y no una lectura previa. */
function isUnique(failure: unknown): boolean {
  return typeof failure === 'object' && failure !== null && (failure as { code?: string }).code === '23505';
}

/** `23514 check_violation`, y SOLO la restricción que se nombra: las demás siguen siendo 500. */
function isCheck(failure: unknown, constraint: string): boolean {
  if (typeof failure !== 'object' || failure === null) return false;
  const error = failure as { code?: string; constraint?: string };
  return error.code === '23514' && error.constraint === constraint;
}
