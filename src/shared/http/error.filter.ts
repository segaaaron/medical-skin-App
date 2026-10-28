// El filtro de errores. Una sola forma de respuesta, la de `_convenciones.md`:
// `{ error: { codigo, mensaje, campo, datos } }`, con `codigo` y `mensaje` en español.
//
// Dos reglas que se cumplen aquí y en ningún otro sitio:
//   · NINGÚN stack trace, mensaje de motor ni nombre de tabla sale al cliente (OWASP A05).
//   · Todo 500 se registra en `service_failure` con la causa real, y la respuesta lleva la
//     frase que el contrato de ESE endpoint tiene escrita (`_convenciones.md`).

import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import {
  CATALOG,
  ContractError,
  FAILURE_PHRASES,
  ServiceFailure,
  TRANSPORT_CODE_BY_STATUS,
  type ErrorBody,
} from '../contract/error-catalog';
import { FailureLog } from '../failures/service-failure';
import { registeredRoute, type RequestWithContext } from './request-context';
import { policyFor } from './route-policy';

@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly failures: FailureLog) {}

  catch(thrown: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<RequestWithContext>();
    const res = http.getResponse<FastifyReply>();

    if (thrown instanceof ContractError) {
      if (thrown instanceof ServiceFailure) void this.record(req, thrown.code, thrown.cause);
      this.reply(res, thrown.status, thrown.body());
      return;
    }

    // Lo que HTTP produce ANTES de llegar a un controlador: una ruta que no existe, un
    // cuerpo que no es JSON, un cuerpo que pasa del límite. Son los seis de
    // _convenciones.md · «Los errores del transporte», y salen del catálogo como los
    // demás: tres de ellos no le dicen nada al usuario —`mensaje` vacío— porque son
    // errores de programación del cliente, pero TIENEN código y la app los registra.
    if (thrown instanceof HttpException) {
      const status = thrown.getStatus();
      const code = TRANSPORT_CODE_BY_STATUS[status];
      if (code !== undefined && status < 500) {
        this.reply(res, status, {
          error: { codigo: code, mensaje: CATALOG[code].message, campo: null },
        });
        return;
      }
    }

    // Todo lo demás es un fallo del servidor, y lleva la frase del endpoint: la frase es
    // obligatoria y cambia por endpoint, así que sale de la tabla de rutas.
    const policy = req.medskin?.policy ?? policyFor(req.method, registeredRoute(req));
    const failure = new ServiceFailure(policy?.failurePhrase ?? FAILURE_PHRASES.fallback, thrown);
    void this.record(req, failure.code, thrown);
    this.reply(res, failure.status, failure.body());
  }

  private reply(res: FastifyReply, status: number, body: ErrorBody): void {
    void res.status(status).send(body);
  }

  private async record(req: RequestWithContext, code: string, cause: unknown): Promise<void> {
    const ctx = req.medskin;
    const caller = ctx?.caller ?? null;
    await this.failures.record({
      service: 'api',
      operation: `${req.method} ${registeredRoute(req) ?? req.url}`,
      severity: 'error',
      errorCode: code,
      cause,
      traceId: ctx?.traceId ?? 'sin-traza',
      requestId: ctx?.requestId ?? 'sin-peticion',
      appVersion: ctx?.device.appVersion ?? null,
      platform: ctx?.device.platform ?? null,
      region: caller?.region ?? null,
      context:
        caller === null
          ? null
          : {
              accountId: caller.accountId,
              practiceId: caller.practiceId,
              accountRole: caller.accountRole,
            },
    });
  }
}
