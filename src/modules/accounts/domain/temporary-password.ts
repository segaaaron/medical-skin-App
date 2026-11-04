// La contraseña temporal del alta: 6 dígitos, 72 h, un solo uso (`cuentas.md`).
// Es la contraseña con la que la persona entra la primera vez por POST /v1/access, en el campo
// `contrasena`. No es un PIN aparte: no hay otro endpoint.
//
// Son 6 dígitos desde el 3 de noviembre de 2026 (antes: `tejado-lila-07`). Espacio: 1 000 000.
//
// Lo que la hace segura no es su forma, es el límite de intentos: 5 cada 15 minutos por correo
// (`acceso.md`) son ~480 al día, o 2850 años de media para un millón de combinaciones. Ese
// contador cuenta igual para un correo que no existe. A la base va solo su hash de Argon2id.
// Si se relaja el límite de intentos, esta cuenta ya no sale y la forma tiene que cambiar.

import { randomInt } from 'node:crypto';

/** 72 h y un solo uso. Igual por WhatsApp que por correo: es la misma. */
export const TEMPORARY_PASSWORD_HOURS = 72;

/** Seis, igual que el código de recuperación. La forma la fija el contrato. */
export const TEMPORARY_PASSWORD_DIGITS = 6;

/**
 * `randomInt` (generador criptográfico de Node, sin sesgo de módulo) sobre el rango completo
 * 0–999 999, con ceros por delante. Sortear entre 100 000 y 999 999 daría 900 000 valores en
 * vez de un millón.
 */
export function mintTemporaryPassword(): string {
  const total = 10 ** TEMPORARY_PASSWORD_DIGITS;
  return String(randomInt(0, total)).padStart(TEMPORARY_PASSWORD_DIGITS, '0');
}

/** Cuándo caduca una temporal generada ahora. La base comprueba el límite otra vez. */
export function temporaryPasswordExpiry(now: Date): Date {
  return new Date(now.getTime() + TEMPORARY_PASSWORD_HOURS * 60 * 60 * 1000);
}
