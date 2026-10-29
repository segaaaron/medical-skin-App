// El contexto de inquilino, fijado por TRANSACCIÓN. Es la regla 2 de §7.3 y la única que
// no se rompe nunca:
//
//   `set_config(..., true)` y `SET LOCAL ROLE` se deshacen en el COMMIT. Un `SET` de
//   sesión no: detrás de PgBouncer en modo transacción se queda pegado a la conexión del
//   servidor y lo hereda el siguiente client que la reutiliza. Eso es una fuga de datos
//   entre doctoras, y está medida. `isolation.spec.ts` la reproduce a propósito contra
//   el pooler del 6432 para que nadie tenga que creérselo.
//
// Por eso este archivo es la ÚNICA puerta a la base desde la aplicación: adopta el rol y
// fija los dos contextos en la misma llamada, dentro de la misma transacción. Si se
// olvidara uno, se habrían olvidado los tres, y sin rol adoptado la conexión `medskin`
// —que es NOINHERIT y sin grants directos— no puede leer ni escribir nada. Falla cerrada.

import type { Pool, PoolClient } from 'pg';

// Los cinco roles de la migración. Ninguno con SUPERUSER ni con BYPASSRLS.
export const DB_ROLES = [
  'app_practitioner',
  'app_patient',
  'app_platform',
  'app_anonymous',
  'app_account',
] as const;
export type DbRole = (typeof DB_ROLES)[number];

export type TenantContext = {
  role: DbRole;
  /** `medskin.practice_id`. Solo doctora y equipo. */
  practiceId?: string | null;
  /** `medskin.account_id`. Los cuatro roles con sesión. `app_anonymous` no lo fija. */
  accountId?: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validUuid(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (!UUID.test(value)) throw new Error(`Contexto de inquilino inválido: ${field} no es un uuid.`);
  return value;
}

/**
 * Comprueba el contexto contra la tabla de _convenciones.md antes de abrir nada. El rol
 * NO se puede parametrizar en `SET LOCAL ROLE`, así que se valida contra la lista cerrada:
 * es el único sitio donde un nombre entra en el SQL por texto y por eso es el único que
 * tiene que estar cerrado con llave.
 */
function checkedContext(ctx: TenantContext): { role: DbRole; practiceId: string; accountId: string } {
  if (!DB_ROLES.includes(ctx.role)) throw new Error(`Rol de base desconocido: ${String(ctx.role)}`);

  const practiceId = validUuid(ctx.practiceId, 'practiceId');
  const accountId = validUuid(ctx.accountId, 'accountId');

  // `app_anonymous` es el rol de las peticiones SIN sesión: `POST /v1/access`, los dos de
  // recuperación y `POST /v1/session/refresh`. Cuando llegan no hay ni inquilino ni cuenta
  // que fijar, así que no fija ninguno de los dos contextos —y se rechaza que lo intente:
  // un `account_id` puesto aquí sería un identificador que nadie ha probado todavía, y
  // habilitaría políticas por fila con el único rol que no debería disparar ninguna. No
  // tiene un solo privilegio de tabla; lo único que puede hacer es ejecutar las funciones
  // `SECURITY DEFINER` del acceso, que validan sus argumentos y devuelven el veredicto.
  if (ctx.role === 'app_anonymous') {
    if (practiceId || accountId) {
      throw new Error('app_anonymous no fija ningún contexto: cuando llega la petición no hay sesión.');
    }
    return { role: ctx.role, practiceId: '', accountId: '' };
  }

  if (!accountId) throw new Error(`El rol ${ctx.role} exige accountId: toda petición autenticada lo fija.`);
  // `app_account` es el rol del token que NO dice qué es la persona: el de recuperación
  // (§ migración 0013). Sus políticas son las tres por `account_id` —`account`,
  // `credential`, `session`— más el `SELECT` de `patient_link`, y nada clínico ni de
  // ninguna consulta. Por eso no fija `practice_id`: cuando llega no se sabe si hay uno, y
  // un `practice_id` adivinado sería una lectura que ese token no autoriza.
  if (ctx.role === 'app_account' && practiceId) {
    throw new Error('app_account no fija practiceId: su token no dice a qué consulta pertenece quien llama.');
  }
  if (ctx.role === 'app_practitioner' && !practiceId) {
    throw new Error('app_practitioner exige practiceId: sus políticas se leen por inquilino.');
  }
  // La paciente no es de un inquilino: su cuenta se vincula a N fichas (§12.2.1). Fijarle
  // un `practice_id` le daría una lectura que su rol no tiene y que ningún contrato pide.
  if (ctx.role === 'app_patient' && practiceId) {
    throw new Error('app_patient no fija practiceId: la paciente no pertenece a ningún inquilino.');
  }
  // Y `app_platform` tampoco, que era la única puerta de esta casa sin cerradura. La
  // consola NO es un inquilino: sus políticas son `current_user = 'app_platform'` y
  // NINGUNA lee `medskin.practice_id`, así que un `practice_id` puesto aquí afirmaría una
  // atribución que ninguna política comprueba. Cuando la consola necesita una consulta
  // concreta, la pasa como ARGUMENTO explícito y la función la valida: es la forma de
  // `medskin_create_practice_owner(p_practice_id, …)` y de
  // `medskin_platform_practice_stats(p_practice_id)`, y las dos son así por esto.
  if (ctx.role === 'app_platform' && practiceId) {
    throw new Error('app_platform no fija practiceId: la consola no es un inquilino y ninguna de sus políticas lo lee.');
  }

  return { role: ctx.role, practiceId: practiceId ?? '', accountId };
}

/**
 * Abre una transacción, adopta el rol y fija los dos contextos con alcance de transacción.
 * Al salir hace COMMIT, o ROLLBACK si `work` lanza. El contexto y el rol mueren ahí:
 * la siguiente transacción de esa misma conexión empieza sin nada.
 */
export async function withTenantContext<T>(
  pool: Pool,
  ctx: TenantContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const { role, practiceId, accountId } = checkedContext(ctx);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    // LOCAL: se deshace en el COMMIT. Nunca `SET ROLE` a secas.
    await client.query(`SET LOCAL ROLE ${role}`);
    // Los dos siempre, aunque uno vaya vacío: `nullif(..., '')` lo convierte en NULL
    // dentro de las funciones de política, y NULL no es igual a nada.
    await client.query(
      `SELECT set_config('medskin.practice_id', $1, true),
              set_config('medskin.account_id', $2, true)`,
      [practiceId, accountId],
    );

    const result = await work(client);
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (failure) {
    try {
      await client.query('ROLLBACK');
      client.release();
    } catch (rollbackFailure) {
      // Nunca se traga un fallo (§10.3, regla 5). La conexión se destruye en vez de volver
      // al pool con una transacción abierta, y los dos fallos viajan juntos.
      client.release(rollbackFailure as Error);
      throw new AggregateError(
        [failure, rollbackFailure],
        'La transacción falló y el ROLLBACK tampoco pasó: la conexión se descartó.',
      );
    }
    throw failure;
  }
}
