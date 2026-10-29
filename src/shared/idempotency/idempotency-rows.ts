// LA IDEMPOTENCIA VA EN LA TABLA `idempotency_key` Y DENTRO DE LA TRANSACCIÓN DE LA
// OPERACIÓN. Antes vivía en Redis, y eso rompía dos cosas que este proyecto ya tenía
// decididas por escrito:
//
// 1. **La respuesta que hay que repetir lleva la contraseña temporal en claro.** El `201` de
//    `POST /v1/patients` la trae cuando la vía es `whatsapp` o `ninguna` —y el texto y la
//    url del WhatsApp la llevan dentro—, así que guardarla en Redis dejaba 24 h una
//    credencial viva, el nombre y el correo de una paciente fuera de la base, sin cifrar y
//    sin HMAC. La decisión 30 mandó el envío EN LÍNEA y no por cola exactamente para no meter
//    esa contraseña «en claro en Redis», y la consola lo escribió en su propio código: «eso
//    no se deja fuera de la base». La razón cubría los dos caminos; la implementación, uno.
// 2. **Una fila que se escribe DESPUÉS del `COMMIT` no es idempotencia.** Redis no entra en
//    el `COMMIT` de Postgres: un parpadeo entre las dos devolvía un `500` cuya frase era
//    falsa y el reintento ejecutaba otra vez, y en `POST /v1/patients` eso acababa en DOS
//    fichas sobre la misma cuenta.
//
// LO QUE SERIALIZA ES LA CLAVE PRIMARIA `(account_id, key)`, Y POR ESO `claim()` VA PRIMERO.
// Medido el 28 de octubre, y es el defecto que esta versión arregla: con la reserva al final,
// dos peticiones idénticas a la vez pasaban las dos por el `SELECT` vacío, ejecutaban las
// dos, y la perdedora se enteraba tarde —`ON CONFLICT DO NOTHING` ESPERA el tuple de la que
// va ganando y, cuando esa confirma, **no inserta y no falla**: devuelve 0 filas—. En el alta
// de una paciente con un correo que ya tiene cuenta no hay ninguna red natural que la pare
// (la función reusa la cuenta en vez de insertarla, `patient_practice_email_idx` no es único
// y cada ficha trae un `patient_id` nuevo), así que eran dos fichas, dos vínculos y dos
// historias de la misma persona. Con `claim()` delante, la perdedora se entera ANTES de
// escribir nada, y lo que recibe es la respuesta de la ganadora.
//
// LA RESERVA Y EL CIERRE SON DOS TIEMPOS, y `http_status` nulo es lo que los separa —es lo
// que esa columna nullable significa, y hasta hoy nadie la escribía así—: los dos endpoints
// que mandan un correo no conocen su respuesta completa hasta DESPUÉS del `COMMIT` (`enviado`
// dice si el relé la aceptó, y el relé no puede correr dentro de una transacción sin pinchar
// una conexión del pooler mientras el SMTP piensa).
//
// Y UNA RESERVA SIN CERRAR NO SE VUELVE A EJECUTAR NUNCA: quien la encuentra recibe el `500`
// de su endpoint con la frase que dice que la operación ya ocurrió. Volver a ejecutar en
// silencio es el defecto de arriba con otra ropa.

import type { PoolClient } from 'pg';

import { ContractError, ServiceFailure } from '../contract/error-catalog';
import type { IdempotencyRecord } from './idempotency-key';

/** «Durante 24 h» (`_convenciones.md`). La fila caduca sola y `idempotency_key_purge_idx` la barre. */
export const IDEMPOTENCY_HOURS = 24;

/**
 * La respuesta guardada de una petición que ya se atendió.
 *
 * **«Byte a byte» era prometer más de lo que la columna da, y esa frase estaba en seis
 * sitios** (medido el 28 de octubre): `response` es `jsonb`, y `jsonb` reordena las claves,
 * **descarta las duplicadas** —`{"a":1,"a":2}` queda en `{"a":2}`— y normaliza los números
 * —`1e2` queda en `100`—. Lo que se repite es **la respuesta de la misma petición**, idéntica
 * en significado, que es lo que un cliente JSON necesita y lo que las pruebas comprueban. Si
 * algún día hiciera falta la identidad literal, la columna tendría que ser `text`, y eso es
 * otra decisión.
 */
export type Replay<T> = {
  status: number;
  response: T;
};

type Claim = {
  record: IdempotencyRecord;
  accountId: string;
  practiceId: string | null;
  /** La frase del `500` de ese endpoint para una reserva sin cerrar. */
  unfinished: string;
};

/**
 * RECLAMA LA CLAVE, Y ES LO PRIMERO DE LA TRANSACCIÓN. Devuelve:
 *   · `null` → la clave es de esta petición: sigue, crea, y cierra con `complete()`;
 *   · una respuesta → esta misma petición ya se atendió (o la está atendiendo otra
 *     transacción que ganó la carrera y ya cerró): se repite tal como se guardó y NO se crea nada.
 *
 * Y lanza, en vez de dejar seguir, en los dos casos en que no hay respuesta que dar:
 *   · misma clave con otro cuerpo → `409 clave_idempotencia_reutilizada`;
 *   · reserva sin cerrar → el `500` del endpoint, porque la operación ya ocurrió.
 */
export async function claim<T>(c: PoolClient, p: Claim): Promise<Replay<T> | null> {
  const found = await lookup<T>(c, p);
  if (found !== null) return found;

  const taken = await c.query(
    // `account_id` y `practice_id` van como parámetros y no como `medskin_current_*()`: son
    // los mismos valores —la política los comprueba con `WITH CHECK`— y así la sentencia no
    // depende de un `EXECUTE` que hoy existe por omisión de Postgres.
    //
    // `on conflict` NO es «ya está, sigue»: espera a la transacción que va ganando y, cuando
    // esa confirma, afecta 0 filas sin fallar. Por eso se mira `rowCount` y por eso esta
    // función va antes de escribir nada.
    //
    // Y `do update … where expires_at <= now()` en vez de `do nothing` por un caso concreto:
    // una fila CADUCADA sigue ocupando la clave primaria, así que sin esto una clave
    // reutilizada después de sus 24 h quedaría atascada —no se puede insertar y la lectura la
    // ignora—. Tomarla es lo coherente con el filtro de la lectura: pasadas las 24 h, es una
    // petición nueva. Si la fila está VIVA, el `where` no se cumple, afecta 0 filas, y eso es
    // la carrera que se resuelve releyendo.
    `insert into idempotency_key (key, account_id, practice_id, body_hash, http_status,
                                  response, expires_at)
     values ($1, $2, $3, $4, null, null, now() + ($5 || ' hours')::interval)
     on conflict (account_id, key) do update
        set body_hash = excluded.body_hash, practice_id = excluded.practice_id,
            http_status = null, response = null,
            created_at = now(), expires_at = excluded.expires_at
      where idempotency_key.expires_at <= now()`,
    [p.record.key, p.accountId, p.practiceId, p.record.bodyHash, String(IDEMPOTENCY_HOURS)],
  );
  if (taken.rowCount === 1) return null;

  // Perdimos la carrera: la fila es de otra transacción que ya confirmó. Se relee —ahora sí
  // existe— y se repite SU respuesta. Si todavía no la tiene, es una reserva sin cerrar y
  // sale el 500 del endpoint: lo que no puede pasar es seguir y ejecutar la operación otra
  // vez, que es exactamente lo que hacía esta función cuando no miraba `rowCount`.
  const winner = await lookup<T>(c, p);
  if (winner !== null) return winner;

  throw new ServiceFailure(
    p.unfinished,
    new Error(
      `la clave ${p.record.key} la tomó otra petición y su fila no se pudo leer: 0 filas`,
    ),
  );
}

/**
 * La respuesta definitiva, cuando ya es verdad. Dentro de la transacción si la respuesta no
 * depende de nada posterior; en la suya propia cuando sí —el envío del correo—, y entonces
 * **no puede causar una segunda ejecución**: la reserva ya está, así que el reintento la
 * encuentra.
 */
export async function complete(
  c: PoolClient,
  p: { record: IdempotencyRecord; accountId: string; status: number; response: unknown },
): Promise<void> {
  const done = await c.query(
    `update idempotency_key set http_status = $3, response = $4::jsonb
      where account_id = $1 and key = $2 and http_status is null`,
    [p.accountId, p.record.key, p.status, JSON.stringify(p.response)],
  );
  if (done.rowCount === 1) return;
  // No se tapa: sin esta fila el reintento recibirá el 500 de la reserva sin cerrar en vez de
  // la respuesta, y quien lo lea tiene que saber por qué.
  throw new Error(
    `la clave ${p.record.key} no se pudo cerrar: ${done.rowCount ?? 0} filas sin respuesta`,
  );
}

/**
 * SUELTA LA RESERVA. Se llama cuando la operación acabó en un veredicto que **no se repite**
 * —un `403`, un `404`, un `409`, un `429`—: esas no son una respuesta que repetir y «el
 * reintento tiene que poder volver a intentarlo de verdad» (`_convenciones.md`). Sin esto,
 * una doctora a la que el alta le dijo «tu licencia está en revisión» no podría reintentar
 * con la misma clave cuando se la aprueben: recibiría el 500 de la reserva sin cerrar.
 *
 * Solo suelta lo que no tiene respuesta: una fila ya cerrada es un hecho y no se borra.
 */
export async function release(
  c: PoolClient,
  p: { record: IdempotencyRecord; accountId: string },
): Promise<void> {
  const freed = await c.query(
    `delete from idempotency_key
      where account_id = $1 and key = $2 and http_status is null`,
    [p.accountId, p.record.key],
  );
  if (freed.rowCount === 1) return;
  // El MISMO criterio que `complete()`, y no porque hoy pueda pasar: a esta función solo se
  // llega con la reserva de ESTA transacción recién hecha, así que 0 filas significaría que
  // algo se la llevó en medio. Descartar el `rowCount` aquí es dejar preparado el fallo
  // silencioso de mañana.
  throw new Error(
    `la clave ${p.record.key} no se pudo soltar: ${freed.rowCount ?? 0} filas sin respuesta`,
  );
}

/**
 * La fila de esta clave, si está viva. **`expires_at > now()` es parte del contrato, no una
 * optimización**: si la repetición dependiera de que la fila siga existiendo, lo que pasa en
 * el minuto 1441 dependería de cuándo pasó el barrendero por última vez. Con el filtro, la
 * ventana es siempre la de `_convenciones.md` —24 h— y una fila caducada se trata como lo que
 * es: una petición nueva.
 */
async function lookup<T>(c: PoolClient, p: Claim): Promise<Replay<T> | null> {
  // `account_id` va escrito aunque la política ya acote: la de `app_practitioner` es por
  // INQUILINO —`practice_id = medskin_current_practice()`—, así que sin esta condición la
  // clave de una compañera de la misma consulta se leería como propia. La clave del contrato
  // es `(Idempotency-Key, cuenta que llama, cuerpo hasheado)`, y es también la clave primaria.
  const { rows } = await c.query<{
    body_hash: string;
    http_status: number | null;
    response: unknown;
  }>(
    `select body_hash, http_status, response from idempotency_key
      where account_id = $1 and key = $2 and expires_at > now()`,
    [p.accountId, p.record.key],
  );
  const row = rows[0];
  if (row === undefined) return null;

  if (row.body_hash !== p.record.bodyHash) {
    throw new ContractError('clave_idempotencia_reutilizada');
  }
  if (row.http_status === null) {
    throw new ServiceFailure(
      p.unfinished,
      new Error(`la clave ${p.record.key} quedó reservada y su respuesta no se escribió`),
    );
  }
  return { status: row.http_status, response: row.response as T };
}
