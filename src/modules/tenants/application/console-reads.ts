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
import type { ConsoleSearchPort, PlatformActor } from '../domain/platform-ports';

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
        doctora: { correo: row.ownerEmail },
      })),
    };
  }
}
