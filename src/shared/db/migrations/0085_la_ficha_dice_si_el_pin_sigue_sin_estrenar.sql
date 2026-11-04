-- La ficha de la consola dice si el PIN de la doctora sigue sin estrenar.
--
-- §3.4, regla 7 · §1.5 del napkin: versionada, y NUNCA editada después de aplicarse.
--
-- EL PROBLEMA, levantado por la consola el 4 de noviembre de 2026: para saber si a una
-- doctora le vale el REENVÍO o hace falta el RESETEO, la única forma era llamar a
-- `…/access/resend` y mirar si contestaba `409`. O sea **acuñar un PIN nuevo y matar el
-- anterior para averiguar un estado**. Preguntar no puede costar una credencial.
--
-- POR QUÉ UNA FUNCIÓN Y NO UNA COLUMNA EN LA CONSULTA DE LA FICHA: `app_platform` no tiene
-- ni grant ni política sobre `credential` —«soporte no toca contraseñas», y eso se sostiene
-- en los privilegios, no en el código—. Esa puerta no se abre ni para leer: un `SELECT` sobre
-- esa tabla con ese rol seguiría siendo «permiso denegado» después de esta migración. Lo que
-- se le da es ESTA función, que devuelve **un booleano y nada más**: ni el hash, ni la fecha
-- de caducidad, ni cuándo entró por primera vez.
--
-- LA MISMA EXPRESIÓN QUE DECIDE EL `409`, y a propósito: `is_temporary = false OR
-- temp_used_at IS NOT NULL` es «ya eligió su contraseña» en `medskin_resend_patient_access`
-- (0006), `medskin_platform_resend_access` (0014) y `medskin_resend_team_access` (0019). Si
-- un día cambia la regla y esto no, la ficha ofrecería el botón que el endpoint rechaza.
--
-- SIN FILA DE CREDENCIAL devuelve `true`, que es lo que hace el reenvío: cuando no hay fila
-- la crea y manda un PIN. `true` significa exactamente «el reenvío le funciona», no «existe
-- un PIN vivo»; una temporal caducada también da `true`, y es correcto, porque el reenvío
-- acuña otra.
--
-- `STABLE` y no `VOLATILE`: no escribe nada. Es la primera función de consola que solo lee.

CREATE FUNCTION medskin_platform_pin_unused(p_account_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT NOT coalesce(
           bool_or(c.is_temporary = false OR c.temp_used_at IS NOT NULL),
           false)
    FROM credential c
   WHERE c.account_id = p_account_id;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_platform_pin_unused(uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_platform_pin_unused(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_platform_pin_unused(uuid) TO app_platform;
