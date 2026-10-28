// La cabecera `Idempotency-Key`, leída una vez y en un sitio.
//
// ES OBLIGATORIA, y antes no lo era: los cuatro controladores hacían `if (key !== null)` y
// **sin cabecera el mecanismo entero se apagaba en silencio** mientras la petición se
// atendía igual. `_convenciones.md` la exige en «todo `POST` que crea algo» y `cuentas.md`
// lo dice con el motivo: «es obligatorio: la pantalla es una carga que bloquea». Una
// promesa del contrato que el servidor no comprueba no es una promesa.
//
// El `400 clave_idempotencia_faltante` va **con `mensaje` vacío**, como `ruta_no_existe` y
// `formato_no_admitido`: una cabecera que falta es un error DE LA APP, y no hay nada que
// contarle a una persona que no puede hacer nada al respecto. Lo que no puede faltar es el
// código, para que la app lo registre y nosotros lo veamos.

import { createHash } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import { ContractError } from '../contract/error-catalog';

/** Una cabecera es entrada del cliente: se acota antes de convertirla en clave (OWASP A03). */
export const KEY_MAX_LENGTH = 120;

/** `(Idempotency-Key, cuerpo hasheado)` de `_convenciones.md`. La cuenta la pone el repositorio. */
export type IdempotencyRecord = {
  key: string;
  bodyHash: string;
};

/**
 * La clave de la petición, o el `400`. Lo usan los cuatro `POST` que crean algo, y por eso
 * vive aquí: estaba copiado idéntico en cuatro controladores, que es la forma más fácil de
 * que uno de los cuatro se quede atrás.
 */
export function readIdempotencyKey(req: FastifyRequest, body: unknown): IdempotencyRecord {
  const header = req.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  const key = value === undefined ? '' : value.trim().slice(0, KEY_MAX_LENGTH);
  if (key === '') throw new ContractError('clave_idempotencia_faltante');
  return { key, bodyHash: fingerprintOf(body) };
}

/**
 * El cuerpo hasheado: la misma clave con otro cuerpo es un `409`.
 *
 * **Las claves van ordenadas**, y es la única implementación que queda: había dos —una
 * ordenaba y la otra no—, así que el mismo cuerpo con las claves en otro orden era «otra
 * petición» en un endpoint y la misma en el otro. Un cliente que serializa su JSON en otro
 * orden entre dos reintentos es plausible, y lo que recibiría es un `409` por una petición
 * idéntica.
 */
export function fingerprintOf(body: unknown): string {
  return createHash('sha256').update(stableJson(body)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
  return `{${entries.join(',')}}`;
}
