-- =======================================================================================
-- LOS ROLES SE DICEN EN INGLÉS, Y SON TRES · decidido por el dueño el 30 de octubre de 2026
--
-- `account.role` pasa de `practitioner | paciente` a **`doctor | patient`**, y
-- `practitioner.role` pasa de tres valores a **uno**: `doctor`.
--
-- POR QUÉ DESAPARECEN `recepcion` Y `asistente_clinico`. No los pidió nadie: salieron de un
-- paréntesis del documento de diseño —«practitioner N (doctor, asistente, recepción,
-- solo-lectura)»— que describía una TABLA, no un requisito de producto, y de ahí se
-- construyeron tres listas de permisos, dos endpoints y una pantalla. El propio diseño pone
-- el «equipo con roles» en la FASE 3, así que además estaba adelantado dos fases. Y el
-- estado del diseño ya había decidido lo contrario de lo que se hizo: «permisos como
-- interruptores, no como roles».
--
-- Lo que es peor y decide la cuestión: NINGUNA de las 136 políticas de esta base distinguía
-- esos sub-roles. Los tres se conectaban como `app_practitioner` con el mismo `practice_id`,
-- así que lo único que separaba a recepción de una historia clínica eran dieciséis
-- comprobaciones en TypeScript. Una separación que vive en la capa débil y que un endpoint
-- nuevo puede olvidar no es una separación. Quien quiera acotar a alguien dentro de una
-- consulta usa `practitioner.permissions`, que es explícita y la revisa una persona.
--
-- Y DE PASO LOS DEMÁS VALORES QUE DECÍAN LO MISMO EN ESPAÑOL. `photo.uploaded_by`,
-- `message.author`, `appointment.cancelled_by`, `consent.signed_by` y el dominio
-- `medskin_history_source` usaban `paciente`, `doctora`, `consulta`, `sistema` y `tutor`.
-- Dejar esos en español con los roles en inglés sería peor que no haber cambiado nada: dos
-- vocabularios para la misma cosa en la misma fila.
--
-- Y CONVIERTE LOS DATOS ANTES DE CAMBIAR CADA `CHECK`. La base de producción está vacía —es
-- la regla de la casa, «en PROD no se siembra nada»— así que ahí no hay nada que convertir;
-- pero la de desarrollo tiene las filas que siembran las pruebas, y una migración que solo
-- funciona contra una base vacía se rompe en la máquina de quien la escribió. Los `UPDATE`
-- de abajo son idempotentes: la segunda pasada no alcanza ninguna fila.
-- =======================================================================================

-- Las dos funciones del equipo, que ya no tienen quien las llame.
DROP FUNCTION IF EXISTS medskin_create_team_member(citext, text, text, text, text, timestamptz);--> statement-breakpoint
DROP FUNCTION IF EXISTS medskin_resend_team_access(uuid, text, timestamptz);--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- EL ORDEN DE CADA UNO: QUITAR LA REGLA, CONVERTIR, PONER LA NUEVA
--
-- Y es en ese orden porque no hay otro que funcione: un `UPDATE` a `doctor` con el `CHECK`
-- viejo todavía puesto viola la regla antigua, y un `CHECK` nuevo sobre datos sin convertir
-- viola la nueva. Entre las dos hay una ventana sin regla, dentro de la transacción de la
-- migración, que es donde se convierte.
-- ---------------------------------------------------------------------------------------
ALTER TABLE "account" DROP CONSTRAINT IF EXISTS account_role_ck;--> statement-breakpoint
UPDATE "account" SET "role" = CASE "role" WHEN 'practitioner' THEN 'doctor'
                                          WHEN 'paciente' THEN 'patient'
                                          ELSE "role" END
 WHERE "role" IN ('practitioner','paciente');--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT account_role_ck
  CHECK ("role" IN ('doctor','patient'));--> statement-breakpoint

-- Los dos roles que se van se convierten en `doctor`: son filas de desarrollo y en PROD no
-- existe ninguna. Lo que acota a esa persona pasa a ser su `permissions`, no su rol.
ALTER TABLE "practitioner" DROP CONSTRAINT IF EXISTS practitioner_role_ck;--> statement-breakpoint
UPDATE "practitioner" SET "role" = 'doctor' WHERE "role" <> 'doctor';--> statement-breakpoint
ALTER TABLE "practitioner" ADD CONSTRAINT practitioner_role_ck
  CHECK ("role" = 'doctor');--> statement-breakpoint

ALTER TABLE "photo" DROP CONSTRAINT IF EXISTS photo_uploaded_by_ck;--> statement-breakpoint
UPDATE "photo" SET "uploaded_by" = CASE "uploaded_by" WHEN 'doctora' THEN 'doctor'
                                                      WHEN 'paciente' THEN 'patient'
                                                      ELSE "uploaded_by" END
 WHERE "uploaded_by" IN ('doctora','paciente');--> statement-breakpoint
ALTER TABLE "photo" ADD CONSTRAINT photo_uploaded_by_ck
  CHECK ("uploaded_by" IN ('doctor','patient'));--> statement-breakpoint

ALTER TABLE "message" DROP CONSTRAINT IF EXISTS message_author_ck;--> statement-breakpoint
UPDATE "message" SET "author" = CASE "author" WHEN 'paciente' THEN 'patient'
                                              WHEN 'consulta' THEN 'practice'
                                              ELSE "author" END
 WHERE "author" IN ('paciente','consulta');--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT message_author_ck
  CHECK ("author" IN ('patient','practice'));--> statement-breakpoint

ALTER TABLE "appointment" DROP CONSTRAINT IF EXISTS appointment_cancelled_by_ck;--> statement-breakpoint
UPDATE "appointment" SET "cancelled_by" = CASE "cancelled_by" WHEN 'paciente' THEN 'patient'
                                                              WHEN 'consulta' THEN 'practice'
                                                              WHEN 'sistema' THEN 'system'
                                                              ELSE "cancelled_by" END
 WHERE "cancelled_by" IN ('paciente','consulta','sistema');--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT appointment_cancelled_by_ck
  CHECK ("cancelled_by" IS NULL OR "cancelled_by" IN ('patient','practice','system'));--> statement-breakpoint

-- Y el DEFAULT de la columna, que también decía `paciente`: cambiar solo el `CHECK` deja un
-- valor por omisión que la nueva regla rechaza, y entonces TODO insert que no nombre la
-- columna revienta. Lo encontró una prueba de imágenes que insertaba un consentimiento sin
-- `signed_by` y se quedaba sin consentimiento.
ALTER TABLE "consent" ALTER COLUMN "signed_by" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "consent" DROP CONSTRAINT IF EXISTS consent_signed_by_ck;--> statement-breakpoint
UPDATE "consent" SET "signed_by" = CASE "signed_by" WHEN 'paciente' THEN 'patient'
                                                    WHEN 'tutor' THEN 'guardian'
                                                    ELSE "signed_by" END
 WHERE "signed_by" IN ('paciente','tutor');--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT consent_signed_by_ck
  CHECK ("signed_by" IN ('patient','guardian'));--> statement-breakpoint
ALTER TABLE "consent" ALTER COLUMN "signed_by" SET DEFAULT 'patient';--> statement-breakpoint

-- El dominio «quién escribió este antecedente», y lo usan NUEVE columnas: siete en
-- `medical_history` y dos en su bitácora. Mismo orden por la misma razón.
ALTER DOMAIN medskin_history_source DROP CONSTRAINT IF EXISTS medskin_history_source_ck;--> statement-breakpoint
UPDATE "medical_history" SET "allergies_source" = CASE "allergies_source"::text WHEN 'doctora' THEN 'doctor' ELSE 'patient' END
 WHERE "allergies_source"::text IN ('doctora','paciente');--> statement-breakpoint
UPDATE "medical_history" SET "medication_source" = CASE "medication_source"::text WHEN 'doctora' THEN 'doctor' ELSE 'patient' END
 WHERE "medication_source"::text IN ('doctora','paciente');--> statement-breakpoint
UPDATE "medical_history" SET "pregnancy_or_lactation_source" = CASE "pregnancy_or_lactation_source"::text WHEN 'doctora' THEN 'doctor' ELSE 'patient' END
 WHERE "pregnancy_or_lactation_source"::text IN ('doctora','paciente');--> statement-breakpoint
UPDATE "medical_history" SET "past_conditions_source" = CASE "past_conditions_source"::text WHEN 'doctora' THEN 'doctor' ELSE 'patient' END
 WHERE "past_conditions_source"::text IN ('doctora','paciente');--> statement-breakpoint
UPDATE "medical_history" SET "previous_treatments_source" = CASE "previous_treatments_source"::text WHEN 'doctora' THEN 'doctor' ELSE 'patient' END
 WHERE "previous_treatments_source"::text IN ('doctora','paciente');--> statement-breakpoint
UPDATE "medical_history" SET "phototype_source" = CASE "phototype_source"::text WHEN 'doctora' THEN 'doctor' ELSE 'patient' END
 WHERE "phototype_source"::text IN ('doctora','paciente');--> statement-breakpoint
UPDATE "medical_history" SET "notes_source" = CASE "notes_source"::text WHEN 'doctora' THEN 'doctor' ELSE 'patient' END
 WHERE "notes_source"::text IN ('doctora','paciente');--> statement-breakpoint
UPDATE "medical_history_audit" SET "previous_source" = CASE "previous_source"::text WHEN 'doctora' THEN 'doctor' ELSE 'patient' END
 WHERE "previous_source"::text IN ('doctora','paciente');--> statement-breakpoint
UPDATE "medical_history_audit" SET "actor_source" = CASE "actor_source"::text WHEN 'doctora' THEN 'doctor' ELSE 'patient' END
 WHERE "actor_source"::text IN ('doctora','paciente');--> statement-breakpoint
ALTER DOMAIN medskin_history_source ADD CONSTRAINT medskin_history_source_ck
  CHECK (VALUE IN ('doctor','patient'));--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- LAS TRES POLÍTICAS DE `photo` QUE COMPARABAN CON 'paciente'
--
-- Se recrean enteras y no se parchean: una política es una expresión, no un texto, y
-- `ALTER POLICY` sin el `USING` completo deja la mitad vieja.
-- ---------------------------------------------------------------------------------------
DROP POLICY IF EXISTS photo_patient_insert ON "photo";--> statement-breakpoint
CREATE POLICY photo_patient_insert ON "photo" FOR INSERT TO app_patient
  WITH CHECK (uploaded_by = 'patient' AND EXISTS (
    SELECT 1 FROM patient_link l
     WHERE l.patient_id = photo.patient_id
       AND l.account_id = medskin_current_account()
       AND l.status = 'vinculada'));--> statement-breakpoint

DROP POLICY IF EXISTS photo_patient_update ON "photo";--> statement-breakpoint
CREATE POLICY photo_patient_update ON "photo" FOR UPDATE TO app_patient
  USING (uploaded_by = 'patient' AND EXISTS (
    SELECT 1 FROM patient_link l
     WHERE l.patient_id = photo.patient_id
       AND l.account_id = medskin_current_account()
       AND l.status = 'vinculada'))
  WITH CHECK (uploaded_by = 'patient');--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- LAS CUATRO FUNCIONES QUE LLEVABAN LOS VALORES DENTRO
--
-- Copiadas de la definición viva con los literales cambiados y nada más: `CREATE OR REPLACE`
-- conserva dueño y permisos, así que `medskin_access` sigue siendo la dueña y `app_anonymous`
-- conserva su `EXECUTE`. Las otras siete funciones no se tocan: la palabra aparecía en sus
-- comentarios, no en una comparación.
-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.medskin_create_patient_account(p_email citext, p_first_name text, p_last_name text, p_phone text, p_hash text, p_expires_at timestamp with time zone)
 RETURNS TABLE(verdict text, account_id uuid, already_existed boolean, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
    IF v_role <> 'patient' THEN
      RETURN QUERY SELECT 'email_unavailable', NULL::uuid, NULL::boolean, NULL::text;
      RETURN;
    END IF;
    -- Y este camino es el del contrato y se queda: una paciente de dos doctoras tiene una
    -- cuenta y dos fichas (§12.2.1).
    RETURN QUERY SELECT 'ya_tiene_cuenta', v_account, true, v_status;
    RETURN;
  END IF;

  INSERT INTO account (email, role, region, first_name, last_name, phone)
  VALUES (p_email, 'patient', v_region, btrim(p_first_name), btrim(p_last_name),
          nullif(btrim(coalesce(p_phone, '')), ''))
  RETURNING account.id, account.status INTO v_account, v_status;

  INSERT INTO credential (account_id, hash, is_temporary, temp_expires_at)
  VALUES (v_account, p_hash, true, p_expires_at);

  RETURN QUERY SELECT 'created', v_account, false, v_status;
END
$function$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.medskin_create_practice_owner(p_practice_id uuid, p_email citext, p_first_name text, p_last_name text, p_hash text, p_expires_at timestamp with time zone)
 RETURNS TABLE(verdict text, account_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_region text;
  v_owner uuid;
  v_account uuid;
BEGIN
  IF p_practice_id IS NULL OR p_email IS NULL OR btrim(p_email::text) = ''
     OR p_first_name IS NULL OR btrim(p_first_name) = ''
     OR p_last_name IS NULL OR btrim(p_last_name) = '' THEN
    RAISE EXCEPTION 'medskin_create_practice_owner: argumentos incompletos'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_hash IS NULL OR p_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'medskin_create_practice_owner: la temporal no viene hasheada con Argon2id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now()
     OR p_expires_at > now() + interval '73 hours' THEN
    RAISE EXCEPTION 'medskin_create_practice_owner: la temporal vive 72 h'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT p.region, p.owner_account_id INTO v_region, v_owner
    FROM practice p WHERE p.id = p_practice_id FOR UPDATE;
  IF v_region IS NULL THEN
    RETURN QUERY SELECT 'practice_not_found', NULL::uuid;
    RETURN;
  END IF;
  -- Refuerzo de la clave natural `(correo_doctora, region)`: un reintento no pone una
  -- segunda dueña.
  IF v_owner IS NOT NULL THEN
    RETURN QUERY SELECT 'practice_has_owner', v_owner;
    RETURN;
  END IF;

  SELECT a.id INTO v_account FROM account a WHERE a.email = p_email;
  IF v_account IS NOT NULL THEN
    RETURN QUERY SELECT 'email_taken', v_account;
    RETURN;
  END IF;

  INSERT INTO account (email, role, region, first_name, last_name)
  VALUES (p_email, 'doctor', v_region, btrim(p_first_name), btrim(p_last_name))
  RETURNING account.id INTO v_account;

  INSERT INTO credential (account_id, hash, is_temporary, temp_expires_at)
  VALUES (v_account, p_hash, true, p_expires_at);

  -- `permissions` nulo: los de su rol (decisión 11).
  INSERT INTO practitioner (practice_id, account_id, first_name, last_name, role)
  VALUES (p_practice_id, v_account, btrim(p_first_name), btrim(p_last_name), 'doctor');

  UPDATE practice p SET owner_account_id = v_account, updated_at = now()
   WHERE p.id = p_practice_id;

  -- LO ÚNICO NUEVO DE LA 0015. `sin_enviar` sale del `DEFAULT`, que es lo que el 201 del
  -- contrato promete. `ON CONFLICT` y no un `IF NOT EXISTS` porque la siembra de las
  -- pruebas y de `seed.ts` crea su propia fila con `id` fijo: el que llegue primero gana y
  -- el segundo no revienta.
  INSERT INTO license (practice_id) VALUES (p_practice_id)
  ON CONFLICT (practice_id) DO NOTHING;

  RETURN QUERY SELECT 'created', v_account;
END
$function$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.medskin_purge_retained(p_limit integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_row record;
  v_done integer := 0;
BEGIN
  FOR v_row IN
    SELECT p.id, p.practice_id, l.retention_until
      FROM patient_link l
      JOIN patient p ON p.id = l.patient_id
     WHERE l.account_id IS NULL
       AND l.retention_until IS NOT NULL
       AND l.retention_until <= current_date
       AND p.purged_at IS NULL
     ORDER BY l.retention_until
     LIMIT greatest(1, least(coalesce(p_limit, 50), 500))
  LOOP
    DELETE FROM medical_history WHERE patient_id = v_row.id;
    DELETE FROM medical_history_audit WHERE patient_id = v_row.id;
    DELETE FROM consent WHERE patient_id = v_row.id;
    DELETE FROM message WHERE thread_id IN (
      SELECT t.id FROM message_thread t WHERE t.patient_id = v_row.id
    );
    DELETE FROM message_thread WHERE patient_id = v_row.id;

    UPDATE photo
       SET deleted_at = coalesce(deleted_at, now()),
           deleted_reason = coalesce(deleted_reason, 'plazo_de_conservacion_cumplido'),
           updated_at = now()
     WHERE patient_id = v_row.id AND deleted_at IS NULL;

    UPDATE patient
       SET first_name = 'Ficha',
           last_name = 'anonimizada',
           birth_date = '1900-01-01',
           email = ('anonima+' || v_row.id::text || '@medskin.invalid')::citext,
           phone = NULL,
           has_whatsapp = false,
           status = 'archivada',
           archived_at = coalesce(archived_at, now()),
           purged_at = now(),
           updated_at = now()
     WHERE id = v_row.id;

    DELETE FROM patient_link WHERE patient_id = v_row.id AND account_id IS NULL;

    INSERT INTO access_audit (practice_id, action, subject_type, subject_id, data)
    VALUES (v_row.practice_id, 'paciente.plazo_cumplido', 'patient', v_row.id,
            jsonb_build_object('retention_until', v_row.retention_until));

    v_done := v_done + 1;
  END LOOP;
  RETURN v_done;
END
$function$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.medskin_session_refresh(p_hash text, p_new_hash text, p_patient_seconds integer, p_practitioner_seconds integer)
 RETURNS TABLE(verdict text, session_id uuid, account_id uuid, practice_id uuid, scope text, role text, practitioner_role text, permissions text[], account_status text, password_is_temporary boolean, license_status text, first_day_done boolean, refresh_expires_at timestamp with time zone, graced boolean)
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
$function$;