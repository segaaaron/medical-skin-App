-- Tramo 1 · el quinto rol, y el rol dentro de la consulta que faltaba en el veredicto.
-- Las dos cosas las levantó `backend-senior` implementando el camino de recuperación.
--
-- =======================================================================================
-- 1 · app_account · EL ROL DE «SÉ QUIÉN ERES Y NO SÉ QUÉ ERES»
--
-- EL PROBLEMA: el token de recuperación NO lleva el rol, y es a propósito —el cuerpo de un
-- JWT no tiene por qué decir si la persona es doctora o paciente—. Así que
-- `POST /v1/acceso/contrasena-nueva` por el camino del código tiene que adoptar un rol de
-- base sin saber qué es quien llama, y el único que no exige `practice_id` era
-- `app_patient`. Funciona y es seguro: `account`, `credential` y `session` tienen política
-- por `account_id`, y `medskin_set_final_password()` se autoriza por `medskin.account_id` y
-- nunca por un argumento. **Pero el nombre miente**, y por ahí entra una doctora.
--
-- SE AÑADE UN QUINTO ROL EN VEZ DE RENOMBRAR EL CUARTO, y la razón es que renombrar movería
-- la mentira de sitio en vez de quitarla: desde el tramo 2, `app_patient` **sí** tiene
-- políticas que son solo de paciente —`patient_link` por `account_id` y `medical_history`
-- a través del vínculo aceptado—, así que un rol llamado `app_account` que cargara con
-- políticas sobre antecedentes clínicos sería peor que lo de hoy. Un rol nuevo deja cada
-- nombre diciendo la verdad: `app_patient` es la paciente con su expediente, `app_account`
-- es «quien soy yo y con quién estoy», sin decir qué soy.
--
-- (Y no hay que pagar el peaje de la 0001: ninguna política compara `'app_patient'` como
-- cadena. El único literal de nombre de rol en todo el esquema es `'app_platform'`, y no se
-- toca. Si algún día hay que renombrar un rol, ese literal es lo que hay que buscar.)
--
-- QUÉ PUEDE HACER, Y ES TODO LO QUE LOS DOS ENDPOINTS DEL TOKEN RESTRINGIDO NECESITAN:
--
--   · `account`, `credential`, `session`  → las políticas `*_own` por `account_id`, que ya
--     existen: se les añade el rol con `ALTER POLICY ... TO`. Una fila, la de quien
--     pregunta, exactamente como para los otros dos.
--   · `patient_link`, SOLO `SELECT`      → porque `GET /v1/cuentas/mia` es el otro endpoint
--     que el token restringido alcanza, y sus `doctoras[]` salen de ahí. Sin esto, una
--     paciente que entra a elegir su contraseña vería su lista de doctoras vacía, que es
--     mentirle sobre su propio expediente. No lleva `UPDATE`: aceptar o rechazar a una
--     doctora es un acto de una sesión completa, no de una a medio abrir.
--   · `service_failure` y `access_audit`, solo `INSERT` → un 500 de `contrasena-nueva` tiene
--     que llegar a la tabla (§10.3) y el cambio de contraseña tiene que dejar su línea.
--   · `EXECUTE` sobre las dos funciones de ese camino, y ni una más.
--
-- Y NADA de `patient`, `medical_history`, `medical_history_audit`, `practice`,
-- `practitioner`, `license` ni `idempotency_key`: con este rol no se lee un expediente ni
-- se escribe en una consulta. Sin `SUPERUSER`, sin `BYPASSRLS`, `NOINHERIT` como los
-- otros cuatro.
-- =======================================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_account') THEN
    CREATE ROLE app_account;
  END IF;
  ALTER ROLE app_account NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
END
$$;--> statement-breakpoint
GRANT app_account TO medskin;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_account;--> statement-breakpoint

-- Las cuatro políticas por fila, ampliadas. `ALTER POLICY ... TO` reescribe la lista
-- entera, así que los roles que ya estaban se vuelven a nombrar: quitar uno aquí sería
-- quitarle el acceso a su propia cuenta.
ALTER POLICY account_own ON "account" TO app_practitioner, app_patient, app_account;--> statement-breakpoint
ALTER POLICY credential_own ON "credential" TO app_practitioner, app_patient, app_account;--> statement-breakpoint
ALTER POLICY session_own ON "session" TO app_practitioner, app_patient, app_account;--> statement-breakpoint
-- `recovery_code` sigue sin un solo GRANT para ningún rol de aplicación: la política está
-- escrita porque el contrato la nombra, y la única vía sigue siendo la función.
ALTER POLICY recovery_code_own ON "recovery_code" TO app_patient, app_account;--> statement-breakpoint

-- Las mismas columnas que tienen los otros dos roles de sesión, ni una más.
GRANT SELECT (id, email, role, region, first_name, last_name, phone, status, locked_until,
              failed_attempts, deleted_at, created_at)
  ON "account" TO app_account;--> statement-breakpoint
GRANT UPDATE (email, phone, first_name, last_name, status, deleted_at, deletion_reason,
              updated_at)
  ON "account" TO app_account;--> statement-breakpoint
-- Y el `hash` no está, igual que para los otros: no hay `GRANT SELECT (hash)` para nadie.
GRANT SELECT (id, account_id, is_temporary, temp_expires_at, temp_first_used_at,
              temp_used_at, set_at, created_at, updated_at)
  ON "credential" TO app_account;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "session" TO app_account;--> statement-breakpoint
GRANT SELECT (id, practice_id, patient_id, account_id, status, practice_name,
              practitioner_name, city, created_at)
  ON "patient_link" TO app_account;--> statement-breakpoint
ALTER POLICY patient_link_patient_select ON "patient_link" TO app_patient, app_account;--> statement-breakpoint
GRANT INSERT ON "service_failure" TO app_account;--> statement-breakpoint
GRANT INSERT ON "access_audit" TO app_account;--> statement-breakpoint
GRANT USAGE ON SEQUENCE "service_failure_id_seq" TO app_account;--> statement-breakpoint
GRANT USAGE ON SEQUENCE "access_audit_id_seq" TO app_account;--> statement-breakpoint
ALTER POLICY service_failure_insert ON "service_failure"
  TO app_practitioner, app_patient, app_platform, app_account;--> statement-breakpoint
ALTER POLICY access_audit_insert ON "access_audit"
  TO app_practitioner, app_patient, app_platform, app_account;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_current_credential() TO app_account;--> statement-breakpoint

-- =======================================================================================
-- 2 · medskin_set_final_password() DEVUELVE TAMBIÉN EL ROL DENTRO DE LA CONSULTA
--
-- La función ya leía `practitioner` para sacar `practice_id` y `permissions`, y no devolvía
-- `role`. Así que por el camino de recuperación —donde el token no dice qué es la persona—
-- había que leer `practitioner` en una SEGUNDA TRANSACCIÓN para saber si es doctora,
-- recepción o asistente, y eso abre una ventana real: la contraseña ya está guardada, y si
-- esa lectura falla, el 500 del contrato promete «todavía puedes entrar con la temporal»,
-- que en ese instante es falso —la temporal se consumió en la transacción anterior—.
--
-- Una columna más en el mismo `SELECT` que ya se hacía cierra la ventana sin añadir una
-- consulta. Es `DROP` + `CREATE` y no `CREATE OR REPLACE` porque cambia el tipo de retorno,
-- que es lo único que `CREATE OR REPLACE` no puede cambiar; de ahí que haya que volver a
-- poner dueño, revocación y grants, y se aprovecha para dárselo a `app_account`.
--
-- `practitioner_role` va junto a `role` porque son la pareja que el borde traduce: la
-- respuesta lleva `paciente` cuando `account.role = 'paciente'` y, si no, el
-- `practitioner.role` de esta consulta (_convenciones.md · «Los valores de `rol`»). El
-- resto del cuerpo es idéntico, línea por línea, al de la 0002.
-- =======================================================================================
DROP FUNCTION medskin_set_final_password(text, text, uuid);--> statement-breakpoint
CREATE FUNCTION medskin_set_final_password(p_hash text, p_via text, p_current_session uuid)
RETURNS TABLE (verdict text, account_id uuid, role text, practitioner_role text,
               practice_id uuid, permissions text[], sessions_revoked integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_account uuid := medskin_current_account();
  v_was_temporary boolean;
  v_code uuid;
  v_revoked integer := 0;
  v_role text;
  v_practitioner_role text;
  v_practice uuid;
  v_permissions text[];
BEGIN
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'medskin_set_final_password: sin contexto de cuenta'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_hash IS NULL OR length(p_hash) < 40 OR p_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'medskin_set_final_password: el hash no es de Argon2id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_via IS NULL OR p_via NOT IN ('temporal', 'recuperacion') THEN
    RAISE EXCEPTION 'medskin_set_final_password: via desconocida'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT c.is_temporary INTO v_was_temporary
    FROM credential c WHERE c.account_id = v_account FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_credential', v_account, NULL::text, NULL::text, NULL::uuid,
                        NULL::text[], 0;
    RETURN;
  END IF;

  IF p_via = 'temporal' AND NOT v_was_temporary THEN
    RETURN QUERY SELECT 'already_chosen', v_account, NULL::text, NULL::text, NULL::uuid,
                        NULL::text[], 0;
    RETURN;
  END IF;

  IF p_via = 'recuperacion' THEN
    UPDATE recovery_code rc
       SET used_at = now(), voided_at = now(), voided_reason = 'usado'
     WHERE rc.account_id = v_account AND rc.used_at IS NULL AND rc.voided_at IS NULL
       AND rc.expires_at > now()
     RETURNING rc.id INTO v_code;
    IF v_code IS NULL THEN
      RETURN QUERY SELECT 'no_code', v_account, NULL::text, NULL::text, NULL::uuid,
                          NULL::text[], 0;
      RETURN;
    END IF;
  END IF;

  UPDATE credential c
     SET hash = p_hash,
         is_temporary = false,
         temp_used_at = CASE WHEN v_was_temporary
                             THEN coalesce(c.temp_used_at, now())
                             ELSE c.temp_used_at END,
         set_at = now(),
         updated_at = now()
   WHERE c.account_id = v_account;

  UPDATE session s
     SET revoked_at = now(), revoked_reason = 'password_changed'
   WHERE s.account_id = v_account AND s.revoked_at IS NULL
     AND (p_current_session IS NULL OR s.id <> p_current_session);
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  SELECT a.role INTO v_role FROM account a WHERE a.id = v_account;
  -- La misma consulta que ya se hacía, con una columna más. `practitioner_role` sale nulo
  -- para una paciente, que es lo correcto: `paciente` no es un rol de `practitioner`.
  SELECT p.role, p.practice_id, p.permissions
    INTO v_practitioner_role, v_practice, v_permissions
    FROM practitioner p WHERE p.account_id = v_account AND p.status = 'activa'
   ORDER BY p.created_at, p.id LIMIT 1;

  RETURN QUERY SELECT 'saved', v_account, v_role, v_practitioner_role, v_practice,
                      v_permissions, v_revoked;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_set_final_password(text, text, uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_set_final_password(text, text, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_set_final_password(text, text, uuid)
  TO app_practitioner, app_patient, app_account;
