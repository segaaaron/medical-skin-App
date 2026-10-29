// `/v1/aftercare…`, `/v1/traffic-light`, `/v1/incidents`, `/v1/messages`, `/v1/devices` y
// `/v1/alerts/preferences`.

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import { readIdempotencyKey } from '../../shared/idempotency/idempotency-key';
import type { Caller } from '../access/application/caller';
import { Aftercare } from './application/aftercare';

@Controller('v1/aftercare')
export class AftercareController {
  constructor(@Inject(Aftercare) private readonly aftercare: Aftercare) {}

  @Get()
  @HttpCode(200)
  async plans(@Req() req: RequestWithContext, @Query() query: Record<string, unknown>) {
    return this.aftercare.plans(query ?? {}, callerOf(req));
  }

  @Post(':step_id/done')
  @HttpCode(200)
  async done(
    @Req() req: RequestWithContext,
    @Param('step_id') id: string,
    @Body() body: unknown,
  ) {
    return this.aftercare.markStep(id, body, callerOf(req));
  }
}

@Controller('v1/traffic-light')
export class TrafficLightController {
  constructor(@Inject(Aftercare) private readonly aftercare: Aftercare) {}

  @Get(':session_id')
  @HttpCode(200)
  async read(@Req() req: RequestWithContext, @Param('session_id') id: string) {
    return this.aftercare.trafficLight(id, callerOf(req));
  }
}

@Controller('v1/incidents')
export class IncidentsController {
  constructor(@Inject(Aftercare) private readonly aftercare: Aftercare) {}

  @Post()
  @HttpCode(201)
  async report(@Req() req: RequestWithContext, @Body() body: unknown) {
    return this.aftercare.reportIncident(body, callerOf(req), readIdempotencyKey(req, body));
  }
}

@Controller('v1/messages')
export class MessagesController {
  constructor(@Inject(Aftercare) private readonly aftercare: Aftercare) {}

  @Get()
  @HttpCode(200)
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, unknown>) {
    return this.aftercare.messages(query ?? {}, callerOf(req));
  }

  @Post()
  @HttpCode(201)
  async send(@Req() req: RequestWithContext, @Body() body: unknown) {
    return this.aftercare.send(body, callerOf(req), readIdempotencyKey(req, body));
  }
}

@Controller('v1/devices')
export class DevicesController {
  constructor(@Inject(Aftercare) private readonly aftercare: Aftercare) {}

  @Post()
  @HttpCode(200)
  async register(@Req() req: RequestWithContext, @Body() body: unknown) {
    return this.aftercare.registerDevice(body, callerOf(req));
  }

  @Delete(':device_id')
  @HttpCode(200)
  async forget(@Req() req: RequestWithContext, @Param('device_id') id: string) {
    return this.aftercare.forgetDevice(id, callerOf(req));
  }
}

@Controller('v1/alerts/preferences')
export class AlertPreferencesController {
  constructor(@Inject(Aftercare) private readonly aftercare: Aftercare) {}

  @Get()
  @HttpCode(200)
  async read(@Req() req: RequestWithContext) {
    return this.aftercare.preferences(callerOf(req));
  }

  @Put()
  @HttpCode(200)
  async save(@Req() req: RequestWithContext, @Body() body: unknown) {
    return this.aftercare.savePreferences(body, callerOf(req));
  }
}

function callerOf(req: RequestWithContext): Caller {
  const ctx = req.medskin;
  if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
  if (ctx.caller === null) throw new ContractError('token_no_valido');
  return ctx.caller;
}
