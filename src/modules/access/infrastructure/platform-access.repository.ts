// El repositorio de la entrada de consola. Dos llamadas y nada más, las dos con
// `app_anonymous`: cuando llega la petición no se sabe quién llama, y ese rol no tiene
// `SELECT` sobre ninguna tabla — su único privilegio es ejecutar estas dos funciones.
//
// `platform_account` no se consulta directamente desde aquí ni desde ningún sitio: va con
// `FORCE ROW LEVEL SECURITY` y su única política es la de su dueña. Lo que se puede leer es
// lo que la función devuelve, y la función devuelve lo mínimo para decidir.

import type { Pool } from 'pg';

import { FAILURE_PHRASES, ServiceFailure } from '../../../shared/contract/error-catalog';
import { withTenantContext } from '../../../shared/db/tenant-context';
import type { PlatformCredential, PlatformCredentialPort } from '../domain/platform-credential';

type PlatformCredentialRow = {
  platform_account_id: string | null;
  label: string | null;
  permissions: string[] | null;
  status: string | null;
  hash: string;
  locked_until: Date | null;
  attempts_left: number;
};

export class PlatformAccessRepository implements PlatformCredentialPort {
  constructor(private readonly pool: Pool) {}

  async read(email: string): Promise<PlatformCredential> {
    return withTenantContext(this.pool, { role: 'app_anonymous' }, async (c) => {
      const { rows } = await c.query<PlatformCredentialRow>(
        'select * from medskin_platform_credential($1)',
        [email],
      );
      const row = rows[0];
      // Una fila y un hash, siempre. Si no, el señuelo no está sembrado y la entrada no se
      // puede servir sin abrir el oráculo del reloj: antes un 500 con su causa que un 401
      // que llega más rápido.
      if (rows.length !== 1 || row === undefined || !row.hash) {
        throw new ServiceFailure(
          FAILURE_PHRASES.platformSignIn,
          new Error(
            `medskin_platform_credential devolvió ${rows.length} filas o sin hash señuelo`,
          ),
        );
      }
      return {
        platformAccountId: row.platform_account_id,
        label: row.label,
        permissions: row.permissions,
        status: row.status,
        hash: row.hash,
        lockedUntil: row.locked_until,
        attemptsLeft: row.attempts_left,
      };
    });
  }

  async recordAttempt(email: string, matched: boolean): Promise<void> {
    await withTenantContext(this.pool, { role: 'app_anonymous' }, (c) =>
      c.query('select * from medskin_platform_attempt($1, $2)', [email, matched]),
    );
  }
}
