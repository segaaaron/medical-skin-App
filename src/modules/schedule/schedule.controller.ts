// `/v1/schedules`, `/v1/availability`, `/v1/appointments…`, `/v1/waitlist` y `/v1/sync`.
//
// Cinco prefijos porque son cinco recursos; el permiso y el rol los comprueba cada caso de uso,
// que es quien sabe si la puerta es de la consulta, de la paciente, o de las dos.

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import { readIdempotencyKey } from '../../shared/idempotency/idempotency-key';
import type { Caller } from '../access/application/caller';
import { Appointments } from './application/appointments';
import { Schedule } from './application/schedule';
import { SyncBatch } from './application/sync';

@Controller('v1/schedules')
export class SchedulesController {
  constructor(@Inject(Schedule) private readonly schedule: Schedule) {}

  @Get()
  @HttpCode(200)
  async read(@Req() req: RequestWithContext) {
    return this.schedule.read(callerOf(req));
  }

  @Put()
  @HttpCode(200)
  async save(@Req() req: RequestWithContext, @Body() body: unknown) {
    return this.schedule.save(body, callerOf(req));
  }
}

@Controller('v1/availability')
export class AvailabilityController {
  constructor(@Inject(Schedule) private readonly schedule: Schedule) {}

  @Get()
  @HttpCode(200)
  async read(@Req() req: RequestWithContext, @Query() query: Record<string, unknown>) {
    return this.schedule.availability(query ?? {}, callerOf(req));
  }
}

@Controller('v1/appointments')
export class AppointmentsController {
  constructor(@Inject(Appointments) private readonly appointments: Appointments) {}

  // La clave es OBLIGATORIA aquí y el contrato lo dice con su motivo: «confirmar una cita es
  // una carga que bloquea, y sin clave un reintento produce dos citas».
  @Post()
  @HttpCode(201)
  async book(@Req() req: RequestWithContext, @Body() body: unknown) {
    return this.appointments.book(body, callerOf(req), readIdempotencyKey(req, body));
  }

  @Get()
  @HttpCode(200)
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, unknown>) {
    return this.appointments.list(query ?? {}, callerOf(req));
  }

  @Get(':id')
  @HttpCode(200)
  async one(@Req() req: RequestWithContext, @Param('id') id: string) {
    return this.appointments.one(id, callerOf(req));
  }

  @Patch(':id')
  @HttpCode(200)
  async reschedule(
    @Req() req: RequestWithContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.appointments.reschedule(id, body, callerOf(req));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@Req() req: RequestWithContext, @Param('id') id: string) {
    return this.appointments.cancel(id, callerOf(req));
  }

  @Post(':id/deposit')
  @HttpCode(200)
  async deposit(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return this.appointments.claimDeposit(id, body, callerOf(req));
  }

  @Post(':id/deposit/confirm')
  @HttpCode(200)
  async confirmDeposit(@Req() req: RequestWithContext, @Param('id') id: string) {
    return this.appointments.confirmDeposit(id, callerOf(req));
  }

  @Post(':id/attendance')
  @HttpCode(200)
  async attendance(
    @Req() req: RequestWithContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.appointments.attendance(id, body, callerOf(req));
  }
}

@Controller('v1/waitlist')
export class WaitlistController {
  constructor(@Inject(Appointments) private readonly appointments: Appointments) {}

  @Post()
  @HttpCode(201)
  async join(@Req() req: RequestWithContext, @Body() body: unknown) {
    return this.appointments.joinWaitlist(body, callerOf(req));
  }

  @Delete(':id')
  @HttpCode(200)
  async leave(@Req() req: RequestWithContext, @Param('id') id: string) {
    return this.appointments.leaveWaitlist(id, callerOf(req));
  }
}

@Controller('v1/sync')
export class SyncController {
  constructor(@Inject(SyncBatch) private readonly sync: SyncBatch) {}

  @Post()
  @HttpCode(200)
  async run(@Req() req: RequestWithContext, @Body() body: unknown) {
    return this.sync.run(body, callerOf(req));
  }
}

function callerOf(req: RequestWithContext): Caller {
  const ctx = req.medskin;
  if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
  if (ctx.caller === null) throw new ContractError('token_no_valido');
  return ctx.caller;
}
