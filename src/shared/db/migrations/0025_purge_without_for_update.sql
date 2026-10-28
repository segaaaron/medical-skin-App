-- Tramo 1 · corrige el cuerpo del barrido de la 0024, que ya se aplicó y no se toca
-- (§3.4, regla 7 · §1.5 del napkin). Misma firma, así que `CREATE OR REPLACE`: dueño,
-- `REVOKE` y `GRANT EXECUTE` se conservan y el trabajador no cambia una línea.
--
-- =======================================================================================
-- QUÉ ESTABA MAL, Y LO DIJO LA PRUEBA EN LA PRIMERA EJECUCIÓN
--
-- La 0024 llevaba `FOR UPDATE SKIP LOCKED` en el `SELECT` del lote, y eso **no se puede
-- ejecutar con los privilegios que la función tiene a propósito**:
--
--   begin; set local role medskin_access;
--   select account_id, key from idempotency_key where expires_at <= now()
--    order by expires_at limit 3 for update skip locked;
--   -- ERROR: permission denied for table idempotency_key
--
-- y el `SELECT` sin la cláusula de bloqueo pasa sin problema. La razón: **una cláusula
-- `FOR UPDATE` exige el privilegio `UPDATE`**, no le basta `DELETE`. `medskin_access` tiene
-- `SELECT, DELETE` sobre esta tabla y nada más, que es justo lo que la función necesita.
--
-- Y LA SALIDA NO ERA CONCEDER `UPDATE`. La 0024 dice que lo que acota la política
-- `FOR ALL TO medskin_access` es el `GRANT`, y conceder `UPDATE` para que una función de
-- basura pueda bloquear filas convertiría esa frase en papel: le daría a `medskin_access`
-- la capacidad de **reescribir una respuesta guardada** —la del `201` del alta, con su
-- contraseña en claro— que es exactamente lo que no tiene que poder hacer. Un privilegio
-- concedido para un efecto secundario se queda concedido para todo lo demás.
--
-- Así que se va la cláusula de bloqueo y se queda la cota, que es la parte que se gana el
-- sueldo. Qué se pierde, dicho entero: si dos barridos corrieran a la vez, el segundo
-- **esperaría** al primero en las filas que este ya tiene tomadas, en vez de saltárselas, y
-- al despertar las encontraría borradas y seguiría. No hay interbloqueo posible porque los
-- dos recorren en el mismo orden (`expires_at` ascendente, por
-- `idempotency_key_purge_idx`). Y el barrido de verdad es **un** trabajo repetible cada
-- hora, no una cola de competidores: `SKIP LOCKED` resolvía un problema que este barrido no
-- tiene, y costaba un privilegio que sí importa.
--
-- Lo demás no cambia: cota de 10 000, las más viejas primero, `RETURNS integer` con el
-- mismo significado —filas borradas en ESTA llamada— y el mismo contrato con el trabajador:
-- `10 000` significa «puede haber más, vuelve a llamar»; menos, «no quedaba nada más».
-- =======================================================================================

CREATE OR REPLACE FUNCTION medskin_purge_idempotency_keys() RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  WITH expired AS (
    SELECT k.account_id, k.key
      FROM idempotency_key k
     WHERE k.expires_at <= now()
     -- Las más viejas primero, por `idempotency_key_purge_idx (expires_at)`, para que un
     -- barrido con cota avance de verdad en vez de rondar las mismas filas.
     ORDER BY k.expires_at
     LIMIT 10000
  )
  DELETE FROM idempotency_key k
   USING expired e
   WHERE k.account_id = e.account_id AND k.key = e.key;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;--> statement-breakpoint
