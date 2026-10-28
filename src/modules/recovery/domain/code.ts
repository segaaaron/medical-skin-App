// Las reglas del código de recuperación, en el dominio y sin NestJS, sin Fastify y sin
// `pg`: se prueban sin levantar nada.
//
// `recuperacion.md`: seis dígitos, diez minutos de vida, un solo uso, cinco intentos, y
// reenvío no antes de 45 segundos.

import { randomInt } from 'node:crypto';

import { ContractError } from '../../../shared/contract/error-catalog';

export const CODE_DIGITS = 6;
export const CODE_LIFETIME_MINUTES = 10;
export const RESEND_AFTER_SECONDS = 45;

/** «5 intentos por código. Al quinto el código se anula y hay que pedir otro.» */
export const ATTEMPTS_PER_CODE = 5;

/** «Más de 5 peticiones en una hora para ese correo, o más de 20 por IP.» */
export const REQUESTS_PER_EMAIL_PER_HOUR = 5;
export const REQUESTS_PER_IP_PER_HOUR = 20;

/** «Más de 20 intentos por IP en 10 min.» */
export const ATTEMPTS_PER_IP = 20;

/**
 * Seis dígitos de `randomInt`, que es el generador criptográfico de Node y además no tiene
 * el sesgo del módulo: un `% 1000000` sobre bytes crudos reparte mal los últimos valores,
 * y aquí el espacio es de un millón, así que el sesgo es gratis para quien adivina.
 */
export function mintCode(): string {
  return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
}

// Una comprobación de FORMA, no de existencia: dice que la cadena no tiene forma de
// correo, y eso se puede saber sin consultar nada. Es lo que permite que
// `400 correo_mal_escrito` no rompa la regla de la respuesta idéntica (`recuperacion.md`).
// 254 es el largo máximo de una dirección en el RFC 5321, y acotarlo importa porque esta
// cadena entra en la frase del 202 y en una clave de Redis.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const EMAIL_MAX_LENGTH = 254;

/** El correo normalizado, o el error del contrato. Nunca consulta nada. */
export function readEmail(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ContractError('correo_vacio');
  const email = value.trim().toLowerCase();
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL.test(email)) {
    throw new ContractError('correo_mal_escrito');
  }
  return email;
}

/**
 * Los seis dígitos en UNA sola cadena, no en seis casillas: «seis cajas rompen pegar y el
 * autorrelleno que iOS ofrece desde el teclado al llegar el correo».
 *
 * El orden de los dos errores es el de la pantalla: primero si están los seis, después si
 * son números. Se quitan los espacios porque pegar desde el correo los trae.
 */
export function readCode(value: unknown): string {
  const code = typeof value === 'string' ? value.replace(/\s/g, '') : '';
  if (code.length < CODE_DIGITS) throw new ContractError('codigo_incompleto');
  if (!/^\d+$/.test(code) || code.length > CODE_DIGITS) {
    throw new ContractError('codigo_no_es_numero');
  }
  return code;
}

export type CodeVerdict = 'live' | 'expired' | 'voided';

/**
 * EL VEREDICTO DE UN CORREO QUE NO TIENE CUENTA, y es la pieza que cierra el último
 * oráculo de este flujo.
 *
 * `medskin_recovery_live()` devuelve `live` con el señuelo cuando no hay cuenta y cuando
 * no hay código: no tiene fila que caducar ni que anular. Si el endpoint se quedara ahí,
 * los dos 410 del contrato solo le saldrían a los correos reales, y entonces el CÓDIGO DE
 * ESTADO diría si un correo existe —que es exactamente lo que `_convenciones.md` prohíbe
 * «ni con el código de estado, ni con la frase, ni con el tiempo de respuesta»—. Bastaría
 * pedir un código, gastar cinco intentos y mirar si el sexto responde 410 o 401.
 *
 * Así que para el señuelo el veredicto se reconstruye con lo único que cuenta igual exista
 * o no la cuenta: los contadores de Redis.
 *   · cinco intentos gastados      → `voided`, igual que el código real al quinto;
 *   · se pidió un código y ya no está vivo → `expired`, igual que el real a los 10 min;
 *   · en cualquier otro caso       → `live`, y la comparación contra el señuelo falla.
 */
export function verdictForUnknownAccount(history: {
  attemptsSpent: number;
  /** Hay marca de código vivo para este correo: se pidió uno hace menos de 10 minutos. */
  codeIsLive: boolean;
  /** Se pidió algún código en la última hora. */
  codeWasAsked: boolean;
}): CodeVerdict {
  if (history.attemptsSpent >= ATTEMPTS_PER_CODE) return 'voided';
  if (!history.codeIsLive && history.codeWasAsked) return 'expired';
  return 'live';
}
