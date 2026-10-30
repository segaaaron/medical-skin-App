-- Tramo 1 · las dos últimas de la base, y la primera cierra un callejón sin salida.
--
-- §3.4, regla 7 · §1.5 del napkin: versionada, y NUNCA editada después de aplicarse.
--
-- =======================================================================================
-- 1 · ACUÑAR UNA TEMPORAL NUEVA REVOCA LAS SESIONES DE ESA CUENTA
--
-- EL CALLEJÓN, tal como lo levantó `backend-senior`: la doctora le reenvía el acceso a una
-- paciente que YA TIENE SESIÓN VIVA. La credencial vuelve a ser temporal mientras su
-- refresco sigue vigente, así que `POST /v1/sesion/refresco` responde —correctamente—
-- `siguiente_paso: contrasena_nueva`, pero con un token de alcance `completo`; y
-- `POST /v1/acceso/contrasena-nueva` solo admite `contrasena_temporal` y `recuperacion`. La
-- app abre una pantalla que no puede completar: `401 token_sin_alcance`, y no hay salida.
--
-- LA OTRA SOLUCIÓN POSIBLE ERA ABRIR ESA RUTA AL ALCANCE `completo`, Y SE DESCARTÓ POR
-- SEGURIDAD: cualquiera con una sesión viva podría fijar una contraseña nueva **sin saber
-- la actual**, que es escalada de privilegio desde una sesión robada.
-- `PATCH /v1/cuentas/mia/contrasena` exige la actual justamente por eso.
--
-- Así que el que se cierra es el otro lado: **una sesión viva con token `completo` está
-- autenticada contra una credencial que ya no existe** —el hash se reemplazó en el
-- reenvío—, y mantenerla abierta es dejar a alguien dentro con una llave muerta. Se revoca,
-- en la MISMA transacción que reemplaza el hash, porque las dos cosas son el mismo hecho:
-- si se revocaran después y ese `UPDATE` fallara, quedaría la sesión abierta contra una
-- credencial inexistente, que es el estado que esto viene a eliminar.
--
-- Y es coherente con lo que el sistema ya hacía: cambiar la contraseña revoca todos los
-- refrescos de la cuenta menos el de la sesión que lo hizo (`sesion.md` · reglas de
-- negocio), y borrar la cuenta revoca todos sin excepción (0014). El reenvío es el tercer
-- caso de la misma familia y hasta hoy era el único que no lo hacía.
--
-- Aplica a las TRES funciones de reenvío, con la misma línea y el mismo motivo:
-- `medskin_resend_patient_access` (0006 · 0017), `medskin_platform_resend_access`
-- (0014 · 0017) y `medskin_resend_team_access` (0019). Las tres van con `CREATE OR REPLACE`
-- y la MISMA firma, así que dueño, grants y llamadores no se tocan: **`backend-senior` no
-- tiene que recablear nada de esto.**
--
-- CUATRO DETALLES DE LA LÍNEA:
--
--   · `WHERE revoked_at IS NULL`, para no reescribir el motivo ni la hora de una sesión que
--     ya estaba revocada por otra cosa. El primer motivo es el que explica lo que pasó.
--   · El motivo es `access_resent`, en inglés y del mismo vocabulario que
--     `password_changed`, `account_deleted` y `refresh_reused`.
--   · Revoca **todas las sesiones de esa cuenta**, de cualquier consulta. La credencial es
--     de la cuenta y hay una sola fila por cuenta (`credential_account_uq`): la llave que
--     se murió es global, así que no hay sesión suya que siga valiendo.
--   · No hace falta ni un grant nuevo: `medskin_access` ya tiene `UPDATE (revoked_at,
--     revoked_reason)` sobre `session` y su política de la 0002.
--
-- =======================================================================================
-- 2 · EL REFRESCO CALCULA SU PROPIA CADUCIDAD, PORQUE ES EL QUE SABE EL ROL
--
-- La vida del refresco depende del rol —paciente 30 días, doctora y equipo 12 h
-- (`sesion.md`)— y la función devolvía el rol DESPUÉS de rotar, así que el borde rotaba con
-- la vida corta y la alargaba en una SEGUNDA transacción cuando el veredicto decía
-- paciente. La dirección era la correcta —falla hacia la vida más corta, porque al revés un
-- fallo del segundo paso dejaría a una doctora con 30 días, que §13 prohíbe— pero es una
-- transacción de más en cada refresco de paciente y una ventana de fallo que no hace falta.
--
-- Ahora el rol se lee ANTES del `UPDATE` y la caducidad sale de él. `p_expires_at` se va y
-- en su lugar llegan las dos vidas **en segundos**, que es la forma que el borde ya tiene
-- (`REFRESH_LIFETIME_MS`, dividido por mil) y que no obliga a formatear un `interval` en
-- JavaScript.
--
-- LAS DOS VIDAS LAS PONE EL LLAMADOR Y LA BASE LES PONE COTA, que es el mismo reparto que
-- en `medskin_recovery_mint` («los 10 minutos los pone el llamador, pero un código que
-- caduca dentro de una hora no es un código de recuperación»): el número vive en el
-- contrato y en la configuración, no duplicado aquí, y aquí vive el límite que no se puede
-- cruzar. La cota hace además que **un intercambio de los dos argumentos falle a gritos**:
-- 30 días en el hueco de la doctora pasa de 13 h y revienta con
-- `invalid_parameter_value`. Sin cota, ese error de llamada le daría a una doctora un
-- refresco de 30 días y nadie se enteraría, que es exactamente lo que §13 prohíbe.
--
-- `DROP` y no `CREATE OR REPLACE` porque cambia la lista de argumentos: sin el `DROP` la
-- firma vieja se quedaría viva como sobrecarga y una llamada a medio migrar seguiría
-- compilando. Por eso vuelven el dueño, el `REVOKE` y el `GRANT`.
--
-- Y LO QUE ESTA MIGRACIÓN NO TRAE, DICHO A PROPÓSITO: ninguna bitácora de la ventana de
-- gracia. `app_anonymous` no tiene `INSERT` en `access_audit` y no se le da —ni por
-- función—, porque sería una segunda escritura DESPUÉS de una rotación ya confirmada: si
-- fallara, 500 con la sesión ya rotada, que es el peor fallo posible en esta ruta. Además
-- esa bitácora es la que la doctora lee en sus ajustes, y una fila por reintento de su
-- propia app es ruido en la cara del usuario. La gracia se mide en Redis.
-- =======================================================================================

CREATE OR REPLACE FUNCTION medskin_resend_patient_access(
  p_account_id uuid,
  p_hash text,
  p_expires_at timestamptz
) RETURNS TABLE (outcome text, expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_practice uuid := medskin_current_practice();
  v_link uuid;
  v_credential uuid;
  v_chosen boolean;
BEGIN
  IF v_practice IS NULL THEN
    RAISE EXCEPTION 'medskin_resend_patient_access: sin contexto de consulta'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'medskin_resend_patient_access: falta la cuenta'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_hash IS NULL OR p_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'medskin_resend_patient_access: la temporal no viene hasheada con Argon2id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- 72 h, «y no se negocia por canal» (cuentas.md). La misma cota que el alta.
  IF p_expires_at IS NULL OR p_expires_at <= now()
     OR p_expires_at > now() + interval '73 hours' THEN
    RAISE EXCEPTION 'medskin_resend_patient_access: la temporal vive 72 h'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- LA AUTORIZACIÓN, Y ES LA PRIMERA COSA QUE PASA: el vínculo de esa cuenta en ESTA
  -- consulta. `FOR UPDATE` porque dos reenvíos a la vez no pueden acuñar dos temporales.
  SELECT l.id INTO v_link
    FROM patient_link l
   WHERE l.practice_id = v_practice AND l.account_id = p_account_id
   ORDER BY l.created_at LIMIT 1
     FOR UPDATE;

  IF v_link IS NULL THEN
    RETURN QUERY SELECT 'paciente_no_existe', NULL::timestamptz;
    RETURN;
  END IF;

  SELECT c.id, (c.is_temporary = false OR c.temp_used_at IS NOT NULL)
    INTO v_credential, v_chosen
    FROM credential c WHERE c.account_id = p_account_id FOR UPDATE;

  IF coalesce(v_chosen, false) THEN
    RETURN QUERY SELECT 'ya_eligio_su_contrasena', NULL::timestamptz;
    RETURN;
  END IF;

  IF v_credential IS NULL THEN
    INSERT INTO credential (account_id, hash, is_temporary, temp_expires_at)
    VALUES (p_account_id, p_hash, true, p_expires_at);
  ELSE
    -- La anterior muere aquí: el hash se reemplaza. `temp_first_used_at` NO SE TOCA (0017).
    UPDATE credential
       SET hash = p_hash, is_temporary = true, temp_expires_at = p_expires_at,
           updated_at = now()
     WHERE id = v_credential;
  END IF;

  -- 0020: la llave contra la que estaban autenticadas ya no existe.
  UPDATE session s
     SET revoked_at = now(), revoked_reason = 'access_resent'
   WHERE s.account_id = p_account_id AND s.revoked_at IS NULL;

  UPDATE patient_link SET access_sent_at = now(), updated_at = now() WHERE id = v_link;

  RETURN QUERY SELECT 'acceso_renovado', p_expires_at;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION medskin_platform_resend_access(
  p_account_id uuid,
  p_hash text,
  p_expires_at timestamptz
) RETURNS TABLE (outcome text, expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_deleted timestamptz;
  v_credential uuid;
  v_chosen boolean;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'medskin_platform_resend_access: falta la cuenta'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_hash IS NULL OR p_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'medskin_platform_resend_access: la temporal no viene hasheada con Argon2id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now()
     OR p_expires_at > now() + interval '73 hours' THEN
    RAISE EXCEPTION 'medskin_platform_resend_access: la temporal vive 72 h'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.deleted_at INTO v_deleted FROM account a WHERE a.id = p_account_id FOR UPDATE;
  IF NOT FOUND OR v_deleted IS NOT NULL THEN
    RETURN QUERY SELECT 'cuenta_no_existe', NULL::timestamptz;
    RETURN;
  END IF;

  SELECT c.id, (c.is_temporary = false OR c.temp_used_at IS NOT NULL)
    INTO v_credential, v_chosen
    FROM credential c WHERE c.account_id = p_account_id FOR UPDATE;

  IF coalesce(v_chosen, false) THEN
    RETURN QUERY SELECT 'ya_eligio_su_contrasena', NULL::timestamptz;
    RETURN;
  END IF;

  IF v_credential IS NULL THEN
    INSERT INTO credential (account_id, hash, is_temporary, temp_expires_at)
    VALUES (p_account_id, p_hash, true, p_expires_at);
  ELSE
    -- Igual que en el reenvío de la doctora: el hash se reemplaza y `temp_first_used_at`
    -- NO SE TOCA (0017).
    UPDATE credential
       SET hash = p_hash, is_temporary = true, temp_expires_at = p_expires_at,
           updated_at = now()
     WHERE id = v_credential;
  END IF;

  -- 0020, y aquí con más razón que en ningún otro sitio: el reenvío de la consola es el
  -- que se usa cuando algo se perdió, y «Soporte no la ve» tiene que valer también para la
  -- sesión que quedó abierta.
  UPDATE session s
     SET revoked_at = now(), revoked_reason = 'access_resent'
   WHERE s.account_id = p_account_id AND s.revoked_at IS NULL;

  RETURN QUERY SELECT 'acceso_renovado', p_expires_at;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION medskin_resend_team_access(p_practitioner_id uuid, p_hash text,
                                                      p_expires_at timestamptz)
RETURNS TABLE (outcome text, email citext, expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_practice uuid := medskin_current_practice();
  v_caller uuid := medskin_current_account();
  v_owner uuid;
  v_account uuid;
  v_email citext;
  v_credential uuid;
  v_chosen boolean;
BEGIN
  IF v_practice IS NULL OR v_caller IS NULL THEN
    RAISE EXCEPTION 'medskin_resend_team_access: sin contexto de consulta o de cuenta'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_practitioner_id IS NULL THEN
    RAISE EXCEPTION 'medskin_resend_team_access: falta el miembro'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_hash IS NULL OR p_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'medskin_resend_team_access: la temporal no viene hasheada con Argon2id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- 72 h, la misma cota que el alta de la dueña, la del equipo y la de la paciente.
  IF p_expires_at IS NULL OR p_expires_at <= now()
     OR p_expires_at > now() + interval '73 hours' THEN
    RAISE EXCEPTION 'medskin_resend_team_access: la temporal vive 72 h'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- LA AUTORIZACIÓN, Y ES LA PRIMERA COSA QUE PASA: antes de mirar si el miembro existe,
  -- para que quien no es la dueña no pueda usar los veredictos como sonda.
  SELECT pc.owner_account_id INTO v_owner
    FROM practice pc WHERE pc.id = v_practice;
  IF v_owner IS NULL OR v_owner <> v_caller THEN
    RETURN QUERY SELECT 'not_owner', NULL::citext, NULL::timestamptz;
    RETURN;
  END IF;

  -- El miembro, en ESTA consulta, activo y con su cuenta viva. Las cuatro condiciones dan
  -- el mismo veredicto que un id inventado.
  SELECT pt.account_id, a.email INTO v_account, v_email
    FROM practitioner pt
    JOIN account a ON a.id = pt.account_id
   WHERE pt.id = p_practitioner_id
     AND pt.practice_id = v_practice
     AND pt.status = 'activa'
     AND a.deleted_at IS NULL;

  IF v_account IS NULL OR v_account = v_caller THEN
    RETURN QUERY SELECT 'member_not_found', NULL::citext, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT c.id, (c.is_temporary = false OR c.temp_used_at IS NOT NULL)
    INTO v_credential, v_chosen
    FROM credential c WHERE c.account_id = v_account FOR UPDATE;

  IF coalesce(v_chosen, false) THEN
    RETURN QUERY SELECT 'ya_eligio_su_contrasena', NULL::citext, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_credential IS NULL THEN
    -- Un miembro sin credencial no debería existir —el alta la crea—, pero si existe lo
    -- que hay que hacer es dársela, no fallar.
    INSERT INTO credential (account_id, hash, is_temporary, temp_expires_at)
    VALUES (v_account, p_hash, true, p_expires_at);
  ELSE
    -- La anterior muere aquí. `temp_first_used_at` NO SE TOCA (0017).
    UPDATE credential
       SET hash = p_hash, is_temporary = true, temp_expires_at = p_expires_at,
           updated_at = now()
     WHERE id = v_credential;
  END IF;

  -- 0020: la sesión de la recepcionista que siga abierta está autenticada contra un hash
  -- que ya no existe.
  UPDATE session s
     SET revoked_at = now(), revoked_reason = 'access_resent'
   WHERE s.account_id = v_account AND s.revoked_at IS NULL;

  RETURN QUERY SELECT 'acceso_renovado', v_email, p_expires_at;
END
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- El refresco, con su caducidad resuelta dentro.
-- ---------------------------------------------------------------------------------------
DROP FUNCTION medskin_session_refresh(text, text, timestamptz);--> statement-breakpoint

CREATE FUNCTION medskin_session_refresh(p_hash text, p_new_hash text,
                                        p_patient_seconds integer,
                                        p_practitioner_seconds integer)
RETURNS TABLE (verdict text, session_id uuid, account_id uuid, practice_id uuid,
               scope text, role text, practitioner_role text, permissions text[],
               account_status text, password_is_temporary boolean, license_status text,
               first_day_done boolean, refresh_expires_at timestamptz, graced boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_session session;
  v_graced boolean := false;
  v_role text;
  v_expires timestamptz;
BEGIN
  IF p_hash IS NULL OR length(p_hash) < 32 THEN
    RAISE EXCEPTION 'medskin_session_refresh: refresco vacio o demasiado corto'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_new_hash IS NULL OR length(p_new_hash) < 32 OR p_new_hash = p_hash THEN
    RAISE EXCEPTION 'medskin_session_refresh: el refresco nuevo no es nuevo'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Cotas, no la regla: los 30 días y las 12 h los pone el llamador, que es donde vive el
  -- contrato. Lo que no se puede cruzar vive aquí, y es lo que hace que intercambiar los
  -- dos argumentos reviente en vez de regalarle 30 días de refresco a una doctora (§13).
  IF p_patient_seconds IS NULL OR p_patient_seconds <= 0
     OR p_patient_seconds > 31 * 24 * 3600 THEN
    RAISE EXCEPTION 'medskin_session_refresh: la vida del refresco de paciente esta fuera de rango'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_practitioner_seconds IS NULL OR p_practitioner_seconds <= 0
     OR p_practitioner_seconds > 13 * 3600 THEN
    RAISE EXCEPTION 'medskin_session_refresh: la vida del refresco de doctora esta fuera de rango'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT s.* INTO v_session FROM session s WHERE s.refresh_hash = p_hash FOR UPDATE;

  IF NOT FOUND THEN
    -- ¿Es el inmediatamente anterior? Entonces o es el reintento de un cliente que no vio
    -- la respuesta —y para eso están los 20 s—, o se usó dos veces de verdad: o lo
    -- copiaron, o la app tiene una carrera que no se arregla de otra forma que entrando.
    SELECT s.* INTO v_session FROM session s
      WHERE s.previous_refresh_hash = p_hash FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'invalid', NULL::uuid, NULL::uuid, NULL::uuid, NULL::text,
                          NULL::text, NULL::text, NULL::text[], NULL::text, NULL::boolean,
                          NULL::text, NULL::boolean, NULL::timestamptz, false;
      RETURN;
    END IF;

    IF v_session.revoked_at IS NULL
       AND v_session.refresh_expires_at IS NOT NULL
       AND v_session.refresh_expires_at > now()
       AND v_session.refresh_rotated_at IS NOT NULL
       AND v_session.refresh_rotated_at > now() - interval '20 seconds' THEN
      v_graced := true;
    ELSE
      UPDATE session s SET revoked_at = coalesce(s.revoked_at, now()),
                           revoked_reason = coalesce(s.revoked_reason, 'refresh_reused')
       WHERE s.id = v_session.id;
      RETURN QUERY SELECT 'reused', v_session.id, v_session.account_id,
                          v_session.practice_id, v_session.scope, NULL::text, NULL::text,
                          NULL::text[], NULL::text, NULL::boolean, NULL::text,
                          NULL::boolean, NULL::timestamptz, false;
      RETURN;
    END IF;
  ELSE
    IF v_session.revoked_at IS NOT NULL THEN
      RETURN QUERY SELECT 'revoked', v_session.id, v_session.account_id,
                          v_session.practice_id, v_session.scope, NULL::text, NULL::text,
                          NULL::text[], NULL::text, NULL::boolean, NULL::text,
                          NULL::boolean, NULL::timestamptz, false;
      RETURN;
    END IF;

    IF v_session.refresh_expires_at IS NULL OR v_session.refresh_expires_at <= now() THEN
      RETURN QUERY SELECT 'expired', v_session.id, v_session.account_id,
                          v_session.practice_id, v_session.scope, NULL::text, NULL::text,
                          NULL::text[], NULL::text, NULL::boolean, NULL::text,
                          NULL::boolean, NULL::timestamptz, false;
      RETURN;
    END IF;
  END IF;

  -- EL ROL, ANTES DE ESCRIBIR: es lo que decide la vida del refresco nuevo, y por eso ya
  -- no hace falta una segunda transacción para alargarlo (0020).
  SELECT a.role INTO v_role FROM account a WHERE a.id = v_session.account_id;
  v_expires := now() + make_interval(
    secs => CASE WHEN v_role = 'paciente' THEN p_patient_seconds ELSE p_practitioner_seconds END
  );

  IF v_graced THEN
    -- LA GRACIA. Se rota otra vez y sale un par nuevo. `previous_refresh_hash` se queda
    -- donde está —sigue siendo este mismo `p_hash`— y `refresh_rotated_at` tampoco se
    -- mueve: la ventana no se desliza y los reintentos que falten siguen entrando.
    UPDATE session s
       SET refresh_hash = p_new_hash,
           refresh_expires_at = v_expires,
           last_seen_at = now()
     WHERE s.id = v_session.id;
  ELSE
    UPDATE session s
       SET previous_refresh_hash = p_hash,
           refresh_hash = p_new_hash,
           refresh_expires_at = v_expires,
           refresh_rotated_at = now(),
           last_seen_at = now()
     WHERE s.id = v_session.id;
  END IF;

  RETURN QUERY
    SELECT 'rotated', v_session.id, v_session.account_id, v_session.practice_id,
           v_session.scope, a.role, pr.role, pr.permissions, a.status,
           -- `is_temporary` con `temp_used_at` nulo es «sigue siendo la temporal»: las dos
           -- las mueve `medskin_set_final_password` en la misma sentencia (decisión 2).
           coalesce(c.is_temporary AND c.temp_used_at IS NULL, false),
           l.status,
           -- «Las tres hechas O la lista cerrada por ella». Sin consulta —una paciente—
           -- vale `true`: no hay primer día que terminar.
           coalesce(p.first_day_dismissed
                    OR (p.first_day_practice_data AND p.first_day_schedule
                        AND p.first_day_first_treatment), true),
           v_expires, v_graced
      FROM account a
      LEFT JOIN credential c ON c.account_id = a.id
      LEFT JOIN practice p ON p.id = v_session.practice_id
      LEFT JOIN license l ON l.practice_id = p.id
      LEFT JOIN LATERAL (
        -- La fila de QUIEN PREGUNTA en la consulta de SU sesión, y solo si está activa:
        -- una retirada no se queda con los permisos de ayer.
        SELECT pt.role, pt.permissions FROM practitioner pt
         WHERE pt.account_id = a.id AND pt.practice_id = v_session.practice_id
           AND pt.status = 'activa' LIMIT 1
      ) pr ON true
     WHERE a.id = v_session.account_id;
END
$$;--> statement-breakpoint

ALTER FUNCTION medskin_session_refresh(text, text, integer, integer)
  OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_session_refresh(text, text, integer, integer)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_session_refresh(text, text, integer, integer)
  TO app_anonymous;--> statement-breakpoint
