// `/v1/payments`, `/v1/margins`, `/v1/inventory`, `/v1/reports`, `/v1/plan` y `/v1/my-data`.

import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import { readIdempotencyKey } from '../../shared/idempotency/idempotency-key';
import type { Caller } from '../access/application/caller';
import { Business } from './application/business';

@Controller('v1/payments')
export class PaymentsController {
  constructor(@Inject(Business) private readonly business: Business) {}

  @Post()
  @HttpCode(201)
  async charge(@Req() req: RequestWithContext, @Body() body: unknown) {
    return this.business.charge(body, callerOf(req), readIdempotencyKey(req, body));
  }

  @Get()
  @HttpCode(200)
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, unknown>) {
    return this.business.payments(query ?? {}, callerOf(req));
  }

  // Un cobro no se borra: se anula con su motivo, y la anulación es otra fila.
  @Post(':id/void')
  @HttpCode(200)
  async voidPayment(
    @Req() req: RequestWithContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.business.voidPayment(id, body, callerOf(req));
  }
}

@Controller('v1/margins')
export class MarginsController {
  constructor(@Inject(Business) private readonly business: Business) {}

  @Get()
  @HttpCode(200)
  async read(@Req() req: RequestWithContext, @Query() query: Record<string, unknown>) {
    return this.business.margins(query ?? {}, callerOf(req));
  }
}

@Controller('v1/inventory')
export class InventoryController {
  constructor(@Inject(Business) private readonly business: Business) {}

  @Get()
  @HttpCode(200)
  async read(@Req() req: RequestWithContext) {
    return this.business.inventory(callerOf(req));
  }

  @Post()
  @HttpCode(201)
  async addProduct(@Req() req: RequestWithContext, @Body() body: unknown) {
    return this.business.addProduct(body, callerOf(req), readIdempotencyKey(req, body));
  }

  @Post('movements')
  @HttpCode(201)
  async move(@Req() req: RequestWithContext, @Body() body: unknown) {
    return this.business.move(body, callerOf(req), readIdempotencyKey(req, body));
  }
}

@Controller('v1/reports')
export class ReportsController {
  constructor(@Inject(Business) private readonly business: Business) {}

  @Get()
  @HttpCode(200)
  async read(@Req() req: RequestWithContext, @Query() query: Record<string, unknown>) {
    return this.business.report(query ?? {}, callerOf(req));
  }
}

@Controller('v1/plan')
export class PlanController {
  constructor(@Inject(Business) private readonly business: Business) {}

  @Get()
  @HttpCode(200)
  async read(@Req() req: RequestWithContext) {
    return this.business.plan(callerOf(req));
  }

  @Post('extend')
  @HttpCode(201)
  async extend(@Req() req: RequestWithContext, @Body() body: unknown) {
    return this.business.requestPlan(body, callerOf(req));
  }
}

@Controller('v1/my-data/exports')
export class ExportsController {
  constructor(@Inject(Business) private readonly business: Business) {}

  @Post()
  @HttpCode(202)
  async request(@Req() req: RequestWithContext, @Body() body: unknown) {
    // `negocio.md`: «Idempotente sí (`Idempotency-Key`): una solicitud por día y por cuenta».
    // Era el único POST que crea algo sin leerla, y la consecuencia es concreta: si el 202 se
    // perdía, el reintento recibía el `429` del único-por-día y la app **nunca llegaba a
    // conocer el `id`** de la exportación que sí se había creado.
    return this.business.requestExport(callerOf(req), readIdempotencyKey(req, body ?? {}));
  }

  @Get(':id')
  @HttpCode(200)
  async status(@Req() req: RequestWithContext, @Param('id') id: string) {
    return this.business.exportStatus(id, callerOf(req));
  }
}

function callerOf(req: RequestWithContext): Caller {
  const ctx = req.medskin;
  if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
  if (ctx.caller === null) throw new ContractError('token_no_valido');
  return ctx.caller;
}
