// Solo HTTP · `GET /v1/platform/licenses` · la bandeja de lo que espera revisión.
//
// CONTROLADOR APARTE Y NO UN MÉTODO MÁS EN EL DE CONSULTAS, porque la ruta base es otra
// (`/v1/platform/licenses`) y la clave de `route-policy.ts` es la ruta tal y como la registra
// Fastify. Meterlo en `@Controller('v1/platform/tenants')` registraría
// `/v1/platform/tenants/licenses`, que no es la ruta del contrato y además chocaría con
// `:id`: «licenses» entraría como identificador y el guardia buscaría una política que no
// existe.
//
// El permiso NO se vuelve a comprobar: si este controlador corre, el guardia ya verificó
// `plataforma:consultas:leer` contra el token firmado.

import { Controller, Get, HttpCode, Inject, Req } from '@nestjs/common';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import type { PlatformCaller } from '../../shared/platform/platform-token';
import { ListLicenses } from './application/console-reads';
import { readLicenseInbox } from './domain/console-search';
import type { PlatformActor } from './domain/platform-ports';

function actorOf(req: RequestWithContext): PlatformActor {
  const ctx = req.medskin;
  // Sin contexto el guardia no corrió, y una petición que no pasó por el guardia no se
  // atiende: es una ruta sin política (OWASP A01).
  if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
  const platform: PlatformCaller | null = ctx.platform;
  if (platform === null) throw new ContractError('token_de_plataforma_no_valido');
  return { subject: platform.subject, label: platform.label, region: platform.region };
}

function queryOf(req: RequestWithContext): Record<string, unknown> {
  const query = (req as { query?: unknown }).query;
  return typeof query === 'object' && query !== null ? (query as Record<string, unknown>) : {};
}

@Controller('v1/platform/licenses')
export class PlatformLicensesController {
  constructor(@Inject(ListLicenses) private readonly listLicenses: ListLicenses) {}

  @Get()
  @HttpCode(200)
  async inbox(@Req() req: RequestWithContext) {
    return this.listLicenses.run(readLicenseInbox(queryOf(req)), actorOf(req));
  }
}
