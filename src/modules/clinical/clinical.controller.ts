// `/v1/clinical-sessions…`, `/v1/lots…` y `/v1/consents…`.

import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Req } from '@nestjs/common';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import { readIdempotencyKey } from '../../shared/idempotency/idempotency-key';
import type { Caller } from '../access/application/caller';
import { ClinicalSessions, Consents, Lots } from './application/clinical';

@Controller('v1/clinical-sessions')
export class ClinicalSessionsController {
  constructor(@Inject(ClinicalSessions) private readonly sessions: ClinicalSessions) {}

  @Post()
  @HttpCode(201)
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return this.sessions.create(body, callerOf(req), readIdempotencyKey(req, body));
  }

  @Put(':id/note-draft')
  @HttpCode(200)
  async draft(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return this.sessions.saveDraft(id, body, callerOf(req));
  }

  @Post(':id/note/sign')
  @HttpCode(200)
  async sign(@Req() req: RequestWithContext, @Param('id') id: string) {
    return this.sessions.sign(id, callerOf(req));
  }

  @Post(':id/correction')
  @HttpCode(201)
  async correct(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return this.sessions.correct(id, body, callerOf(req));
  }

  @Post(':id/adverse-event')
  @HttpCode(201)
  async adverseEvent(
    @Req() req: RequestWithContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.sessions.adverseEvent(id, body, callerOf(req), readIdempotencyKey(req, body));
  }

  @Post(':id/void')
  @HttpCode(200)
  async voidSession(
    @Req() req: RequestWithContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.sessions.voidSession(id, body, callerOf(req));
  }
}

@Controller('v1/lots')
export class LotsController {
  constructor(@Inject(Lots) private readonly lots: Lots) {}

  @Get()
  @HttpCode(200)
  async list(@Req() req: RequestWithContext) {
    return this.lots.list(callerOf(req));
  }

  @Post()
  @HttpCode(201)
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return this.lots.create(body, callerOf(req), readIdempotencyKey(req, body));
  }

  // La consulta de retiro: dado un lote, a qué pacientes se les aplicó.
  @Get(':id/patients')
  @HttpCode(200)
  async patients(@Req() req: RequestWithContext, @Param('id') id: string) {
    return this.lots.patients(id, callerOf(req));
  }
}

@Controller('v1/consents')
export class ConsentsController {
  constructor(@Inject(Consents) private readonly consents: Consents) {}

  @Get(':treatment_id/text')
  @HttpCode(200)
  async text(@Req() req: RequestWithContext, @Param('treatment_id') id: string) {
    return this.consents.text(id, callerOf(req));
  }

  @Post()
  @HttpCode(201)
  async sign(@Req() req: RequestWithContext, @Body() body: unknown) {
    return this.consents.sign(body, callerOf(req), readIdempotencyKey(req, body));
  }
}

function callerOf(req: RequestWithContext): Caller {
  const ctx = req.medskin;
  if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
  if (ctx.caller === null) throw new ContractError('token_no_valido');
  return ctx.caller;
}
