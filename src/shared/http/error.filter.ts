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
  ContractError,
  FAILURE_PHRASES,
  ServiceFailure,
  type ErrorBody,
} from '../contract/error-catalog';
import { FailureLog } from '../failures/service-failure';
import { registeredRoute, type RequestWithContext } from './request-context';
import { policyFor } from './route-policy';

/**
 * Lo que HTTP produce antes de llegar a un controlador: una ruta que no existe, un cuerpo
 * que no es JSON, un cuerpo que pasa del límite. NINGUNO de estos códigos está en
 * `_convenciones.md`, y se dicen aquí porque callarlos sería devolver un «error
 * inesperado». Anotado para `producto`: hacen falta en el catálogo del contrato.
 */
const TRANSPORT_ERRORS: Record<number, { codigo: string; mensaje: string }> = {
  400: { codigo: 'cuerpo_no_valido', mensaje: 'No entendimos lo que mandaste. Revísalo.' },
  404: { codigo: 'ruta_no_existe', mensaje: 'Esa dirección no existe en MedSkin.' },
  405: { codigo: 'metodo_no_permitido', mensaje: 'Esa dirección no acepta esa operación.' },
  413: {
    codigo: 'cuerpo_demasiado_grande',
    mensaje: 'Eso es demasiado grande para mandarlo así.',
  },
  415: { codigo: 'formato_no_admitido', mensaje: 'Manda el cuerpo en JSON.' },
  429: {
    codigo: 'demasiadas_peticiones',
    mensaje: 'Demasiadas peticiones seguidas. Espera un momento.',
  },
};

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

    if (thrown instanceof HttpException) {
      const status = thrown.getStatus();
      const known = TRANSPORT_ERRORS[status];
      if (known !== undefined && status < 500) {
        this.reply(res, status, {
          error: { codigo: known.codigo, mensaje: known.mensaje, campo: null },
        } as unknown as ErrorBody);
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
