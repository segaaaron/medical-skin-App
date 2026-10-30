// El filtro de errores. Una sola forma de respuesta, la de `_convenciones.md`:
// `{ error: { codigo, mensaje, campo, datos } }`, con `codigo` y `mensaje` en español.
//
// Dos reglas que se cumplen aquí y en ningún otro sitio:
//   · NINGÚN stack trace, mensaje de motor ni nombre de tabla sale al cliente (OWASP A05).
//   · Todo 500 se registra en `service_failure` con la causa real, y la respuesta lleva la
//     frase que el contrato de ESE endpoint tiene escrita (`_convenciones.md`).

import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { Caller } from '../../modules/access/application/caller';
import {
  CATALOG,
  ContractError,
  FAILURE_PHRASES,
  ServiceFailure,
  TRANSPORT_CODE_BY_STATUS,
  type ErrorBody,
} from '../contract/error-catalog';
import type { Region } from '../contract/session';
import { FailureLog, type FailureContext } from '../failures/service-failure';
import type { PlatformCaller } from '../platform/platform-token';
import { metaOf } from './envelope.interceptor';
import { registeredRoute, type RequestWithContext } from './request-context';
import { policyFor } from './route-policy';

@Catch()
export class ErrorFilter implements ExceptionFilter {
  /**
   * `region` es la del DESPLIEGUE y no la de quien llama: el proceso solo sirve una, y en
   * un fallo sin sesión —`POST /v1/access`, los dos de recuperación, el refresco— la del
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
      this.reply(res, thrown.status, thrown.body(), req);
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
      this.reply(
        res,
        status,
        { error: { codigo: code, mensaje: CATALOG[code].message, campo: null } },
        req,
      );
      return;
    }

    // Todo lo demás es un fallo del servidor, y lleva la frase del endpoint: la frase es
    // obligatoria y cambia por endpoint, así que sale de la tabla de rutas.
    const policy = req.medskin?.policy ?? policyFor(req.method, registeredRoute(req));
    const failure = new ServiceFailure(policy?.failurePhrase ?? FAILURE_PHRASES.fallback, thrown);
    void this.record(req, failure.code, thrown);
    this.reply(res, failure.status, failure.body(), req);
  }

  /**
   * El error sale con el MISMO `meta` que el éxito (`envelope.interceptor.ts`): un sobre que
   * solo acompaña a la mitad buena no es un sobre. Y con él va `X-Request-Id`, que es lo que
   * convierte «me dio error» en una línea que se puede buscar en `service_failure`.
   */
  private reply(
    res: FastifyReply,
    status: number,
    body: ErrorBody,
    req: RequestWithContext,
  ): void {
    const meta = metaOf(req, this.region, new Date());
    void res.header('X-Request-Id', meta.peticion_id);
    void res.status(status).send({ ...body, meta });
  }

  private async record(req: RequestWithContext, code: string, cause: unknown): Promise<void> {
    const ctx = req.medskin;
    const caller = ctx?.caller ?? null;
    const platform = ctx?.platform ?? null;
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
      // La de la sesión si la hay, y la del proceso si no: las dos son la misma región. La
      // del token de PLATAFORMA no se usa aquí a propósito: para una audiencia de otra
      // región ya hay un `403 region_no_corresponde`, así que lo único que un token de
      // consola puede significar en esta tabla es «el despliegue que falló fue este».
      region: caller?.region ?? this.region,
      context: contextOf(caller, platform),
    });
  }
}

/**
 * Quién pidió lo que falló, por los dos caminos que pueden traer identidad.
 *
 * `platform` ES EL CASO QUE IMPORTA MÁS, y el que faltaba: una ruta de consola nunca tiene
 * `caller` —la persona de plataforma no tiene cuenta en esta región ni sesión que leer—, así
 * que sus 500 entraban por el camino anónimo y la fila quedaba **sin actor**. Y es soporte
 * actuando sobre la cuenta de una paciente: la bitácora de fallos es lo único que hace
 * revisable lo que soporte hace, y un 500 sin quién lo pidió es justo el que alguien querría
 * no dejar registrado.
 *
 * El `sub` del token entra en `actor_id` porque es un `uuid` (decisión del 28 de octubre) y
 * porque esa columna no tiene clave foránea, igual que `license.reviewed_by`: fijarlo **no
 * crea ninguna fila en `account`**.
 *
 * `practiceId` va nulo incluso cuando la ruta nombra una consulta, y es deliberado: el fallo
 * es de una petición de soporte, no de la consulta sobre la que miraba. Atribuirlo a esa
 * consulta la haría aparecer en el panel de fallos de una consulta que no hizo nada.
 */
function contextOf(caller: Caller | null, platform: PlatformCaller | null): FailureContext | null {
  if (caller !== null) {
    return {
      accountId: caller.accountId,
      practiceId: caller.practiceId,
      accountRole: caller.accountRole,
    };
  }
  if (platform !== null) {
    return { accountId: platform.subject, practiceId: null, accountRole: 'plataforma' };
  }
  // Las rutas sin `Authorization`: cuando llega la petición no se sabe quién llama, y no se
  // inventa un actor. Va por `medskin_record_anonymous_failure()`.
  return null;
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
