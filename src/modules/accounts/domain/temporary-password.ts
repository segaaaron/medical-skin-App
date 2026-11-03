// La contraseña temporal · `cuentas.md`: 72 h, un solo uso, y «no se negocia por canal».
//
// SEIS DÍGITOS desde el 3 de noviembre de 2026, por decisión del dueño y para alinearla con el
// diseño: el código de recuperación ya son seis dígitos (`recuperacion.md`), y tener dos secretos
// que la persona teclea con dos formas distintas no ayuda a nadie.
//
// LO QUE HABÍA: `tejado-lila-07`, dos palabras de una lista cerrada y dos dígitos. Y LA RAZÓN POR
// LA QUE SE DEFENDIÓ ERA UN NÚMERO MAL CONTADO. El comentario anterior de este archivo decía
// «128 × 64 × 100 son 819 200 combinaciones», y era correcto; lo que estaba mal era el documento
// de traspaso, que al rechazar el cambio habló de «decenas de millones» frente al millón de seis
// dígitos. Contado:
//
//   tejado-lila-07   128 × 64 × 100 =     819 200   ·  19,6 bits
//   seis dígitos                    =   1 000 000   ·  19,9 bits
//
// Seis dígitos NO pierden entropía: ganan un 22 %. El cambio mejora lo que había, así que la
// objeción escrita no solo era ajena a quien decide: era falsa.
//
// QUÉ SOSTIENE ESTA CONTRASEÑA, que no es su forma y sigue siendo verdad con seis dígitos:
//   · vive 72 h y es de UN SOLO USO;
//   · adivinarla por la puerta del acceso cuesta 5 intentos cada 15 minutos por correo
//     (`acceso.md`), o sea unos 480 al día: con un millón de combinaciones, 2 850 años de media;
//   · ese contador cuenta igual para un correo que no existe, así que no se puede medir si el
//     correo es real antes de empezar;
//   · y lo que viaja a la base es su hash con argon2, nunca la contraseña.
// Si algún día el límite de intentos se relaja, esta cuenta deja de salir y la forma tiene que
// cambiar con él. Esa es la condición que importa, y no cuántos caracteres tiene.
//
// POR QUÉ SE DICTA IGUAL DE BIEN: seis dígitos se leen en voz alta sin deletrear y se teclean en
// el teclado numérico de un teléfono. Era el argumento a favor de las palabras, y los dígitos lo
// cumplen mejor: no hay que explicar cómo se escribe «turquesa» ni dónde van los guiones.

import { randomInt } from 'node:crypto';

/** «72 h y un solo uso. No se negocia por canal: la de WhatsApp y la de correo son la misma.» */
export const TEMPORARY_PASSWORD_HOURS = 72;

/** Seis, como el código de recuperación. La forma es del contrato, no de este archivo. */
export const TEMPORARY_PASSWORD_DIGITS = 6;

/**
 * `randomInt` y no `Math.random()`: es el generador criptográfico de Node y además reparte sin
 * el sesgo del módulo.
 *
 * Y se acuña sobre el rango COMPLETO —de 0 a 999 999— con ceros por delante, en vez de sortear
 * entre 100 000 y 999 999. Si no, `000421` nunca saldría y el espacio real serían 900 000
 * combinaciones en vez de un millón: un 10 % menos por un detalle de presentación.
 */
export function mintTemporaryPassword(): string {
  const total = 10 ** TEMPORARY_PASSWORD_DIGITS;
  return String(randomInt(0, total)).padStart(TEMPORARY_PASSWORD_DIGITS, '0');
}

/** Cuándo caduca una temporal acuñada ahora. La cota la comprueba además la base. */
export function temporaryPasswordExpiry(now: Date): Date {
  return new Date(now.getTime() + TEMPORARY_PASSWORD_HOURS * 60 * 60 * 1000);
}
