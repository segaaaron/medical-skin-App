// GET /v1/catalog · lo que ESTA paciente puede ver y reservar de la consulta que la atiende.
//
// NO ES UN `GET` DEL CATÁLOGO CON FILTROS DEL CLIENTE: es una pregunta sobre una paciente
// concreta, y por eso el filtro clínico vive en el servidor. El cruce contra su
// `medical_history` ocurre dentro de la misma transacción y lo que sale es un booleano por
// tratamiento: ni un campo de sus antecedentes viaja en esta respuesta.

import { ContractError } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import { availabilityOf } from '../domain/availability';
import type { PatientCatalogPort } from '../domain/ports';
import { discounted, money } from '../domain/treatment';
import type { ClockPort } from './catalog';

export class ReadCatalog {
  constructor(
    private readonly catalog: PatientCatalogPort,
    private readonly clock: ClockPort,
  ) {}

  async run(query: Record<string, unknown>, caller: Caller): Promise<unknown> {
    // Esta pantalla es de la paciente. Una doctora que llegue aquí recibe el 403 del contrato.
    if (caller.accountRole !== 'paciente') throw new ContractError('rol_no_corresponde');

    // «Obligatorio: una paciente puede tener N vínculos y el catálogo es de una consulta.» Se
    // comprueba contra SUS vínculos, y el parámetro solo elige cuál.
    const practiceId = typeof query.practice_id === 'string' ? query.practice_id.trim() : '';
    if (practiceId === '') throw new ContractError('vinculo_no_existe');

    const facts = await this.catalog.read(caller.accountId, practiceId);
    if (facts === null) throw new ContractError('vinculo_no_existe');
    if (facts === 'invitada') throw new ContractError('vinculo_sin_aceptar');

    const today = this.clock.now().toISOString().slice(0, 10);

    return {
      consulta: facts.practiceName,
      moneda: facts.currency,
      tratamientos: facts.treatments.map((treatment) => {
        const availability = availabilityOf(treatment, facts, today);
        const promotion =
          // «Un tratamiento contraindicado tampoco trae su promoción», aunque esté vigente y
          // con cupo: ofrecer un descuento sobre algo que ella no puede hacerse es la
          // recomendación clínicamente inadecuada que el producto no se permite.
          availability.available && treatment.promotion !== null ? treatment.promotion : null;

        return {
          id: treatment.id,
          nombre: treatment.name,
          categoria: treatment.category,
          descripcion: treatment.description,
          duracion_minutos: treatment.durationMinutes,
          precio: money(treatment.cents, facts.currency),
          precio_con_promocion:
            promotion === null
              ? null
              : money(
                  discounted(treatment.cents, {
                    type: promotion.discountType,
                    value: promotion.discountValue,
                  }),
                  facts.currency,
                ),
          promocion:
            promotion === null
              ? null
              : { id: promotion.id, nombre: promotion.name, hasta: promotion.endsOn },
          disponible: availability.available,
          // Solo cuando la razón es el intervalo. Con una contraindicación va nulo: el motivo
          // es su dato clínico y la pantalla de un catálogo no es donde se lee.
          disponible_desde: availability.availableFrom,
        };
      }),
    };
  }
}
