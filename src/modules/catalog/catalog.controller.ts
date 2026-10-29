// `/v1/treatments…`, `/v1/prices`, `/v1/promotions` y `/v1/catalog`.
//
// Cuatro prefijos y un solo controlador por cada uno: son recursos distintos de la misma pieza.
// El `GET /v1/catalog` va aparte porque su puerta es otra —la paciente— y su rol de base
// también.

import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import { readIdempotencyKey } from '../../shared/idempotency/idempotency-key';
import type { Caller } from '../access/application/caller';
import { Catalog } from './application/catalog';
import { ReadCatalog } from './application/read-catalog';

@Controller('v1/treatments')
export class TreatmentsController {
  constructor(@Inject(Catalog) private readonly catalog: Catalog) {}

  @Get()
  @HttpCode(200)
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, unknown>) {
    return this.catalog.list(callerOf(req), query ?? {});
  }

  @Post()
  @HttpCode(201)
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return this.catalog.create(body, callerOf(req), readIdempotencyKey(req, body));
  }

  @Patch(':id')
  @HttpCode(200)
  async edit(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return this.catalog.edit(id, body, callerOf(req));
  }

  @Post(':id/archive')
  @HttpCode(200)
  async archive(@Req() req: RequestWithContext, @Param('id') id: string) {
    return this.catalog.archive(id, callerOf(req), true);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  async reactivate(@Req() req: RequestWithContext, @Param('id') id: string) {
    return this.catalog.archive(id, callerOf(req), false);
  }

  @Get(':id/protocol')
  @HttpCode(200)
  async protocol(@Req() req: RequestWithContext, @Param('id') id: string) {
    return this.catalog.protocol(id, callerOf(req));
  }

  @Put(':id/protocol')
  @HttpCode(200)
  async saveProtocol(
    @Req() req: RequestWithContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.saveProtocol(id, body, callerOf(req));
  }

  @Get(':id/contraindications')
  @HttpCode(200)
  async contraindications(@Req() req: RequestWithContext, @Param('id') id: string) {
    return this.catalog.contraindications(id, callerOf(req));
  }

  @Put(':id/contraindications')
  @HttpCode(200)
  async saveContraindications(
    @Req() req: RequestWithContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.saveContraindications(id, body, callerOf(req));
  }
}

@Controller('v1/prices')
export class PricesController {
  constructor(@Inject(Catalog) private readonly catalog: Catalog) {}

  @Get()
  @HttpCode(200)
  async list(@Req() req: RequestWithContext) {
    return this.catalog.prices(callerOf(req));
  }

  @Put()
  @HttpCode(200)
  async save(@Req() req: RequestWithContext, @Body() body: unknown) {
    return this.catalog.savePrices(body, callerOf(req));
  }
}

@Controller('v1/promotions')
export class PromotionsController {
  constructor(@Inject(Catalog) private readonly catalog: Catalog) {}

  @Get()
  @HttpCode(200)
  async list(@Req() req: RequestWithContext) {
    return this.catalog.promotions(callerOf(req));
  }

  @Post()
  @HttpCode(201)
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return this.catalog.createPromotion(body, callerOf(req), readIdempotencyKey(req, body));
  }

  @Patch(':id')
  @HttpCode(200)
  async edit(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return this.catalog.editPromotion(id, body, callerOf(req));
  }
}

/** La puerta de la paciente: otro rol de base y otra política. */
@Controller('v1/catalog')
export class PatientCatalogController {
  constructor(@Inject(ReadCatalog) private readonly catalog: ReadCatalog) {}

  @Get()
  @HttpCode(200)
  async read(@Req() req: RequestWithContext, @Query() query: Record<string, unknown>) {
    return this.catalog.run(query ?? {}, callerOf(req));
  }
}

function callerOf(req: RequestWithContext): Caller {
  const ctx = req.medskin;
  if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
  if (ctx.caller === null) throw new ContractError('token_no_valido');
  return ctx.caller;
}
