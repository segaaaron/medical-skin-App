// Solo HTTP · los cinco endpoints de `pacientes-consola.md`.
//
// LAS RUTAS SON EXACTAMENTE LAS CLAVES DE `route-policy.ts`, porque esa clave es la ruta tal y
// como la registra Fastify: cambiar la forma aquí es cambiar la clave, y una ruta sin política
// es un 500 que ninguna prueba de unidad ve.
//
// **El permiso NO se vuelve a comprobar**: si este controlador corre, el guardia ya lo
// verificó contra el token firmado. Comprobarlo dos veces son dos autorizaciones que se pueden
// desacordar — y aquí la diferencia entre `pacientes:leer` e `historia:leer` es justamente lo
// que separa a quien administra de quien lee expedientes.
//
// LA HISTORIA ES `POST` Y NO `GET`, y no es un capricho: deja una fila en el registro que el
// doctor lee, y el motivo no puede viajar en la URL —acabaría en los registros de Traefik, en
// el historial del navegador y en el `Referer`—. Lo que deja rastro en la bitácora de otro no
// es un `GET`.

import { Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import type { PlatformCaller } from '../../shared/platform/platform-token';
import { readHistoryReason, readPatientSearch } from './domain';
import type { ConsoleActor } from './repository';
import {
  ListTenantPatients,
  ReadConsoleHistory,
  ReadConsolePatient,
  SetConsolePatientStatus,
} from './use-cases';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('v1/platform')
export class PlatformPatientsController {
  // `@Inject` explícito: esbuild no emite `emitDecoratorMetadata`.
  constructor(
    @Inject(ListTenantPatients) private readonly listar: ListTenantPatients,
    @Inject(ReadConsolePatient) private readonly ficha: ReadConsolePatient,
    @Inject(ReadConsoleHistory) private readonly historia: ReadConsoleHistory,
    @Inject(SetConsolePatientStatus) private readonly estado: SetConsolePatientStatus,
  ) {}

  @Get('tenants/:id/patients')
  @HttpCode(200)
  async list(@Req() req: RequestWithContext, @Param('id') id: string) {
    // Un identificador que no es un uuid no tiene fila en ninguna parte: mismo 404 que uno
    // inventado, y sin tocar la base.
    if (!UUID.test(id)) throw new ContractError('consulta_no_existe');
    return this.listar.run(id, readPatientSearch(queryOf(req)), actorOf(req));
  }

  @Get('patients/:pid')
  @HttpCode(200)
  async file(@Req() req: RequestWithContext, @Param('pid') pid: string) {
    if (!UUID.test(pid)) throw new ContractError('paciente_no_existe');
    return this.ficha.run(pid, actorOf(req));
  }

  @Post('patients/:pid/medical-history/read')
  @HttpCode(200)
  async history(@Req() req: RequestWithContext, @Param('pid') pid: string) {
    // El MOTIVO se lee antes que el identificador: una petición sin motivo no llega a
    // preguntar por ninguna paciente, ni para saber si existe.
    const motivo = readHistoryReason(req.body);
    if (!UUID.test(pid)) throw new ContractError('paciente_no_existe');
    return this.historia.run(pid, motivo, actorOf(req));
  }

  @Post('patients/:pid/archive')
  @HttpCode(200)
  async archive(@Req() req: RequestWithContext, @Param('pid') pid: string) {
    if (!UUID.test(pid)) throw new ContractError('paciente_no_existe');
    return this.estado.run(pid, 'archivada', actorOf(req));
  }

  @Post('patients/:pid/reactivate')
  @HttpCode(200)
  async reactivate(@Req() req: RequestWithContext, @Param('pid') pid: string) {
    if (!UUID.test(pid)) throw new ContractError('paciente_no_existe');
    return this.estado.run(pid, 'activa', actorOf(req));
  }
}

function queryOf(req: RequestWithContext): Record<string, unknown> {
  const query = (req as { query?: unknown }).query;
  return typeof query === 'object' && query !== null ? (query as Record<string, unknown>) : {};
}

/**
 * Quién llama, del token de plataforma. Sin contexto el guardia no corrió, y una petición que
 * no pasó por el guardia no se atiende: es una ruta sin política (OWASP A01).
 */
function actorOf(req: RequestWithContext): ConsoleActor {
  const ctx = req.medskin;
  if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
  const platform: PlatformCaller | null = ctx.platform;
  if (platform === null) throw new ContractError('token_de_plataforma_no_valido');
  return { subject: platform.subject, label: platform.label, region: platform.region };
}
