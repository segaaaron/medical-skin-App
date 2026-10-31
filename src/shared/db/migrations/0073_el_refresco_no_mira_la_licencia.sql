-- =======================================================================================
-- EL REFRESCO DE SESIÓN DEJA DE SERVIR EL ESTADO DE LA LICENCIA · 30 de octubre de 2026
--
-- Lo que la 0072 no podía ver y la suite sí: `medskin_session_refresh()` leía `license.status`
-- y lo devolvía como `license_status`, y de ahí salía `siguiente_paso` —con la licencia en
-- `sin_enviar`, la app mandaba a la doctora a la pantalla de la matrícula—.
--
-- Esa columna se borró con la revisión manual, así que la función quedó rota: el refresco
-- entero moría con «column l.status does not exist». **No lo cazó el compilador**, porque la
-- consulta vive dentro de una SECURITY DEFINER y para TypeScript es una cadena de texto; lo
-- cazó la prueba contra la base, que es exactamente para lo que está.
--
-- LO QUE LA APP NECESITA SIGUE SIENDO VERDAD, y por eso esto no borra el campo: la doctora que
-- todavía no declaró su matrícula tiene que acabar en esa pantalla. Lo que cambia es el HECHO
-- que lo decide: de «en qué estado está su revisión» a «¿declaró algo?», que es
-- `license_number IS NOT NULL`. El campo pasa de `license_status text` a
-- `license_declared boolean`.
--
-- DROP Y CREATE, NO `CREATE OR REPLACE`: cambia el tipo de una columna de salida y `REPLACE`
-- no puede. Y con el OWNER, el REVOKE y el GRANT detrás — es la lección de la 0071: un `DROP`
-- se lleva los privilegios, y sin el `GRANT EXECUTE` a `app_anonymous` el refresco deja de
-- funcionar para todo el mundo.
-- =======================================================================================
DROP FUNCTION medskin_session_refresh(text, text, integer, integer);--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.medskin_session_refresh(p_hash text, p_new_hash text, p_patient_seconds integer, p_practitioner_seconds integer)
 RETURNS TABLE(verdict text, session_id uuid, account_id uuid, practice_id uuid, scope text, role text, practitioner_role text, permissions text[], account_status text, password_is_temporary boolean, license_declared boolean, first_day_done boolean, refresh_expires_at timestamp with time zone, graced boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
                          -- `license_declared` ES BOOLEANO desde esta migración: aquí decía
                          -- `NULL::text` y el motor rechazaba la función entera con
                          -- «structure of query does not match function result type». Los
                          -- cuatro retornos tempranos lo tenían, y solo fallaban en SU camino
                          -- —el `rotated` pasaba—, que es por lo que hay una prueba por
                          -- veredicto y no una sola del camino bueno.
                          NULL::boolean, NULL::boolean, NULL::timestamptz, false;
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
                          NULL::text[], NULL::text, NULL::boolean, NULL::boolean,
                          NULL::boolean, NULL::timestamptz, false;
      RETURN;
    END IF;
  ELSE
    IF v_session.revoked_at IS NOT NULL THEN
      RETURN QUERY SELECT 'revoked', v_session.id, v_session.account_id,
                          v_session.practice_id, v_session.scope, NULL::text, NULL::text,
                          NULL::text[], NULL::text, NULL::boolean, NULL::boolean,
                          NULL::boolean, NULL::timestamptz, false;
      RETURN;
    END IF;

    IF v_session.refresh_expires_at IS NULL OR v_session.refresh_expires_at <= now() THEN
      RETURN QUERY SELECT 'expired', v_session.id, v_session.account_id,
                          v_session.practice_id, v_session.scope, NULL::text, NULL::text,
                          NULL::text[], NULL::text, NULL::boolean, NULL::boolean,
                          NULL::boolean, NULL::timestamptz, false;
      RETURN;
    END IF;
  END IF;

  -- EL ROL, ANTES DE ESCRIBIR: es lo que decide la vida del refresco nuevo, y por eso ya
  -- no hace falta una segunda transacción para alargarlo (0020).
  SELECT a.role INTO v_role FROM account a WHERE a.id = v_session.account_id;
  v_expires := now() + make_interval(
    secs => CASE WHEN v_role = 'patient' THEN p_patient_seconds ELSE p_practitioner_seconds END
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
           -- ERA `l.status`, y ya no existe: MedSkin no revisa licencias (migración 0072).
           -- Lo que la app necesita de aquí es UNA cosa —si mandarla a la pantalla de la
           -- matrícula—, y eso es «¿declaró algo?». `license_number IS NOT NULL` es ese
           -- hecho, y es el mismo dato que acota el `CHECK license_number_ck`.
           l.license_number IS NOT NULL,
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
$function$;--> statement-breakpoint

ALTER FUNCTION medskin_session_refresh(text, text, integer, integer)
  OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_session_refresh(text, text, integer, integer)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_session_refresh(text, text, integer, integer)
  TO app_anonymous;
