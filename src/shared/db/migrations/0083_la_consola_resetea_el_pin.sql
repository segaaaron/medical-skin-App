-- La consola resetea el PIN de una cuenta que YA eligió su contraseña.
--
-- §3.4, regla 7 · §1.5 del napkin: versionada, y NUNCA editada después de aplicarse.
--
-- =======================================================================================
-- LA DECISIÓN, Y ES UNA EXCEPCIÓN ESCRITA
--
-- Decidida por el dueño el 4 de noviembre de 2026, con el panel pidiendo «resetear el PIN»
-- para una doctora o una paciente. Hasta hoy eso no existía y la base lo negaba a propósito:
-- las TRES funciones de reenvío —la de la doctora (0006), la de la consola (0014) y la del
-- equipo (0019)— devuelven `ya_eligio_su_contrasena` en cuanto la persona puso la suya,
-- porque «una doctora no puede resetear la contraseña de su paciente una vez elegida: si
-- pudiera, sería dueña del acceso al expediente de una persona adulta» (`cuentas.md`).
--
-- ESA REGLA NO SE TOCA. Las tres funciones siguen exactamente igual y la doctora sigue sin
-- poder. Lo que se abre es una acción NUEVA Y SOLO DE LA CONSOLA, con:
--
--   · función propia —esta—, que es la ÚNICA de la base que puede pisar una credencial ya
--     elegida;
--   · permiso propio `plataforma:acceso:resetear`, que NO se concede con
--     `plataforma:acceso:reenviar`. Quien hoy reenvía no resetea hasta que alguien le firme
--     el permiso nuevo, y así la concesión es una decisión y no un efecto;
--   · su propia línea de bitácora (`cuenta.acceso_reseteado`), distinguible del reenvío.
--
-- EL CASO QUE ATIENDE, que el reenvío no podía: alguien perdió el acceso al correo con el
-- que entró. «Olvidé mi contraseña» no le sirve —la recuperación va a ESE correo— y el
-- reenvío de la consola le contesta 409. Sin esto, soporte no tenía ninguna salida que
-- ofrecer y la cuenta quedaba cerrada para siempre.
--
-- POR QUÉ UNA FUNCIÓN NUEVA Y NO UN ARGUMENTO EN `medskin_platform_resend_access`: un
-- `p_force boolean` cambia la lista de argumentos, así que obliga a `DROP` y a rehacer dueño
-- y grants (0020 ya lo explicó), y un argumento con valor por omisión deja viva una
-- sobrecarga que un día alguien llama sin querer. Separadas, un error aquí no puede abrir el
-- reenvío, y el `GRANT EXECUTE` es el que reparte quién alcanza qué.
--
-- QUÉ COLUMNAS SE MUEVEN, Y POR QUÉ CADA UNA:
--
--   · `hash`, `is_temporary`, `temp_expires_at` — la temporal nueva. La anterior muere aquí,
--     como en los tres reenvíos.
--   · `temp_used_at = NULL` — y esta es la columna que hace al reseteo ser un reseteo.
--     Significa «la temporal que está viva ahora mismo ya se consumió» (0002 · decisión 2,
--     0017), y la que está viva ahora es otra que nadie ha usado. Dejarla puesta haría que
--     `medskin_patient_access_state`, el reenvío y el refresco siguieran leyendo «ya eligió»
--     sobre una credencial temporal: la persona entraría con el PIN y el servidor no le
--     pediría elegir contraseña.
--   · `set_at = NULL` — la fecha en que fijó la definitiva, que ya no existe. Nadie la lee
--     hoy; se pone en nulo para que no afirme un hecho falso el día que alguien la lea.
--   · `temp_first_used_at` NO SE TOCA, y aquí la 0017 manda igual que en los reenvíos: es
--     «esta persona ya probó que tiene su correo», un hecho del pasado que no se des-ocurre
--     porque soporte le mande otras credenciales al mismo correo. Es lo que mantiene viva su
--     recuperación por correo.
--
-- Y REVOCA TODAS SUS SESIONES, en la MISMA transacción y por lo mismo que la 0020: el hash
-- al que esas sesiones estaban autenticadas ya no existe, y aquí con más razón que en el
-- reenvío —si el reseteo se pide porque alguien se quedó fuera de su correo, una sesión
-- abierta en otro sitio es justo lo que hay que cerrar—. Motivo `access_reset`, del mismo
-- vocabulario en inglés que `access_resent`, `password_changed` y `account_deleted`, y
-- distinto de él porque son dos hechos distintos.
--
-- LO QUE NO DEVUELVE: la contraseña. Dos columnas, y ninguna es el PIN —«Va a su propio
-- correo. Soporte no la ve»—. La respuesta del endpoint no la puede llevar porque la base no
-- la da, igual que en el reenvío de la consola.
--
-- NI UN GRANT NUEVO SOBRE TABLAS: `medskin_access` ya tiene `UPDATE (hash, is_temporary,
-- temp_expires_at, temp_first_used_at, temp_used_at, set_at, updated_at)` sobre `credential`
-- y `UPDATE (revoked_at, revoked_reason)` sobre `session`, las dos de la 0002. El portero de
-- esta función es su `GRANT EXECUTE` a `app_platform` y nadie más.
-- =======================================================================================

CREATE FUNCTION medskin_platform_reset_access(p_account_id uuid, p_hash text,
                                              p_expires_at timestamptz)
RETURNS TABLE (outcome text, expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_deleted timestamptz;
  v_credential uuid;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'medskin_platform_reset_access: falta la cuenta'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_hash IS NULL OR p_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'medskin_platform_reset_access: la temporal no viene hasheada con Argon2id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- 72 h, la misma cota que los tres reenvíos: un reseteo no acuña una credencial más larga.
  IF p_expires_at IS NULL OR p_expires_at <= now()
     OR p_expires_at > now() + interval '73 hours' THEN
    RAISE EXCEPTION 'medskin_platform_reset_access: la temporal vive 72 h'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.deleted_at INTO v_deleted FROM account a WHERE a.id = p_account_id FOR UPDATE;
  IF NOT FOUND OR v_deleted IS NOT NULL THEN
    RETURN QUERY SELECT 'cuenta_no_existe', NULL::timestamptz;
    RETURN;
  END IF;

  -- `FOR UPDATE` porque dos reseteos a la vez no pueden acuñar dos temporales. Y NO se mira
  -- si ya eligió: eso es lo único que esta función hace distinto del reenvío.
  SELECT c.id INTO v_credential
    FROM credential c WHERE c.account_id = p_account_id FOR UPDATE;

  IF v_credential IS NULL THEN
    INSERT INTO credential (account_id, hash, is_temporary, temp_expires_at)
    VALUES (p_account_id, p_hash, true, p_expires_at);
  ELSE
    UPDATE credential
       SET hash = p_hash, is_temporary = true, temp_expires_at = p_expires_at,
           temp_used_at = NULL, set_at = NULL, updated_at = now()
     WHERE id = v_credential;
  END IF;

  UPDATE session s
     SET revoked_at = now(), revoked_reason = 'access_reset'
   WHERE s.account_id = p_account_id AND s.revoked_at IS NULL;

  RETURN QUERY SELECT 'acceso_renovado', p_expires_at;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_platform_reset_access(uuid, text, timestamptz)
  OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_platform_reset_access(uuid, text, timestamptz)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_platform_reset_access(uuid, text, timestamptz)
  TO app_platform;
