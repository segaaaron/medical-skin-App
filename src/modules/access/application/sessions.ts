// Los cuatro endpoints de sesión de `acceso.md`. Tres verbos pequeños sobre el mismo
// puerto, en un archivo: cada uno es su propia clase porque son tres actos distintos con
// tres respuestas distintas, y están juntos porque ninguno pasa de diez líneas.
//
// En los tres, la fila se encuentra por `account_id` del token bajo la política de
// `session`, nunca por un id del cliente sin comprobar. Un `sesion_id` de otra cuenta no
// borra ninguna fila, y el endpoint lo cuenta como `404`.

import { ContractError } from '../../../shared/contract/error-catalog';
import type { ClockPort, OwnerOfSessions, SessionPort } from '../domain/ports';
import type { Caller } from './caller';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ownerOf(caller: Caller): OwnerOfSessions {
  return {
    accountId: caller.accountId,
    practiceId: caller.practiceId,
    accountRole: caller.accountRole,
  };
}

/**
 * DELETE /v1/acceso · cerrar sesión en este teléfono. Cerrar lo ya cerrado devuelve 200.
 *
 * `caller` nulo es quien llega con un token de RECUPERACIÓN: ese token no lleva `sid`
 * porque todavía no hay sesión (`recuperacion.md`), así que no hay fila que revocar y el
 * 200 es el mismo. `sesion.md`, 27 de octubre: este endpoint lo abre cualquier alcance,
 * los tres restringidos incluidos, porque «cerrar tu propia sesión no es un privilegio: es
 * lo contrario», y porque es la única salida de «Crea tu contraseña», que no tiene atrás.
 */
export class SignOut {
  constructor(
    private readonly sessions: SessionPort,
    private readonly clock: ClockPort,
  ) {}

  async run(caller: Caller | null): Promise<{ cerrada_en: string }> {
    if (caller !== null) await this.sessions.revokeOne(ownerOf(caller), caller.sessionId);
    return { cerrada_en: this.clock.now().toISOString() };
  }
}

export type ListedSession = {
  id: string;
  esta: boolean;
  dispositivo: string | null;
  sistema: string | null;
  app: string | null;
  ciudad: string | null;
  entro_en: string;
  ultima_vez: string;
};

/** GET /v1/acceso/sesiones · las sesiones activas de MI cuenta. */
export class ListSessions {
  constructor(private readonly sessions: SessionPort) {}

  async run(caller: Caller): Promise<{ cuantas: number; sesiones: ListedSession[] }> {
    const rows = await this.sessions.list(ownerOf(caller));
    return {
      cuantas: rows.length,
      sesiones: rows.map((s) => ({
        id: s.id,
        esta: s.id === caller.sessionId,
        dispositivo: s.model,
        sistema: s.os,
        app: s.appVersion,
        // `ciudad` y nada más fino: una dirección exacta es un dato de localización de
        // quien va a una clínica de estética.
        ciudad: s.city,
        entro_en: s.signedInAt.toISOString(),
        ultima_vez: s.lastSeenAt.toISOString(),
      })),
    };
  }
}

/** DELETE /v1/acceso/sesiones/{sesion_id} · cerrar una concreta. */
export class CloseSession {
  constructor(private readonly sessions: SessionPort) {}

  // `{ "cerradas": 1 }`, el mismo cuerpo que su hermano sin `id` (decisión 25, 27 de
  // octubre de 2026): un solo decodificador en la app para los dos endpoints.
  async run(sessionId: string, caller: Caller): Promise<{ cerradas: number }> {
    if (sessionId === caller.sessionId) throw new ContractError('es_esta_sesion');
    // Un id que no es un uuid no es de esta cuenta, así que responde lo mismo que uno
    // inventado: el 404 cubre los dos casos a propósito y no se consulta nada.
    if (!UUID.test(sessionId)) throw new ContractError('sesion_no_existe');

    const closed = await this.sessions.revokeOne(ownerOf(caller), sessionId);
    if (!closed) throw new ContractError('sesion_no_existe');
    return { cerradas: 1 };
  }
}

/** DELETE /v1/acceso/sesiones · todas menos la actual. */
export class CloseOtherSessions {
  constructor(private readonly sessions: SessionPort) {}

  async run(caller: Caller): Promise<{ cerradas: number }> {
    return { cerradas: await this.sessions.revokeOthers(ownerOf(caller), caller.sessionId) };
  }
}
