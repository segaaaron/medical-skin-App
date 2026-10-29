// `/v1/vinculos…` · las dos pantallas de la paciente: «¿Es esta tu doctora?» y «Antes de
// atenderte». Controlador aparte del de la ficha porque es otra puerta: otro rol de base
// (`app_patient`), otro permiso y otra política. Lo único que comparten es la tabla.

import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Req } from '@nestjs/common';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import type { Caller } from '../access/application/caller';
import { PatientLinks } from './application/patient-links';
import { WritePatientHistory } from './application/write-patient-history';

@Controller('v1/vinculos')
export class LinksController {
  constructor(
    @Inject(PatientLinks) private readonly links: PatientLinks,
    @Inject(WritePatientHistory) private readonly history: WritePatientHistory,
  ) {}

  @Get()
  @HttpCode(200)
  async list(@Req() req: RequestWithContext) {
    return this.links.list(callerOf(req));
  }

  @Post(':vinculo_id/aceptar')
  @HttpCode(200)
  async accept(@Req() req: RequestWithContext, @Param('vinculo_id') id: string) {
    return this.links.decide(id, callerOf(req), true);
  }

  @Post(':vinculo_id/rechazar')
  @HttpCode(200)
  async reject(@Req() req: RequestWithContext, @Param('vinculo_id') id: string) {
    return this.links.decide(id, callerOf(req), false);
  }

  @Put(':vinculo_id/ficha-medica')
  @HttpCode(200)
  async medicalForm(
    @Req() req: RequestWithContext,
    @Param('vinculo_id') id: string,
    @Body() body: unknown,
  ) {
    return this.history.run(id, body, callerOf(req));
  }
}

function callerOf(req: RequestWithContext): Caller {
  const ctx = req.medskin;
  if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
  if (ctx.caller === null) throw new ContractError('token_no_valido');
  return ctx.caller;
}
