// EL SOBRE DE LA RESPUESTA · una sola forma para los 105 endpoints.
//
// Decidido el 30 de octubre de 2026. Hasta hoy el éxito devolvía el objeto pelado y el error
// sí tenía forma fija, así que había DOS contratos de respuesta y solo uno estaba escrito.
// Eso costaba tres cosas concretas, y ninguna es de estilo:
//
//   1. NO HABÍA DÓNDE PONER LA TRAZA. El servidor genera un `requestId` y un `traceId` por
//      petición, los escribe en `service_failure`… y no se los decía a nadie. Cuando una app
//      reportaba un fallo no había identificador que cruzar con la bitácora: se buscaba por
//      hora y a ojo. Ahora vuelve en `meta` y en la cabecera `X-Request-Id`.
//   2. NO HABÍA RELOJ DEL SERVIDOR. Esta API devuelve pausas y caducidades —`pausa_hasta`,
//      `token_caduca_en`, `caduca_en`— que la app compara contra SU reloj. Un teléfono con la
//      hora mal mostraba «puedes volver a entrar a las 10:29» cuando ya podía. `servidor_en`
//      le da la referencia para corregirlo.
//   3. LA APP LLEVABA DOS DECODIFICADORES. Uno para el éxito y otro para el error, y la
//      decisión de cuál usar salía del código HTTP. Ahora las dos formas comparten `meta`.
//
// POR QUÉ UN INTERCEPTOR Y NO UN CAMPO MÁS EN CADA CASO DE USO. El sobre es asunto del
// TRANSPORTE: quién pidió esto, a qué hora, en qué región. Un caso de uso que lo rellenara
// estaría sabiendo que lo llaman por HTTP, y hoy no lo sabe —por eso se prueban sin levantar
// nada—. Aquí no se toca un solo caso de uso ni un solo controlador: el sobre se pone al
// salir, que es donde se pone un sobre.
//
// Y NO ENVUELVE DOS VECES. Un cuerpo que ya trae `datos` se devuelve tal cual: así un
// endpoint que algún día necesite su propia forma puede tenerla sin pelear con esto.

import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import type { Region } from '../contract/session';
import type { RequestWithContext } from './request-context';

/** Lo que acompaña a TODA respuesta, de éxito y de error. */
export type ResponseMeta = {
  /** Único por petición. Es el que hay que dar al reportar un fallo. */
  peticion_id: string;
  /**
   * El de la traza, que llega en `X-Request-Id` y se conserva. Si el cliente no lo manda,
   * es el mismo que `peticion_id`: así una app puede correlacionar una cadena de llamadas
   * suyas sin que el servidor invente un segundo identificador.
   */
  traza_id: string;
  /** La hora del servidor, en ISO 8601 con desfase. La referencia de los plazos. */
  servidor_en: string;
  /** El despliegue que contestó. Una app que apunte a la región equivocada lo ve aquí. */
  region: Region;
};

export type Envelope<T> = { datos: T; meta: ResponseMeta };

export function metaOf(req: RequestWithContext, region: Region, now: Date): ResponseMeta {
  const ctx = req.medskin;
  return {
    peticion_id: ctx?.requestId ?? 'sin-peticion',
    traza_id: ctx?.traceId ?? ctx?.requestId ?? 'sin-traza',
    servidor_en: now.toISOString(),
    region,
  };
}

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly region: Region) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<RequestWithContext>();
    const res = http.getResponse<FastifyReply>();

    return next.handle().pipe(
      map((body: unknown) => {
        const meta = metaOf(req, this.region, new Date());

        // La traza también por cabecera: una app que falla al decodificar el cuerpo —o un
        // 204 sin cuerpo— sigue teniendo con qué buscar en la bitácora.
        void res.header('X-Request-Id', meta.peticion_id);

        // Un cuerpo vacío no se envuelve: un 204 con `{datos: undefined}` es peor que un 204.
        if (body === undefined || body === null) return body;

        // Ya viene envuelto: se respeta. No se envuelve un sobre dentro de otro.
        if (typeof body === 'object' && 'datos' in body && 'meta' in body) return body;

        return { datos: body, meta } satisfies Envelope<unknown>;
      }),
    );
  }
}
