// `GET /v1/platform/accounts?correo=` · «soporte tiene el correo y necesita el uuid».
//
// POR QUÉ EXISTE: las dos acciones de consola sobre una cuenta —reenviar el acceso y levantar la
// pausa— piden un `account_id`, y **soporte nunca tiene un uuid**: tiene el correo con el que
// alguien escribió pidiendo ayuda. Sin esto las dos estaban implementadas y eran inalcanzables,
// que es el mismo agujero que la búsqueda de consultas tapó en `consultas.md`.
//
// PERMISO PROPIO —`plataforma:cuentas:buscar`— y no `plataforma:consultas:leer`: quien mira el
// padrón responde «qué consultas hay», y esto responde «esta persona tiene cuenta en MedSkin»,
// que es otro oráculo y sobre otra clase de sujeto, porque una cuenta puede ser de una paciente.
// El permiso no se comprueba aquí: si este caso de uso corre, el guardia ya lo verificó contra
// el token firmado.

import type { AccountLookup } from '../domain/account-lookup';
import type {
  ConsoleAccountRow,
  ConsoleAccountSearchPort,
  ConsoleActor,
} from '../domain/ports';

export type AccountSearchResponse = {
  cuentas: readonly {
    id: string;
    correo: string;
    rol: string;
    estado: string;
    pausa_hasta: string | null;
  }[];
};

export class SearchAccounts {
  constructor(private readonly accounts: ConsoleAccountSearchPort) {}

  async run(lookup: AccountLookup, actor: ConsoleActor): Promise<AccountSearchResponse> {
    const rows = await this.accounts.findByEmail({ actor, email: lookup.email });

    // LISTA Y NO OBJETO, con cero o una fila —nunca más, lo garantiza `account_email_uq`—, y es
    // para que «no existe» sea un `200` con lista vacía y NO un 404: un 404 aquí diría «ese
    // correo no está en MedSkin» por el código de estado, que es el oráculo que el acceso
    // cierra en la app.
    return { cuentas: rows.map(view) };
  }
}

/**
 * CINCO CAMPOS, y el teléfono NO está aunque este rol ya pueda leerlo (0075): este endpoint
 * sirve para encontrar el `id` y seguir a una de las dos acciones, y el teléfono viaja en la
 * ficha de la consulta, que es donde soporte lo necesita. Un campo de más en la lectura que
 * barre `account` por correo es un campo de más en la que puede devolver la fila de una
 * paciente.
 *
 * `consultas_vinculadas` no está y no se puede dar: contarlas cruza `patient_link`, que
 * `app_platform` no alcanza — y darlo diría en qué clínica de estética está tratada una persona.
 */
function view(row: ConsoleAccountRow) {
  return {
    id: row.id,
    correo: row.email,
    rol: row.role,
    estado: row.status,
    pausa_hasta: row.lockedUntil?.toISOString() ?? null,
  };
}
