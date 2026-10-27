// El contexto de inquilino, fijado por TRANSACCIÓN. Es la regla 2 de §7.3 y la única que
// no se rompe nunca:
//
//   `set_config(..., true)` y `SET LOCAL ROLE` se deshacen en el COMMIT. Un `SET` de
//   sesión no: detrás de PgBouncer en modo transacción se queda pegado a la conexión del
//   servidor y lo hereda el siguiente cliente que la reutiliza. Eso es una fuga de datos
//   entre doctoras, y está medida. `aislamiento.spec.ts` la reproduce a propósito contra
//   el pooler del 6432 para que nadie tenga que creérselo.
//
// Por eso este archivo es la ÚNICA puerta a la base desde la aplicación: adopta el rol y
// fija los dos contextos en la misma llamada, dentro de la misma transacción. Si se
// olvidara uno, se habrían olvidado los tres, y sin rol adoptado la conexión `medskin`
// —que es NOINHERIT y sin grants directos— no puede leer ni escribir nada. Falla cerrada.

import type { Pool, PoolClient } from 'pg';

// Los tres roles de la migración. Ninguno con SUPERUSER ni con BYPASSRLS.
export const ROLES_DE_BASE = ['app_doctora', 'app_paciente', 'app_plataforma'] as const;
export type RolDeBase = (typeof ROLES_DE_BASE)[number];

export type ContextoInquilino = {
  rol: RolDeBase;
  /** `medskin.practice_id`. Solo doctora y equipo. */
  practiceId?: string | null;
  /** `medskin.cuenta_id`. Los tres roles. */
  cuentaId?: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidValido(valor: string | null | undefined, campo: string): string | null {
  if (valor === undefined || valor === null || valor === '') return null;
  if (!UUID.test(valor)) throw new Error(`Contexto de inquilino inválido: ${campo} no es un uuid.`);
  return valor;
}

/**
 * Comprueba el contexto contra la tabla de _convenciones.md antes de abrir nada. El rol
 * NO se puede parametrizar en `SET LOCAL ROLE`, así que se valida contra la lista cerrada:
 * es el único sitio donde un nombre entra en el SQL por texto y por eso es el único que
 * tiene que estar cerrado con llave.
 */
function contextoComprobado(ctx: ContextoInquilino): { rol: RolDeBase; practiceId: string; cuentaId: string } {
  if (!ROLES_DE_BASE.includes(ctx.rol)) throw new Error(`Rol de base desconocido: ${String(ctx.rol)}`);

  const practiceId = uuidValido(ctx.practiceId, 'practiceId');
  const cuentaId = uuidValido(ctx.cuentaId, 'cuentaId');

  if (!cuentaId) throw new Error(`El rol ${ctx.rol} exige cuentaId: toda petición autenticada lo fija.`);
  if (ctx.rol === 'app_doctora' && !practiceId) {
    throw new Error('app_doctora exige practiceId: sus políticas se leen por inquilino.');
  }
  // La paciente no es de un inquilino: su cuenta se vincula a N fichas (§12.2.1). Fijarle
  // un `practice_id` le daría una lectura que su rol no tiene y que ningún contrato pide.
  if (ctx.rol === 'app_paciente' && practiceId) {
    throw new Error('app_paciente no fija practiceId: la paciente no pertenece a ningún inquilino.');
  }

  return { rol: ctx.rol, practiceId: practiceId ?? '', cuentaId };
}

/**
 * Abre una transacción, adopta el rol y fija los dos contextos con alcance de transacción.
 * Al salir hace COMMIT, o ROLLBACK si `trabajo` lanza. El contexto y el rol mueren ahí:
 * la siguiente transacción de esa misma conexión empieza sin nada.
 */
export async function enContextoDeInquilino<T>(
  pool: Pool,
  ctx: ContextoInquilino,
  trabajo: (cliente: PoolClient) => Promise<T>,
): Promise<T> {
  const { rol, practiceId, cuentaId } = contextoComprobado(ctx);
  const cliente = await pool.connect();

  try {
    await cliente.query('BEGIN');
    // LOCAL: se deshace en el COMMIT. Nunca `SET ROLE` a secas.
    await cliente.query(`SET LOCAL ROLE ${rol}`);
    // Los dos siempre, aunque uno vaya vacío: `nullif(..., '')` lo convierte en NULL
    // dentro de las funciones de política, y NULL no es igual a nada.
    await cliente.query(
      `SELECT set_config('medskin.practice_id', $1, true),
              set_config('medskin.cuenta_id', $2, true)`,
      [practiceId, cuentaId],
    );

    const resultado = await trabajo(cliente);
    await cliente.query('COMMIT');
    cliente.release();
    return resultado;
  } catch (fallo) {
    try {
      await cliente.query('ROLLBACK');
      cliente.release();
    } catch (falloAlDeshacer) {
      // Nunca se traga un fallo (§10.3, regla 5). La conexión se destruye en vez de volver
      // al pool con una transacción abierta, y los dos fallos viajan juntos.
      cliente.release(falloAlDeshacer as Error);
      throw new AggregateError(
        [fallo, falloAlDeshacer],
        'La transacción falló y el ROLLBACK tampoco pasó: la conexión se descartó.',
      );
    }
    throw fallo;
  }
}
