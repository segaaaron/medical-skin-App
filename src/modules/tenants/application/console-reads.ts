// LAS DOS LECTURAS DE CONSOLA QUE DEVUELVEN LISTA · `consultas.md`, 30 de octubre de 2026.
//
// `GET /v1/platform/tenants`  · buscar una consulta cuando ya no se tiene su uuid
// `GET /v1/platform/licenses` · la bandeja de lo que espera revisión
//
// LO QUE ESTAS DOS TIENEN DE DISTINTO, y es la única razón por la que merecen un comentario
// largo: son las PRIMERAS lecturas de consola que devuelven más de una consulta. Hasta hoy,
// un error de campo exponía la ficha que quien llama ya estaba mirando; aquí expondría el
// padrón entero. Por eso la búsqueda devuelve un subconjunto EXACTO de los campos de la
// ficha, y `console-reads.spec.ts` lo fija comparando las claves: si alguien añade un campo
// aquí sin añadirlo a la ficha, la prueba falla.

import type { StorageConfig } from '../../../shared/storage/signed-url';
import { signUrl } from '../../../shared/storage/signed-url';
import type { ClockPort } from '../../access/domain/ports';
import { nextCursor, type ConsoleSearch, type LicenseInbox } from '../domain/console-search';
import type { ConsoleSearchPort, PlatformActor } from '../domain/platform-ports';

/** Cinco minutos, los mismos que el contrato escribe para la credencial. */
export const CREDENTIAL_LINK_SECONDS = 5 * 60;

export type TenantSearchResponse = {
  cuantas: number;
  siguiente: string | null;
  consultas: readonly {
    id: string;
    nombre: string;
    region_etiqueta: string;
    alta_en: string;
    plan: string;
    licencia: string;
    doctora: { correo: string | null };
  }[];
};

export type LicenseInboxResponse = {
  cuantas: number;
  siguiente: string | null;
  licencias: readonly {
    practice_id: string;
    consulta: string;
    doctora: { correo: string | null };
    estado: string;
    enviada_en: string | null;
    respuesta_estimada_en: string | null;
    especialidad: string | null;
    matricula: string | null;
    pais_ejercicio: string | null;
    credencial_url: string | null;
    credencial_caduca_en: string | null;
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
        licencia: row.licenseStatus,
        doctora: { correo: row.ownerEmail },
      })),
    };
  }
}

export class ListLicenses {
  constructor(
    private readonly search: ConsoleSearchPort,
    private readonly storage: StorageConfig,
    private readonly clock: ClockPort,
  ) {}

  async run(inbox: LicenseInbox, actor: PlatformActor): Promise<LicenseInboxResponse> {
    const rows = await this.search.listLicenses({ actor, inbox });
    const { page, next } = nextCursor(rows, inbox.perPage, (row) => ({
      at: row.cursorAt,
      id: row.practiceId,
    }));
    const now = this.clock.now();

    return {
      cuantas: page.length,
      siguiente: next,
      licencias: page.map((row) => {
        // EL ENLACE SE FIRMA EN CADA LECTURA Y NO SE GUARDA. Un enlace guardado es un
        // documento de identidad accesible por quien tenga el registro donde se guardó, y
        // sobrevive a la revisión que lo justificaba.
        //
        // Nulo cuando no hay credencial subida —todo lo que esté en `sin_enviar`, incluidas
        // las consultas cuya matrícula puso la consola en el alta—: una bandeja con un enlace
        // roto es peor que una sin enlace.
        const link =
          row.credentialKey === null
            ? null
            : signUrl(this.storage, {
                method: 'GET',
                key: row.credentialKey,
                expiresInSeconds: CREDENTIAL_LINK_SECONDS,
                now,
              });

        return {
          practice_id: row.practiceId,
          consulta: row.practiceName,
          doctora: { correo: row.ownerEmail },
          estado: row.status,
          enviada_en: row.submittedAt?.toISOString() ?? null,
          respuesta_estimada_en: row.responseEstimatedAt?.toISOString() ?? null,
          especialidad: row.specialty,
          matricula: row.licenseNumber,
          pais_ejercicio: row.practiceCountry,
          credencial_url: link?.url ?? null,
          credencial_caduca_en: link?.expiresAt.toISOString() ?? null,
        };
      }),
    };
  }
}
