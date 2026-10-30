-- =======================================================================================
-- LA ENTRADA DE LA CONSOLA · la tabla de cuentas de plataforma y sus dos funciones
--
-- Decidido el 30 de octubre de 2026 (`plataforma-acceso.md` · «La entrada de la consola»).
-- El servicio de identidad de plataforma no existe, no está en ningún repositorio y no tiene
-- fecha. Sin él nadie firma un token de consola, los cinco endpoints están implementados y son
-- inalcanzables, y la primera doctora tendría que entrar por un script contra la base de
-- producción — que es exactamente lo que aquel documento se escribió para evitar.
--
-- POR QUÉ UNA TABLA PROPIA Y NO UN VALOR MÁS EN `account.role`. Se descartó por escrito el 27
-- y otra vez el 30 de octubre, y la razón no es de gusto: la política de `account` es UNA sola
-- línea —`id = medskin_current_account()`— y es lo que impide que una doctora lea la cuenta de
-- nadie más. Meter aquí la cuenta que puede abrir el padrón de TODAS las consultas obliga a
-- escribir «salvo si es de plataforma» en esa línea, y a revisar las 44 políticas que
-- mencionan `account`. La tabla propia no toca ninguna.
--
-- Y LO QUE NO CAMBIA, que es la mitad del valor de esta migración: el guardia, la tabla de
-- rutas, el formato del token, el `kid`, el `aud`, la lista cerrada de permisos, los quince
-- minutos y las políticas de `app_platform` sobre lo clínico. Lo único que se añade es QUIÉN
-- emite el token que el guardia ya sabe verificar.
--
-- La vuelta atrás, el día que el servicio de plataforma exista: quitar la privada del
-- despliegue, borrar una línea de `route-policy.ts` y dejar esta tabla vacía. Ninguna de las
-- tres es una migración de datos.
-- =======================================================================================
CREATE TABLE "platform_account" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email"           citext NOT NULL UNIQUE,
  "password_hash"   text NOT NULL,
  "label"           text NOT NULL,
  "permissions"     text[] NOT NULL,
  "status"          text NOT NULL DEFAULT 'activa',
  "failed_attempts" integer NOT NULL DEFAULT 0,
  "locked_until"    timestamptz,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_account_status_ck  CHECK ("status" IN ('activa','suspendida')),
  CONSTRAINT platform_account_label_ck   CHECK (length(btrim("label")) BETWEEN 1 AND 120),
  -- Una fila que no dice qué puede hacer no puede hacer nada. `permissions` no admite nulo
  -- NI lista vacía, y es la diferencia con `practitioner.permissions`: allí nulo significa
  -- «los de su rol» porque hay roles; aquí no los hay, y una lista que el servidor
  -- resolviera sola sería una autorización que nadie revisó.
  CONSTRAINT platform_account_perms_ck   CHECK (cardinality("permissions") > 0)
);--> statement-breakpoint

-- RLS forzada y NINGÚN rol de aplicación la lee, `app_platform` incluido: la consola no puede
-- leer la tabla de cuentas de la consola. Ninguno de los cinco endpoints lo necesita, y lo que
-- no se puede consultar no se puede filtrar por un error de política. Se entra por las dos
-- funciones de abajo, que devuelven lo justo y nunca la fila.
ALTER TABLE "platform_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_account" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "platform_account" TO medskin_access;--> statement-breakpoint
CREATE POLICY platform_account_access ON "platform_account" FOR ALL TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- LA CREDENCIAL · el hash a verificar, real o señuelo
--
-- Calcada de `medskin_access_credential` (0002) y por la misma razón: devuelve SIEMPRE un
-- hash. Si el correo no existe, el de `access_decoy`, para que el llamador ejecute Argon2id
-- en los dos casos y el «no existe» no se pueda medir con un cronómetro. `platform_account_id`
-- nulo significa señuelo, y eso lo sabe el proceso — nunca la respuesta HTTP, que es un solo
-- `401 acceso_no_coincide` en los dos casos.
--
-- `STABLE` porque solo lee. La que escribe es la de abajo, y está separada a propósito: así no
-- hay ningún camino en que el llamador pueda saltarse el verificado.
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION medskin_platform_credential(p_email citext)
RETURNS TABLE (platform_account_id uuid, label text, permissions text[], status text,
               hash text, locked_until timestamptz, attempts_left integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_decoy text;
BEGIN
  IF p_email IS NULL OR btrim(p_email::text) = '' THEN
    RAISE EXCEPTION 'medskin_platform_credential: correo vacio'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT d.hash INTO v_decoy FROM access_decoy d WHERE d.only_row;
  IF v_decoy IS NULL THEN
    -- Sin señuelo no hay «mismo tiempo», y sin «mismo tiempo» el 401 miente. Antes fallar la
    -- entrada entera que servirla con el oráculo abierto.
    RAISE EXCEPTION 'medskin_platform_credential: falta el hash senuelo'
      USING ERRCODE = 'internal_error';
  END IF;

  RETURN QUERY
    SELECT pa.id, pa.label, pa.permissions, pa.status, pa.password_hash, pa.locked_until,
           greatest(5 - pa.failed_attempts, 0)
      FROM platform_account pa
     WHERE pa.email = p_email;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, NULL::text[], NULL::text, v_decoy,
                        NULL::timestamptz, 5;
  END IF;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_platform_credential(citext) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_platform_credential(citext) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_platform_credential(citext) TO app_anonymous;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- EL INTENTO · la pausa y la línea de bitácora
--
-- Misma escalera que `account`: 5 intentos → 15 minutos, y el contador vuelve a 0 al disparar
-- la pausa. Si no volviera a 0, pasada la pausa el sexto intento dispararía otra y la cuenta
-- quedaría sellada para siempre.
--
-- UN CORREO SIN FILA NO DEJA RASTRO. No se le inventa una cuenta donde contar —sería un padrón
-- de correos tecleados— y tampoco se escribe bitácora: `access_audit` no guarda el correo, así
-- que una línea sin actor no diría nada y una con él sería ese padrón. Lo que hace idéntica la
-- respuesta para un correo que no existe son los contadores de `rate_counter`, por HMAC del
-- correo y por IP, que los pone el caso de uso antes de llegar aquí.
--
-- `region` queda nula: la firma de esta función es de dos argumentos por contrato, y el
-- despliegue que la ejecuta no viaja hasta aquí. La región del token la pone el firmador desde
-- `cfg.REGION`, que es donde no se puede falsear.
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION medskin_platform_attempt(p_email citext, p_success boolean)
RETURNS TABLE (attempts_left integer, locked_until timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  c_limit constant integer := 5;
  c_pause constant interval := interval '15 minutes';
  v_id uuid;
  v_label text;
  v_attempts integer;
  v_locked timestamptz;
BEGIN
  IF p_email IS NULL OR btrim(p_email::text) = '' OR p_success IS NULL THEN
    RAISE EXCEPTION 'medskin_platform_attempt: argumentos incompletos'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT pa.id, pa.label, pa.failed_attempts INTO v_id, v_label, v_attempts
    FROM platform_account pa WHERE pa.email = p_email FOR UPDATE;

  IF v_id IS NULL THEN
    RETURN QUERY SELECT c_limit, NULL::timestamptz;
    RETURN;
  END IF;

  IF p_success THEN
    UPDATE platform_account pa
       SET failed_attempts = 0, locked_until = NULL, updated_at = now()
     WHERE pa.id = v_id;

    INSERT INTO access_audit (practice_id, actor_account_id, actor_label, action,
                              subject_type, subject_id, data, region)
    VALUES (NULL, v_id, v_label, 'platform.sign_in', 'platform_account', v_id,
            jsonb_build_object('success', true), NULL);

    RETURN QUERY SELECT c_limit, NULL::timestamptz;
    RETURN;
  END IF;

  v_attempts := v_attempts + 1;
  IF v_attempts >= c_limit THEN
    v_locked := now() + c_pause;
    v_attempts := 0;
  END IF;

  UPDATE platform_account pa
     SET failed_attempts = v_attempts,
         locked_until = coalesce(v_locked, pa.locked_until),
         updated_at = now()
   WHERE pa.id = v_id;

  INSERT INTO access_audit (practice_id, actor_account_id, actor_label, action,
                            subject_type, subject_id, data, region)
  VALUES (NULL, v_id, v_label, 'platform.sign_in', 'platform_account', v_id,
          jsonb_build_object('success', false, 'locked', v_locked IS NOT NULL), NULL);

  RETURN QUERY SELECT CASE WHEN v_locked IS NULL THEN c_limit - v_attempts ELSE 0 END, v_locked;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_platform_attempt(citext, boolean) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_platform_attempt(citext, boolean) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_platform_attempt(citext, boolean) TO app_anonymous;
