-- Tramo 1 · consentimiento. El alta de pacientes reusaba CUALQUIER cuenta con ese correo,
-- sin mirar `account.role`.
--
-- §3.4, regla 7 · §1.5 del napkin: versionada, y NUNCA editada después de aplicarse.
--
-- =======================================================================================
-- QUÉ ESTABA MAL
--
-- `medskin_create_patient_account` buscaba `account WHERE email = p_email` y, si había
-- fila, la devolvía como `already_existed`. El endpoint le colgaba entonces su `patient` y
-- su `patient_link`. Con el correo de una practicante —el de la propia doctora, o el de una
-- doctora de otra consulta— eso ataba ESA cuenta como paciente de esta consulta.
--
-- No es una fuga entre inquilinos: lo que esa persona vería por `patient_link` es el nombre
-- de la consulta, el de la doctora y la ciudad, y nada clínico. **Es una identidad enlazada
-- sin su consentimiento**, que es otra clase de problema y no es menor: la pantalla de
-- «Mis doctoras» de alguien se llena con una consulta que no eligió, y su cuenta de trabajo
-- pasa a ser también la cuenta de paciente de un tercero.
--
-- Y no se podía cerrar en el borde: `app_practitioner` no tiene ninguna política de
-- `SELECT` sobre `account` más que su propia fila (`_convenciones.md` · «La doctora no lee
-- la cuenta de nadie más que la suya»), así que **solo esta función puede verlo**. Cerrarlo
-- aquí es lo único que no exige abrirle `account` a la doctora, que es justo lo que no se
-- va a hacer.
--
-- LO QUE **NO** CAMBIA, Y HAY QUE LEERLO ANTES DE TOCAR ESTO: reusar la cuenta de una
-- PACIENTE sigue siendo correcto y es la decisión escrita del contrato (§12.2.1). Una
-- paciente de dos doctoras tiene UNA cuenta y DOS fichas que no comparten nada, y
-- `patient_link` es lo que las une. Lo que se cierra es el caso `practitioner` y nada más.
--
-- =======================================================================================
-- POR QUÉ EL VEREDICTO NO DICE POR QUÉ
--
-- `email_unavailable`, sin decir que es de una practicante, del mismo vocabulario que el
-- `email_taken` de `medskin_create_team_member`. El endpoint lo mapea a
-- **`409 correo_no_disponible`**, el mismo código opaco que el alta de equipo y por el mismo
-- motivo escrito en `cuentas.md`.
--
-- Si el veredicto dijera «ese correo es de una practicante», cualquier doctora tendría una
-- sonda para ir averiguando, de uno en uno, qué correos son de personal: escribe el correo
-- en el alta, lee el motivo y ya lo sabe. El código opaco deja la frase en «ese correo no
-- se puede usar aquí», que es verdad y no dice de quién es.
--
-- **El resto de señal que queda, dicho para que nadie crea que esto es más de lo que es:**
-- un correo desconocido da 201, el de una paciente da 201 y el de una practicante da 409,
-- así que una doctora insistente todavía distingue «practicante» de «paciente o
-- desconocido». Eso es estructural y no se puede quitar sin romper lo que el contrato
-- exige: el alta TIENE que funcionar con el correo de una paciente y TIENE que fallar con
-- el de una practicante. Lo que esta migración cierra es el motivo; la diferencia de
-- resultado es la función del endpoint.
--
-- =======================================================================================
-- LA FIRMA · los ARGUMENTOS no cambian, la salida gana una columna
--
-- `DROP` y no `CREATE OR REPLACE` porque cambian las columnas de salida y Postgres no deja
-- cambiar el tipo de retorno. Los seis argumentos son los mismos y en el mismo orden, así
-- que la llamada `($1 … $6)` no se toca; lo que cambia es la lista de columnas que el borde
-- pide —hoy `select account_id, already_existed`— y la rama nueva. `verdict` va primero,
-- como en las otras funciones de esta familia (`create_team_member`,
-- `create_practice_owner`), y `already_existed` se queda **para no romper lo que ya lee**:
-- `created` ↔ `false`, `ya_tiene_cuenta` ↔ `true`.
-- =======================================================================================

DROP FUNCTION medskin_create_patient_account(citext, text, text, text, text, timestamptz);--> statement-breakpoint

CREATE FUNCTION medskin_create_patient_account(
  p_email citext,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_hash text,
  p_expires_at timestamptz
) RETURNS TABLE (verdict text, account_id uuid, already_existed boolean, status text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_practice uuid := medskin_current_practice();
  v_region text;
  v_account uuid;
  v_status text;
  v_role text;
BEGIN
  IF v_practice IS NULL THEN
    RAISE EXCEPTION 'medskin_create_patient_account: sin contexto de inquilino'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_email IS NULL OR btrim(p_email::text) = ''
     OR p_first_name IS NULL OR btrim(p_first_name) = ''
     OR p_last_name IS NULL OR btrim(p_last_name) = '' THEN
    RAISE EXCEPTION 'medskin_create_patient_account: faltan correo, nombre o apellido'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_hash IS NULL OR p_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'medskin_create_patient_account: la temporal no viene hasheada con Argon2id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- 72 h, «y no se negocia por canal» (cuentas.md). La cota deja margen de reloj y nada más.
  IF p_expires_at IS NULL OR p_expires_at <= now()
     OR p_expires_at > now() + interval '73 hours' THEN
    RAISE EXCEPTION 'medskin_create_patient_account: la temporal vive 72 h'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT p.region INTO v_region FROM practice p WHERE p.id = v_practice;
  IF v_region IS NULL THEN
    RAISE EXCEPTION 'medskin_create_patient_account: el inquilino del contexto no existe'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.id, a.status, a.role INTO v_account, v_status, v_role
    FROM account a WHERE a.email = p_email;

  IF v_account IS NOT NULL THEN
    -- 0021 · CONSENTIMIENTO. Una cuenta de practicante no se convierte en la paciente de
    -- nadie, ni la de la propia doctora que escribe el alta. Y no se devuelve nada que
    -- diga por qué: `email_unavailable` -> `409 correo_no_disponible`.
    IF v_role <> 'paciente' THEN
      RETURN QUERY SELECT 'email_unavailable', NULL::uuid, NULL::boolean, NULL::text;
      RETURN;
    END IF;
    -- Y este camino es el del contrato y se queda: una paciente de dos doctoras tiene una
    -- cuenta y dos fichas (§12.2.1).
    RETURN QUERY SELECT 'ya_tiene_cuenta', v_account, true, v_status;
    RETURN;
  END IF;

  INSERT INTO account (email, role, region, first_name, last_name, phone)
  VALUES (p_email, 'paciente', v_region, btrim(p_first_name), btrim(p_last_name),
          nullif(btrim(coalesce(p_phone, '')), ''))
  RETURNING account.id, account.status INTO v_account, v_status;

  INSERT INTO credential (account_id, hash, is_temporary, temp_expires_at)
  VALUES (v_account, p_hash, true, p_expires_at);

  RETURN QUERY SELECT 'created', v_account, false, v_status;
END
$$;--> statement-breakpoint

-- `v_role <> 'paciente'` y no `= 'practitioner'`: `account_role_ck` admite hoy esos dos
-- valores, y el día que haya un tercero —personal de plataforma con fila, un rol de
-- integración— el que se añade NO debería poder ser la paciente de nadie por omisión. La
-- comparación cerrada falla hacia el lado seguro sin que haya que acordarse de volver aquí.

ALTER FUNCTION medskin_create_patient_account(citext, text, text, text, text, timestamptz)
  OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_create_patient_account(citext, text, text, text, text, timestamptz)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_create_patient_account(citext, text, text, text, text, timestamptz)
  TO app_practitioner;--> statement-breakpoint
