// La contraseña temporal. Dominio puro: sin base y sin HTTP.
//
// Lo que se fija aquí es la FORMA, porque la dicta una persona por teléfono y la teclea otra en
// un móvil, y lo que se le dice al usuario —«escribe los seis dígitos»— tiene que ser verdad.

import { describe, expect, it } from 'vitest';

import {
  mintTemporaryPassword,
  TEMPORARY_PASSWORD_DIGITS,
  TEMPORARY_PASSWORD_HOURS,
  temporaryPasswordExpiry,
} from './temporary-password';

describe('la contraseña temporal', () => {
  it('son SEIS DÍGITOS, y nada más que dígitos', () => {
    expect(TEMPORARY_PASSWORD_DIGITS).toBe(6);
    for (let i = 0; i < 500; i += 1) {
      expect(mintTemporaryPassword()).toMatch(/^\d{6}$/);
    }
  });

  it('usa el rango COMPLETO: los que empiezan por cero también salen', () => {
    // Sortear entre 100 000 y 999 999 dejaría fuera `000421` y el espacio real sería 900 000 en
    // vez de un millón. Con mil tiradas, que ninguna empiece por cero es prácticamente
    // imposible si el rango es completo (la probabilidad de fallar es (9/10)^1000).
    const tiradas = Array.from({ length: 1000 }, () => mintTemporaryPassword());
    expect(tiradas.some((p) => p.startsWith('0'))).toBe(true);
  });

  it('no repite lo mismo una y otra vez', () => {
    // No mide la calidad del generador —eso es `randomInt`, el criptográfico de Node—: caza el
    // error de haber dejado una constante donde iba el sorteo.
    const distintas = new Set(Array.from({ length: 200 }, () => mintTemporaryPassword()));
    expect(distintas.size).toBeGreaterThan(150);
  });

  it('caduca a las 72 horas exactas', () => {
    expect(TEMPORARY_PASSWORD_HOURS).toBe(72);
    const ahora = new Date('2026-11-03T13:12:00.000Z');
    expect(temporaryPasswordExpiry(ahora).toISOString()).toBe('2026-11-06T13:12:00.000Z');
  });
});
