// LA LECTURA DE CONSOLA QUE DEVUELVE LISTA · `consultas.md`, 30 de octubre de 2026.
//
// `GET /v1/platform/tenants` · buscar una consulta cuando ya no se tiene su uuid.
//
// LO QUE TIENE DE DISTINTO, y es la única razón por la que merece un comentario largo: es la
// ÚNICA lectura de consola que devuelve más de una consulta. En la ficha, un error de campo
// expone la consulta que quien llama ya estaba mirando; aquí expondría el padrón entero. Por
// eso devuelve un subconjunto EXACTO de los campos de la ficha, y `console-reads.spec.ts` lo
// fija comparando las claves: si alguien añade un campo aquí sin añadirlo a la ficha, la
// prueba falla.
//
// AQUÍ VIVÍA TAMBIÉN `ListLicenses`, la bandeja de lo que esperaba revisión, que firmaba un
// enlace de cinco minutos a la credencial escaneada en cada lectura. Se escribió y se borró el
// mismo día: MedSkin no verifica licencias —no es una asociación médica—, así que no hay
// bandeja, no hay credencial y no hay enlace que firmar.

import { nextCursor, type ConsoleSearch } from '../domain/console-search';
import { ContractError } from '../../../shared/contract/error-catalog';
import type {
  ConsoleSearchPort,
  PlatformActor,
  TenantLifecyclePort,
} from '../domain/platform-ports';

export type TenantSearchResponse = {
  cuantas: number;
  siguiente: string | null;
  consultas: readonly {
    id: string;
    nombre: string;
    region_etiqueta: string;
    alta_en: string;
    plan: string;
    doctora: { correo: string | null };
  }[];
};

export class SearchTenants {
  constructor(
    private readonly search: ConsoleSearchPort,
    private readonly regionLabel: string,
  ) {}

  async run(query: ConsoleSearch, actor: PlatformActor): Promise<TenantSearchResponse> {
    const rows = await this.search.searchTenants({ actor, search: query });
    const { page, next } = nextCursor(rows, query.perPage, (row) => ({
      at: row.createdAt,
      id: row.id,
    }));

    return {
      // Lo de ESTA página, no el total: contar el padrón en cada búsqueda es un recuento que
      // nadie mira y que crece con la tabla.
      cuantas: page.length,
      siguiente: next,
      consultas: page.map((row) => ({
        id: row.id,
        nombre: row.name,
        region_etiqueta: this.regionLabel,
        alta_en: row.createdOn,
        plan: row.plan,
        estado: row.status,
        doctora: { correo: row.ownerEmail },
      })),
    };
  }
}

// =========================================================================================
// SUSPENDER, REACTIVAR Y BORRAR UNA CONSULTA · 3 de noviembre de 2026
//
// Pedido por el dueño: «borrar que borras al doctor con todo lo que está ligado a ese doctor,
// y otro que diga suspendido, que solo suspenda al doctor, que no le deje entrar a la app
// cuando está suspendido».
//
// SON DOS COSAS DISTINTAS Y NO UNA GRADACIÓN DE LA OTRA:
//   · suspender · reversible, no toca un dato, y cierra las sesiones abiertas;
//   · borrar    · irreversible, y se lleva los expedientes de todas sus pacientes.
// =========================================================================================

export class SetTenantStatus {
  constructor(private readonly tenants: TenantLifecyclePort) {}

  async run(
    practiceId: string,
    status: 'activa' | 'suspendida',
    actor: PlatformActor,
  ): Promise<unknown> {
    const done = await this.tenants.setStatus({ actor, practiceId, status });
    if (done === null) throw new ContractError('consulta_no_existe');

    return {
      consulta_id: practiceId,
      estado: done.status,
      // Cuántas sesiones se cerraron. La pantalla lo necesita para poder decir «se cerraron 2
      // sesiones abiertas» en vez de dejar a quien suspende preguntándose si la doctora
      // seguía dentro.
      sesiones_cerradas: done.revokedSessions,
    };
  }
}

export class DeleteTenant {
  constructor(private readonly tenants: TenantLifecyclePort) {}

  /**
   * NO SE DESHACE, y la respuesta lo dice con números: cuántas fichas se llevó. Quien lo
   * aprieta ya escribió el nombre de la consulta en la consola; esto es lo que queda después.
   */
  async run(practiceId: string, actor: PlatformActor): Promise<unknown> {
    const gone = await this.tenants.remove({ actor, practiceId });
    if (gone === null) throw new ContractError('consulta_no_existe');

    return {
      consulta_id: practiceId,
      nombre: gone.name,
      fichas_borradas: gone.patients,
      // Cuántos correos quedan libres para volver a darse de alta. Sin este número la
      // consola no puede contestar la única pregunta que viene después del borrado: «¿puedo
      // volver a crear a esta doctora con su mismo correo?». Sí.
      correos_liberados: gone.accountsReleased,
    };
  }
}
