// El repositorio de la recuperación. La ÚNICA puerta a la base es `withTenantContext()`,
// y aquí siempre con `app_anonymous`: cuando llegan estas peticiones no hay sesión, así que
// no hay ni inquilino ni cuenta que fijar.
//
// `app_anonymous` NO TIENE UN SOLO PRIVILEGIO DE TABLA. No puede leer `account`, no puede
// leer `recovery_code` y no puede escribir en ninguna: lo único que puede hacer es ejecutar
// estas tres funciones `SECURITY DEFINER`, que validan sus argumentos y devuelven el
// veredicto y nunca la fila. Con él no se puede enumerar correos ni por error de
// programación, porque no hay consulta que escribir.
//
// Consultas parametrizadas sin excepción (OWASP A03).

import type { Pool } from 'pg';

import { FAILURE_PHRASES, ServiceFailure } from '../../../shared/contract/error-catalog';
import { withTenantContext } from '../../../shared/db/tenant-context';
import type { CodeVerdict } from '../domain/code';
import type { LiveCode, RecoveryCodePort } from '../domain/ports';

type LiveRow = {
  verdict: string;
  account_id: string | null;
  role: string | null;
  code_hash: string;
  expires_at: Date;
  attempts_left: number;
  voided_reason: string | null;
};

export class RecoveryRepository implements RecoveryCodePort {
  constructor(private readonly pool: Pool) {}

  async mint(p: { email: string; codeHash: string; expiresAt: Date }): Promise<boolean> {
    return withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<{ medskin_recovery_mint: boolean }>(
        'select medskin_recovery_mint($1, $2, $3)',
        [p.email, p.codeHash, p.expiresAt],
      );
      // El booleano no sale del servidor: decide si hay correo que escribir, y nada más.
      return rows[0]?.medskin_recovery_mint === true;
    });
  }

  async live(email: string): Promise<LiveCode> {
    return withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<LiveRow>('select * from medskin_recovery_live($1)', [email]);
      const row = rows[0];
      // La función devuelve SIEMPRE una fila y SIEMPRE un hash —el real o el del señuelo—.
      // Si no, el señuelo no está sembrado, y servir esto sin él abriría el oráculo del
      // reloj: antes un 500 con su causa que un 401 que llega más rápido.
      if (row === undefined || !row.code_hash) {
        throw new ServiceFailure(
          FAILURE_PHRASES.checkRecoveryCode,
          new Error('medskin_recovery_live no devolvió fila o devolvió sin hash señuelo'),
        );
      }
      // `role` se descarta aquí mismo, a la vista. La función lo devuelve y el token de
      // recuperación NO LLEVA ROL: «el código va antes de saber el rol». Que no salga de
      // este archivo es la mitad de que no salga del servidor.
      return {
        verdict: row.verdict as CodeVerdict,
        accountId: row.account_id,
        codeHash: row.code_hash,
        expiresAt: row.expires_at,
        attemptsLeft: row.attempts_left,
        voidedReason: row.voided_reason,
      };
    });
  }

  async miss(email: string): Promise<void> {
    await withTenantContext(this.pool, { role: 'app_anonymous' }, (c) =>
      c.query('select * from medskin_recovery_miss($1)', [email]),
    );
  }
}
