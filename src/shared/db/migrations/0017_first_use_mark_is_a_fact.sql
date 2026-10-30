-- Tramo 1 · H-12. El reenvío de acceso dejaba a la paciente sin recuperación, y la
-- compensación del 500 no podía devolvérsela porque el `UPDATE` de la marca es de
-- `medskin_access`. Esta migración lo arregla SIN función de compensación, y por eso el
-- bloque de abajo es largo: el encargo era «que la compensación pueda restaurarla» y lo
-- que se entrega es que no haya nada que restaurar.
--
-- §3.4, regla 7 · §1.5 del napkin: versionada, y NUNCA editada después de aplicarse.
--
-- =======================================================================================
-- EL CAMINO QUE LEVANTÓ `/flujo check`, Y EL HERMANO QUE NO SE HABÍA VISTO
--
-- El escenario verificado: la paciente estrenó su temporal y no eligió la definitiva; la
-- doctora reenvía; `medskin_resend_patient_access` reemplaza el hash y pone
-- `temp_first_used_at = NULL`; el relé de correo falla; el 500 compensa `access_sent_at` y
-- nada más. Estado final: la temporal vieja muerta, la nueva sin entregar y la marca en
-- nulo, así que `medskin_recovery_mint` no acuña («solo si ya estrenó») y «Olvidé mi
-- contraseña» le devuelve el 202 idéntico sin mandar nada. Sin salida propia.
--
-- Y el hermano, que es el que decide la forma del arreglo: **con el envío EXITOSO pasa lo
-- mismo**. La doctora reenvía, el correo sale, el correo se pierde en la carpeta de no
-- deseado, y la paciente queda igual de encerrada: marca en nulo, recuperación muda, y la
-- única salida es que la doctora acierte otro reenvío. Ninguna compensación cubre ese
-- camino, porque ahí no hay nada que fallara.
--
-- O sea que el error no estaba en la compensación: estaba en el `UPDATE`. La columna
-- llevaba DOS significados y solo uno es verdad:
--
--   · «esta persona ya probó que tiene su correo» — un hecho del pasado, monótono, que no
--     se puede des-ocurrir. Es el que lee `medskin_recovery_mint`, y la regla que cita es
--     de `recuperacion.md`: «quien no probó nunca que tiene el correo no puede usar el
--     correo para entrar».
--   · «la temporal que está viva ahora mismo ya se usó» — un hecho de ESTA credencial, y
--     para eso están `is_temporary` y `temp_used_at`, que es lo que mira todo el resto del
--     sistema (`medskin_patient_access_state`, `medskin_platform_resend_access`, el propio
--     reenvío para su veredicto `ya_eligio_su_contrasena`).
--
-- Poner la marca en nulo al reenviar afirma «nunca probó que tiene su correo», que es
-- falso: lo probó, con la temporal anterior, y eso no se deshace porque se le manden otras
-- credenciales al MISMO correo. Así que el reenvío deja de tocarla. Las dos funciones de
-- reenvío —la de la doctora (0006) y la de la consola (0014)— tenían la misma línea y las
-- dos se corrigen aquí: el arreglo va donde pasan los dos caminos y no en el que levantó el
-- informe.
--
-- QUÉ NO CAMBIA, Y HAY QUE LEERLO ANTES DE CREER QUE ESTO ABRE UNA PUERTA:
--
--   · La que NUNCA estrenó su temporal sigue sin recuperación, antes y después del
--     reenvío. La regla del contrato queda intacta; lo que se arregla es la que SÍ la
--     estrenó. Va con su prueba.
--   · El correo al que se reenvía es el de la cuenta y el reenvío no lo cambia: ninguna de
--     las dos funciones toca `account.email`, y la doctora no puede cambiárselo (su
--     política de `account` es `id = medskin_current_account()`, su propia fila y nada
--     más). Si el correo cambiara, la prueba de control sería de otra dirección y la marca
--     tendría que caer: hoy ese camino no existe, y el día que exista es el `UPDATE` del
--     correo el que tiene que ocuparse, no el reenvío.
--   · El hash anterior NO se restaura ni se intenta: no se guarda en claro y así sigue.
--     La paciente recupera por correo, que es la salida que el contrato le promete.
--   · `medskin_access_attempt` marca la primera entrada con `WHERE ... AND
--     temp_first_used_at IS NULL`, así que con la marca ya puesta no la vuelve a escribir:
--     el valor se queda en la fecha de la PRIMERA vez, que es lo que la columna dice que
--     es. Nadie lee el valor; se lee si es nulo.
--
-- Las dos van con `CREATE OR REPLACE` y la MISMA firma, así que dueño y `GRANT EXECUTE` se
-- conservan y no hay `DROP` que arrastre nada. Lo único que cambia en cada cuerpo es la
-- línea de `temp_first_used_at`, marcada.
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
    -- La anterior muere aquí: el hash se reemplaza. **`temp_first_used_at` NO SE TOCA**
    -- (0017): que ya probara que tiene su correo es un hecho del pasado, y borrarlo le
    -- quitaba la recuperación. Lo que esta temporal nueva no se ha estrenado lo dicen
    -- `is_temporary` y `temp_used_at`, que son las columnas de esta credencial.
    UPDATE credential
       SET hash = p_hash, is_temporary = true, temp_expires_at = p_expires_at,
           updated_at = now()
     WHERE id = v_credential;
  END IF;

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
    -- Igual que en el reenvío de la doctora: el hash se reemplaza y
    -- **`temp_first_used_at` NO SE TOCA** (0017).
    UPDATE credential
       SET hash = p_hash, is_temporary = true, temp_expires_at = p_expires_at,
           updated_at = now()
     WHERE id = v_credential;
  END IF;

  RETURN QUERY SELECT 'acceso_renovado', p_expires_at;
END
$$;--> statement-breakpoint
