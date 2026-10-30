// Argon2id · lo que pasa cuando el hash guardado NO se puede leer.
//
// La respuesta tiene que seguir siendo `false` —un hash corrupto es indistinguible de una
// contraseña mal, y si no lo fuera, el 500 diría qué cuenta tiene la credencial rota— y a
// la vez el caso tiene que ser VISIBLE: con `false` y silencio, una credencial con el hash
// roto da `acceso_no_coincide` para siempre y nadie se entera. La persona no puede entrar y
// tampoco recuperar si su temporal nunca se estrenó.
//
// Lo que se comprueba del aviso es su CONTENIDO: que nombra la cuenta y que no lleva el
// hash. Que se llamara a algo no probaría nada.

import { describe, expect, it } from 'vitest';

import type { Failure } from '../failures/service-failure';
import { ARGON2_COST, Argon2Passwords, type FailureSink } from './passwords';

const CUENTA = {
  accountId: '99999999-9999-4999-8999-999999999999',
  practiceId: '22222222-2222-4222-8222-222222222222',
  accountRole: 'patient' as const,
};

// Un Argon2id con la forma buena y el contenido roto: la salida es más corta de lo que
// dicen sus propios parámetros, que es exactamente lo que deja un volcado a medias.
const HASH_ROTO = `$argon2id$v=19$m=${ARGON2_COST.memoryCost},p=1,t=2$QUJDREVGR0hJSktM$QUJD`;

function conRegistro(): { passwords: Argon2Passwords; avisos: Failure[] } {
  const avisos: Failure[] = [];
  const sink: FailureSink = {
    record: (failure) => {
      avisos.push(failure);
      return Promise.resolve();
    },
  };
  return { passwords: new Argon2Passwords(sink), avisos };
}

/** Toda la cadena de causas en texto, que es lo que acaba en `service_failure`. */
function causeMessages(cause: unknown): string[] {
  const chain: string[] = [];
  let current: unknown = cause;
  while (current instanceof Error) {
    chain.push(`${current.name}: ${current.message}\n${current.stack ?? ''}`);
    current = current.cause;
  }
  return chain;
}

/** El registro no se espera —no puede cambiar lo que tarda el 401—, así que se le cede. */
const dejarCorrerElAviso = (): Promise<void> => new Promise((listo) => setImmediate(listo));

describe('Argon2Passwords · un hash que no se puede leer', () => {
  it('devuelve `false`, como una contraseña mal, y deja un aviso con la cuenta', async () => {
    const { passwords, avisos } = conRegistro();

    expect(await passwords.verify(HASH_ROTO, 'la-que-sea', CUENTA)).toBe(false);
    await dejarCorrerElAviso();

    const aviso = avisos[0];
    expect(avisos).toHaveLength(1);
    expect(aviso?.severity).toBe('warning');
    expect(aviso?.operation).toBe('argon2.verify');
    expect(aviso?.context?.accountId).toBe(CUENTA.accountId);
  });

  it('el aviso NO lleva el hash, ni en el mensaje ni en la cadena de causas', async () => {
    const { passwords, avisos } = conRegistro();
    await passwords.verify(HASH_ROTO, 'la-que-sea', CUENTA);
    await dejarCorrerElAviso();

    const aviso = avisos[0];
    const escrito = JSON.stringify({
      ...aviso,
      cause: causeMessages(aviso?.cause),
    });
    expect(escrito).not.toContain('$argon2id$');
    expect(escrito).not.toContain('la-que-sea');
  });

  it('sin cuenta que nombrar no se registra nada: ese hash es el del señuelo', async () => {
    const { passwords, avisos } = conRegistro();

    expect(await passwords.verify(HASH_ROTO, 'la-que-sea')).toBe(false);
    await dejarCorrerElAviso();

    expect(avisos).toEqual([]);
  });

  it('una contraseña que simplemente no coincide no es un fallo de servicio', async () => {
    const { passwords, avisos } = conRegistro();
    const hash = await passwords.hash('cometa-nieve-11');

    expect(await passwords.verify(hash, 'otra-cosa', CUENTA)).toBe(false);
    expect(await passwords.verify(hash, 'cometa-nieve-11', CUENTA)).toBe(true);
    await dejarCorrerElAviso();

    expect(avisos).toEqual([]);
  });
});
