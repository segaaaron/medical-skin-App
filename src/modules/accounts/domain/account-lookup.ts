// `GET /v1/platform/accounts?correo=` · lo que se acepta de la query · `cuentas.md`, 31 oct 2026.
//
// LA DECISIÓN QUE DEFINE ESTE ARCHIVO, y es de una línea: **el correo es EXACTO, no un `ilike`.**
// Un `%paz%` sobre `account` devolvería un listado de personas de MedSkin con dos caracteres, y
// ahí dentro hay pacientes: ese es el padrón que §12.2.1 existe para cerrar. Con el correo
// completo, quien pregunta ya sabía a quién buscaba — que es exactamente la situación de soporte
// atendiendo a alguien que escribió pidiendo ayuda.
//
// Sin NestJS, sin Fastify y sin `pg`: esto se prueba sin levantar nada.

import { ContractError } from '../../../shared/contract/error-catalog';

const EMAIL_MAX = 254;
/**
 * La misma forma que el resto del borde: algo, una arroba, algo con un punto. No valida que el
 * dominio exista —eso no se puede saber sin mandar un correo— y no hace falta: lo que esto
 * descarta es la búsqueda parcial disfrazada de correo, que es el riesgo real aquí.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type AccountLookup = { email: string };

export function readAccountLookup(params: Record<string, unknown>): AccountLookup {
  const raw = params.correo;
  if (typeof raw !== 'string') throw new ContractError('cuerpo_no_valido', undefined, undefined, 'correo');

  const email = raw.trim().toLowerCase();
  if (email === '' || email.length > EMAIL_MAX || !EMAIL_SHAPE.test(email)) {
    throw new ContractError('cuerpo_no_valido', undefined, undefined, 'correo');
  }
  return { email };
}
