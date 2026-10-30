-- Tramo 1 · `POST /v1/equipo/{miembro_id}/acceso`, el último endpoint del tramo que no
-- tenía con qué servirse. Una función y ni un grant nuevo.
--
-- §3.4, regla 7 · §1.5 del napkin: versionada, y NUNCA editada después de aplicarse.
--
-- =======================================================================================
-- POR QUÉ NO SERVÍA NINGUNA DE LAS DOS QUE YA HABÍA
--
--   · `medskin_resend_patient_access` empieza resolviendo `patient_link` por
--     `(practice_id del contexto, account_id)`, y un miembro del equipo NO tiene vínculo de
--     paciente: para él esa función solo sabe devolver `paciente_no_existe`. Y marca
--     `patient_link.access_sent_at`, que para el equipo no existe.
--   · `medskin_platform_resend_access` no comprueba consulta ninguno —acuña sobre
--     cualquier cuenta de la región, que es correcto para la consola y solo para ella—.
--     Concederle el `EXECUTE` a `app_practitioner` le abriría a cada doctora la credencial
--     de cualquier cuenta del despliegue: el padrón entero, y con escritura.
--   · El `UPDATE` directo de `credential` no existe para ningún rol fuera de su propia fila
--     y así se queda: es la misma frontera que impide que una doctora resetee la contraseña
--     de su paciente.
--
-- Y faltaba un dato, no solo el acto: el endpoint necesita el correo del miembro para
-- mandarle el acceso, y `app_practitioner` no puede leerlo —su única política en `account`
-- es su propia fila, y `practitioner` guarda nombre y apellido, no correo—. Lo devuelve la
-- función, que es más barato que una copia en `practitioner`: una columna más que
-- desincronizar el día que alguien cambie su correo.
--
-- =======================================================================================
-- LAS CINCO FRONTERAS, Y CADA UNA ESTÁ DENTRO
--
-- 1 · EL MIEMBRO SE RESUELVE EN LA CONSULTA DEL CONTEXTO. `practice_id =
--     medskin_current_practice()`, nunca un `practice_id` que venga por argumento. Es la
--     misma forma que las otras tres: la función no recibe ni la cuenta ni la consulta,
--     las saca del contexto y devuelve un veredicto (§1.15 del napkin).
-- 2 · AUTORIZACIÓN: SER LA DUEÑA, comprobada aquí dentro igual que en
--     `medskin_create_team_member` —`practice.owner_account_id = medskin_current_account()`—
--     y no por el permiso del borde. Una segunda doctora de la misma consulta no reenvía
--     accesos de equipo.
-- 3 · `member_not_found` ES UNO SOLO Y ES INDISTINGUIBLE de un id inventado. Cubre los
--     cuatro casos a propósito: no hay fila en ESTA consulta, está retirada, la cuenta está
--     borrada (`account.deleted_at`: el borrado anonimiza la cuenta y la fila de
--     `practitioner` le sobrevive, así que hay que mirarlo) y **la fila es la de quien
--     llama**. Distinguirlos convertiría el endpoint en una sonda del equipo de otra
--     consulta.
-- 4 · LA DUEÑA NO SE REENVÍA EL ACCESO A SÍ MISMA. Su salida es «Olvidé mi contraseña»,
--     que existe y es suya. Si esto se lo permitiera, tendría una vía de acuñarse
--     credenciales **sin saber su contraseña actual**, que es justo lo que
--     `PATCH /v1/cuentas/mia/contrasena` exige para cambiarla.
-- 5 · `ya_eligio_su_contrasena` CON LA MISMA CONDICIÓN QUE LAS OTRAS DOS
--     (`is_temporary = false OR temp_used_at IS NOT NULL`): la dueña manda sobre el ALTA del
--     acceso de su recepcionista, no sobre su contraseña una vez elegida.
--
-- Y dos cosas que NO hace:
--
--   · **No toca `temp_first_used_at`** (0017): que esa persona ya probara que tiene su
--     correo es un hecho del pasado, y borrarlo le quitaba la recuperación. Lo que esta
--     temporal nueva no se ha estrenado lo dicen `is_temporary` y `temp_used_at`.
--   · **No escribe `access_audit`.** Esa línea la pone el endpoint, que es quien sabe quién
--     la pidió y por qué canal, con `cuenta.acceso_pedido`. Igual que en el reenvío de la
--     paciente.
--
-- Devuelve el veredicto, el correo y la caducidad. **Ni el hash ni la contraseña**, que no
-- salen de esta base por ninguna función.
--
-- `VOLATILE` porque escribe (§1.8, decisión 16): un `INSERT`/`UPDATE` dentro de una función
-- no volátil se crea sin queja y revienta en la primera llamada real. De `medskin_access` y
-- no de `medskin_owner`, que es superusuario (§1.9). `search_path` fijado. Y **ni un grant
-- nuevo**: `medskin_access` ya tiene `SELECT` sobre `practitioner`, `practice`, `credential`
-- y las columnas `id`, `email` y `deleted_at` de `account`, más el `INSERT`/`UPDATE` de
-- `credential` que la 0002 le dio.
-- =======================================================================================

CREATE FUNCTION medskin_resend_team_access(p_practitioner_id uuid, p_hash text,
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

  RETURN QUERY SELECT 'acceso_renovado', v_email, p_expires_at;
END
$$;--> statement-breakpoint

ALTER FUNCTION medskin_resend_team_access(uuid, text, timestamptz) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_resend_team_access(uuid, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_resend_team_access(uuid, text, timestamptz) TO app_practitioner;--> statement-breakpoint
