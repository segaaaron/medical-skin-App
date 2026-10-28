-- Tramo 1 · la última de la base. `_convenciones.md` promete que la fila de
-- `idempotency_key` se guarda **24 h**, y nada la barría: `expires_at` se escribía y
-- `idempotency_key_purge_idx (expires_at)` existía desde la 0000, y no los leía nadie.
--
-- §3.4, regla 7 · §1.5 del napkin: versionada, y NUNCA editada después de aplicarse.
--
-- =======================================================================================
-- POR QUÉ ESTO NO LO PUEDE HACER NINGÚN ROL DE APLICACIÓN · medido, no razonado
--
-- Con tres filas caducadas de tres dueños distintos y un
-- `DELETE FROM idempotency_key WHERE expires_at <= now()`:
--
--   app_practitioner sin consulta:    borró 0 de 3
--   app_practitioner con consulta A:  borró 1 de 3
--   app_patient:                      borró 0 de 3
--   app_platform:                     borró 1 de 3
--   app_anonymous:                    ERROR 42501 permission denied
--
-- El `GRANT DELETE` está puesto desde la 0000; lo que confina son **las tres políticas**
-- (`practice_id = medskin_current_practice()`, `practice_id IS NULL AND account_id =
-- medskin_current_account()`, y la de plataforma). Un barrido global tendría que recorrer
-- inquilino por inquilino y cuenta por cuenta, y para eso haría falta **enumerarlos**, que
-- es exactamente la lectura cruzada que ninguno de esos roles tiene ni va a tener. Y
-- `medskin_owner` no es salida: lo usa `migrate.ts` y nadie más.
--
-- Y la fila no es un detalle de limpieza: guarda la respuesta del `201` del alta, que con
-- `enviar_acceso_por: "ninguna"` **lleva la contraseña temporal en claro** porque la
-- idempotencia promete repetir la respuesta «byte a byte, contraseña incluida». Sin
-- barrido, esa fila se quedaba más allá de sus 24 h y después indefinidamente, una por
-- alta. La retención prometida y la ventana de repetición son el mismo plazo, y hasta hoy
-- solo se cumplía el segundo.
--
-- Lo que NO se hizo, y es la mitad de la decisión: un trabajo con retraso por clave —uno
-- programado a 24 h por cada fila— es «desaparece si Redis no perdió nada», y eso no es
-- retención. Barrer de refilón dentro de la operación tampoco: haría que el coste de una
-- limpieza ajena cayera sobre la petición de una doctora, y la petición es justo donde
-- nada que pueda tardar tiene permiso de estar.
--
-- =======================================================================================
-- LAS TRES DECISIONES QUE SE PIDIÓ JUZGAR
--
-- 1 · EL `EXECUTE` ES DE `app_anonymous`, Y SÍ ES EL ROL CORRECTO. El trabajador no tiene
--     sesión: cuando corre no hay ni inquilino ni cuenta que fijar, que es la definición de
--     ese rol. Y la frontera no la sostiene quién llama, la sostiene **la firma**: la
--     función **no recibe ningún argumento**, así que no hay nada que pasarle, nada que
--     inyectarle y nada que ensanchar. Lo único que puede hacer quien la llame es borrar
--     filas cuyo `expires_at` YA pasó, y esa condición está dentro y no se puede mover
--     desde fuera. Es recolección de basura, no una capacidad.
--     Se descartó un sexto rol `app_worker`: sería un nombre más que listar en cada
--     `ALTER POLICY … TO`, y eso es justo donde alguien se olvida de uno y abre un
--     inquilino (§1.15). Un rol nuevo para una función de basura no se paga.
--
-- 2 · DEVUELVE CUÁNTAS BORRÓ, Y EL NÚMERO TIENE UN SIGNIFICADO EXACTO: **filas borradas en
--     ESTA llamada**, no «filas que estaban caducadas». Con la cota de abajo los dos
--     números son distintos a propósito, y de ahí sale el contrato con el trabajador:
--
--       devuelve 10 000  -> puede haber más, vuelve a llamar
--       devuelve < 10 000 -> no quedaba nada más caducado en ese instante
--
--     Así el barrido es observable —el trabajador registra el número— en vez de un acto de
--     fe, y el bucle lo decide quien lo llama y no la base.
--
-- 3 · SÍ HACÍA FALTA COTA, y por dos razones que no son teóricas:
--
--       · **La primera corrida de esto borra todo lo acumulado desde el día uno**, porque
--         nunca ha barrido nadie. El estado estable de 24 h es pequeño; esa primera vez no.
--       · `idempotency_key` está en la ruta caliente de **todo `POST` que crea algo**: el
--         borde escribe su fila al empezar y la lee al repetir. Un `DELETE` largo mantiene
--         sus bloqueos de fila mientras dura, y un barrido sin cota puede ponerse por
--         delante del alta de una paciente. Una transacción corta y repetible no.
--
--     La cota va DENTRO y no como argumento, a propósito: es lo que mantiene la firma sin
--     parámetros, que es la mitad del punto 1. El tamaño del lote es un detalle de
--     implementación y se cambia en otra migración sin tocar el trabajador.
--     `FOR UPDATE SKIP LOCKED` para que dos barridos a la vez no se esperen y para que una
--     fila que alguien esté tocando se quede para la vuelta siguiente, en vez de bloquear.
--
-- `VOLATILE` porque borra (§1.8, decisión 16). De `medskin_access` y no de `medskin_owner`,
-- que es superusuario (§1.9). `search_path` fijado —aquí sí, que es `plpgsql` y no se
-- empotra: lo de la 0023 era de las dos funciones de contexto en `LANGUAGE sql`—. Y la
-- política nueva es la del resto de las tablas de la casa, `FOR ALL TO medskin_access` con
-- `current_user`, acotada por el `GRANT`: `SELECT` y `DELETE`, que es todo lo que la
-- función hace y nada más. Sin `INSERT` ni `UPDATE`, la mitad de escritura de esa política
-- no es alcanzable.
-- =======================================================================================

CREATE POLICY idempotency_key_access ON "idempotency_key" FOR ALL TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint
GRANT SELECT, DELETE ON "idempotency_key" TO medskin_access;--> statement-breakpoint

CREATE FUNCTION medskin_purge_idempotency_keys() RETURNS integer
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
       FOR UPDATE SKIP LOCKED
  )
  DELETE FROM idempotency_key k
   USING expired e
   WHERE k.account_id = e.account_id AND k.key = e.key;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;--> statement-breakpoint

ALTER FUNCTION medskin_purge_idempotency_keys() OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_purge_idempotency_keys() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_purge_idempotency_keys() TO app_anonymous;--> statement-breakpoint
