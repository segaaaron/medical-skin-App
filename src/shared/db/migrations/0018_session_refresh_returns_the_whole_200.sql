-- Tramo 1 · `sesion.md` · `POST /v1/sesion/refresco`, que está sin escribir porque la
-- función no devuelve lo que su 200 promete. Las dos cosas que faltaban, y la tercera que
-- es una decisión de producto que vive aquí y no en una caché.
--
-- §3.4, regla 7 · §1.5 del napkin: versionada, y NUNCA editada después de aplicarse.
--
-- =======================================================================================
-- 1 · `role` ERA `account.role`, Y ESE NO ES EL `rol` DEL TOKEN
--
-- `account.role` es `practitioner` | `paciente`: el rol de AUTENTICACIÓN y nada más
-- (`_convenciones.md` · «Los valores de `rol`»). El `rol` que viaja al cliente es
-- `doctora` | `recepcion` | `asistente_clinico` | `paciente`, y para una doctora sale de
-- `practitioner.role`, que esta función no devolvía. Con solo `account.role` el token nuevo
-- se acuñaba con `practitioner`, que es un valor que **el servidor nunca devuelve al
-- cliente**, o con un rol adivinado.
--
-- La columna `role` se queda con su nombre y su contenido —es `account.role`, y es verdad—
-- y al lado llega `practitioner_role`. El mapeo del borde es el de la tabla del contrato:
-- `paciente` si `role = 'paciente'`, y si no `practitioner_role`.
--
-- 2 · EL `siguiente_paso` NO SE PUEDE ADIVINAR, Y EL REFRESCO CORRE CON `app_anonymous`
--
-- `app_anonymous` no tiene un solo privilegio de tabla —es su definición—, así que lo que
-- la función no devuelva no se puede leer por fuera. Y `siguiente_paso` necesita tres
-- hechos que no estaban: si la contraseña sigue siendo la temporal, el estado de la
-- licencia y si el primer día está terminado. Son exactamente los tres de
-- `next-step.ts` · `NextStepInput`, con los mismos nombres y la misma forma, para que el
-- borde llame a `resolveNextStep()` sin escribir una regla nueva:
--
--   password_is_temporary -> passwordIsTemporary
--   license_status        -> licenseStatus
--   first_day_done        -> firstDayDone
--
-- `first_day_done` sale ya resuelto y no como cuatro banderas, y es a propósito: la regla
-- «las tres hechas O la lista cerrada por ella» ya está escrita en el repositorio para el
-- acceso, y devolver las cuatro marcas obligaría a escribirla una segunda vez en el camino
-- del refresco. Una regla en dos sitios es una regla que se desincroniza.
--
-- Para una PACIENTE los tres valen lo que vale el caso «sin consulta» del repositorio:
-- `license_status` nulo y `first_day_done` verdadero, porque no hay consulta que mirar.
-- **No se devuelven `vincular` ni `ficha_medica`**: `next-step.ts` devuelve `inicio` para
-- una paciente con su contraseña definitiva y lo dice por escrito (son del tramo 2). El día
-- que esos dos pasos existan, esta función crece con lo que `patient_link` y
-- `medical_history` digan; devolverlos hoy sería inventar un campo que nadie lee.
--
-- Nada de esto necesita un `GRANT` nuevo: la función es `SECURITY DEFINER` de
-- `medskin_access`, que ya tiene `SELECT` sobre `account`, `credential`, `practitioner`,
-- `practice` y `license` con sus políticas de la 0002. Lo que `app_anonymous` gana es UN
-- veredicto más completo, no una tabla más.
--
-- 3 · LA GRACIA DE 20 s SE RESUELVE EN LA FILA, NO EN REDIS
--
-- Decisión del dueño, ya escrita en `sesion.md`: la redacción anterior («devuelve el mismo
-- par que devolvió entonces, guardado en caché») significaba el refresco EN CLARO en Redis
-- durante 20 segundos, una credencial viva fuera de la base, que es lo mismo que se rechazó
-- al decidir que el acceso se manda en línea y no por cola. Así que si el refresco que
-- llega es el inmediatamente anterior y la rotación fue hace menos de 20 s, es un reintento
-- del cliente: **se rota otra vez y sale un par nuevo**, sin revocar y sin
-- `refresco_reutilizado`. Fuera de la ventana, la detección de reuso es la de siempre.
--
-- El estado que hace falta YA está en la fila y no falta ninguna columna:
-- `previous_refresh_hash` dice cuál era el inmediatamente anterior y `refresh_rotated_at`
-- cuándo se rotó. Las dos son de la 0000.
--
-- DOS DETALLES DE LA VENTANA QUE NO SON OBVIOS Y QUE SON LA MITAD DE LA DECISIÓN:
--
--   a) En la rotación de gracia **`previous_refresh_hash` no se mueve y
--      `refresh_rotated_at` tampoco**. Solo cambia el hash vigente. Dos consecuencias
--      buscadas: el refresco original sigue valiendo para TODOS los reintentos que lleguen
--      dentro de la ventana —que es el caso que la gracia existe para cubrir: tres
--      peticiones en paralelo con el mismo refresco guardado—, y la ventana **no se
--      desliza**: queda anclada a la rotación de verdad, así que una cadena de reintentos
--      no la puede estirar indefinidamente. Si en la gracia se moviera `previous` al hash
--      que acaba de llegar y `rotated_at` a `now()`, cada reintento abriría 20 s nuevos.
--   b) El cliente que se quede con un par **superado** —A y B salen en paralelo con el
--      mismo refresco, B gana la carrera y la app guarda la respuesta de A— recibe
--      `invalid` la próxima vez, que es el `401 refresco_no_valido` del contrato: «borra lo
--      local y va a Entra a MedSkin», sin alarma y sin revocar la familia. Es el fallo
--      menos malo de los dos posibles y es consecuencia directa de (a): el otro reparto de
--      las dos ranuras le daría `reused`, que es la frase «Cerramos tu sesión por
--      seguridad» y la revocación, a un cliente legítimo. Con dos ranuras y sin el par en
--      claro, no hay tercera opción: queda dicho aquí para que nadie lo descubra midiendo.
--
-- `DROP` y no `CREATE OR REPLACE` porque cambian las columnas de salida, y Postgres no deja
-- cambiar el tipo de retorno de una función existente. Por eso vuelven el dueño, el
-- `REVOKE` y el `GRANT`: un `DROP` se los lleva.
-- =======================================================================================

DROP FUNCTION medskin_session_refresh(text, text, timestamptz);--> statement-breakpoint

CREATE FUNCTION medskin_session_refresh(p_hash text, p_new_hash text,
                                        p_expires_at timestamptz)
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
BEGIN
  IF p_hash IS NULL OR length(p_hash) < 32 THEN
    RAISE EXCEPTION 'medskin_session_refresh: refresco vacio o demasiado corto'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_new_hash IS NULL OR length(p_new_hash) < 32 OR p_new_hash = p_hash THEN
    RAISE EXCEPTION 'medskin_session_refresh: el refresco nuevo no es nuevo'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'medskin_session_refresh: caducidad fuera de rango'
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
      -- LA GRACIA. Se rota otra vez y sale un par nuevo. `previous_refresh_hash` se queda
      -- donde está —sigue siendo este mismo `p_hash`— y `refresh_rotated_at` tampoco se
      -- mueve: la ventana no se desliza y los reintentos que falten siguen entrando.
      UPDATE session s
         SET refresh_hash = p_new_hash,
             refresh_expires_at = p_expires_at,
             last_seen_at = now()
       WHERE s.id = v_session.id;
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

    UPDATE session s
       SET previous_refresh_hash = p_hash,
           refresh_hash = p_new_hash,
           refresh_expires_at = p_expires_at,
           refresh_rotated_at = now(),
           last_seen_at = now()
     WHERE s.id = v_session.id;
  END IF;

  RETURN QUERY
    SELECT 'rotated', v_session.id, v_session.account_id, v_session.practice_id,
           v_session.scope, a.role, pr.role, pr.permissions, a.status,
           -- `is_temporary` con `temp_used_at` nulo es «sigue siendo la temporal»: las dos
           -- las mueve `medskin_set_final_password` en la misma sentencia (decisión 2), y
           -- se miran las dos por lo mismo que las mira `medskin_patient_access_state`.
           coalesce(c.is_temporary AND c.temp_used_at IS NULL, false),
           l.status,
           -- «Las tres hechas O la lista cerrada por ella». Sin consulta —una paciente—
           -- vale `true`: no hay primer día que terminar, igual que el caso «sin consulta»
           -- del repositorio.
           coalesce(p.first_day_dismissed
                    OR (p.first_day_practice_data AND p.first_day_schedule
                        AND p.first_day_first_treatment), true),
           p_expires_at, v_graced
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

ALTER FUNCTION medskin_session_refresh(text, text, timestamptz) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_session_refresh(text, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_session_refresh(text, text, timestamptz) TO app_anonymous;--> statement-breakpoint
