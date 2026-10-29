// Las rutas de ficha de `pacientes.md`. El alta —`POST /v1/patients`— NO está aquí: es la
// parte de cuenta y acceso, vive en `accounts` y ya se sirve.
//
// Solo HTTP: valida la forma, llama al caso de uso, devuelve. La autorización la hizo el
// guardia por lista blanca y el permiso lo comprueba el caso de uso, que es quien sabe cuál
// pide cada uno: `pacientes:leer` para la lista, `historia:leer` para la ficha.

import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import type { Caller } from '../access/application/caller';
import { EditPatient } from './application/edit-patient';
import { ListPatients } from './application/list-patients';
import { ReadPatient } from './application/read-patient';

@Controller('v1/patients')
export class PatientsController {
  // `@Inject` explícito: esbuild no emite `emitDecoratorMetadata`.
  constructor(
    @Inject(ListPatients) private readonly listPatients: ListPatients,
    @Inject(ReadPatient) private readonly readPatient: ReadPatient,
    @Inject(EditPatient) private readonly editPatient: EditPatient,
  ) {}

  @Get()
  @HttpCode(200)
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, unknown>) {
    return this.listPatients.run(query ?? {}, callerOf(req));
  }

  @Get(':id')
  @HttpCode(200)
  async file(@Req() req: RequestWithContext, @Param('id') id: string) {
    return this.readPatient.run(id, callerOf(req));
  }

  @Patch(':id')
  @HttpCode(200)
  async edit(
    @Req() req: RequestWithContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.editPatient.run(id, body, callerOf(req));
  }

  // Archivar y reactivar son el mismo camino con el estado al reves, y los dos son
  // idempotentes por naturaleza: archivar lo archivado devuelve el mismo 200.
  @Post(':id/archive')
  @HttpCode(200)
  async archive(@Req() req: RequestWithContext, @Param('id') id: string): Promise<unknown> {
    return this.editPatient.archive(id, callerOf(req), true);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  async reactivate(@Req() req: RequestWithContext, @Param('id') id: string): Promise<unknown> {
    return this.editPatient.archive(id, callerOf(req), false);
  }

  @Get(':id/medical-history')
  @HttpCode(200)
  async history(@Req() req: RequestWithContext, @Param('id') id: string) {
    return this.readPatient.history(id, callerOf(req));
  }
}

/** Quién llama. Sin contexto, el guardia no corrió: eso no se atiende (OWASP A01). */
function callerOf(req: RequestWithContext): Caller {
  const ctx = req.medskin;
  if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
  if (ctx.caller === null) throw new ContractError('token_no_valido');
  return ctx.caller;
}
