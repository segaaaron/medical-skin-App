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
import type { Region } from '../contract/session';
import { FailureLog } from '../failures/service-failure';
import { registeredRoute, type RequestWithContext } from './request-context';
import { policyFor } from './route-policy';

@Catch()
export class ErrorFilter implements ExceptionFilter {
  /**
   * `region` es la del DESPLIEGUE y no la de quien llama: el proceso solo sirve una, y en
   * un fallo sin sesión —`POST /v1/acceso`, los dos de recuperación, el refresco— la del
   * `caller` no existe todavía. Con `null` la columna quedaba vacía justo en las filas que
   * más se miran, y `medskin_record_anonymous_failure` acepta el argumento y lo valida
   * contra la lista cerrada (0005).
   */
  constructor(
    private readonly failures: FailureLog,
    private readonly region: Region,
  ) {}

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
    // cuerpo que no es JSON, un cuerpo que pasa del límite, el límite de ritmo. Son los
    // de _convenciones.md · «Los errores del transporte», y salen del MISMO catálogo que
    // los demás: dos de ellos no le dicen nada al usuario —`mensaje` vacío— porque son
    // errores de programación del cliente, pero TIENEN código y la app los registra.
    //
    // El estado se lee de las dos formas a propósito. `@fastify/rate-limit` y el resto de
    // los errores de nivel Fastify NO lanzan un `HttpException` de NestJS: lanzan un
    // objeto con `statusCode`. Mirar solo lo primero convertía el `429` en un `500`, y eso
    // tenía tres consecuencias medidas: la app mostraba la alerta que BLOQUEA con
    // «Reintentar» en vez de «Vas muy rápido», cada petición limitada escribía una fila en
    // `service_failure` —un cliente sin sesión inundando el registro gratis, que es lo
    // contrario del punto 9 de OWASP— y el 500 mentía, porque el servidor sí respondió:
    // respondió que no.
    const status = statusOf(thrown);
    const code = status === null ? undefined : TRANSPORT_CODE_BY_STATUS[status];
    if (status !== null && code !== undefined && status < 500) {
      this.reply(res, status, {
        error: { codigo: code, mensaje: CATALOG[code].message, campo: null },
      });
      return;
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
      // La de la sesión si la hay, y la del proceso si no: las dos son la misma región.
      region: caller?.region ?? this.region,
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

/**
 * El estado de HTTP de lo que se lanzó, por las dos vías que existen: `getStatus()` si es
 * un `HttpException` de NestJS, y `statusCode`/`status` si viene del nivel de Fastify. Un
 * error que no trae ninguna de las dos no es un error de transporte: es un fallo nuestro,
 * y se va a la rama del 500 con su causa real.
 */
function statusOf(thrown: unknown): number | null {
  if (thrown instanceof HttpException) return thrown.getStatus();
  if (typeof thrown !== 'object' || thrown === null) return null;
  const { statusCode, status } = thrown as { statusCode?: unknown; status?: unknown };
  if (typeof statusCode === 'number') return statusCode;
  if (typeof status === 'number') return status;
  return null;
}
