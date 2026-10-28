// Las reglas de la contraseña, en el dominio y sin NestJS: son la red de seguridad del
// servidor para lo que la app ya validó en el teléfono con las mismas reglas.
//
// `acceso.md`: 8 caracteres mínimo y la lista de las más usadas, SIN exigir
// mayúscula-número-símbolo. Nada de reglas de composición: producen `Password1!`.

import { ContractError } from '../../../shared/contract/error-catalog';
import { isCommonPassword } from './common-passwords';

export const MIN_LENGTH = 8;

/**
 * Lanza el error del contrato en el primer requisito que falle, en el orden en que la
 * pantalla los dibuja (`Arranque.dc.html` · 5): el largo primero, la lista después.
 *
 * El largo se cuenta en puntos de código y no en unidades UTF-16: ocho emojis son ocho
 * caracteres para quien los escribió, no cuatro.
 */
export function checkNewPassword(candidate: unknown): string {
  if (typeof candidate !== 'string' || [...candidate].length < MIN_LENGTH) {
    throw new ContractError('contrasena_corta');
  }
  if (isCommonPassword(candidate)) {
    throw new ContractError('contrasena_muy_usada');
  }
  return candidate;
}
