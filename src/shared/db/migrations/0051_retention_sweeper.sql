-- =======================================================================================
-- EL PLAZO DE CONSERVACIÓN TIENE QUIEN LO CUMPLA · 29 de octubre de 2026
--
-- El 200 del borrado de cuenta le dice a la paciente: «se_conserva.hasta: 2036-10-28». El
-- borrado escribía esa fecha en `access_audit` como hecho histórico y NADIE la leía después:
-- no había función, ni cola, ni barrido. Llega 2036 y el expediente sigue completo. «Sin
-- barrendero, el plazo no es un plazo: es una frase.»
--
-- LO QUE EL CONTRATO NO DECÍA, Y AQUÍ SE DECIDE (y queda escrito en `cuentas.md`):
--
-- 1 · AL VENCER EL PLAZO SE ANONIMIZA LA FICHA, NO SE BORRA LA FILA. Borrar `patient` arrastra
--     en cascada `payment` y `appointment`: la contabilidad y la agenda históricas de la
--     consulta. Eso no es cumplir un plazo de conservación de dato de salud, es destruir los
--     libros de un tercero. Lo que se va es el DATO DE SALUD y el DATO DE CONTACTO; lo que
--     queda es una fila sin persona dentro, que es lo que la contabilidad necesita y lo que
--     cualquier autoridad de protección de datos acepta como borrado.
--
-- 2 · LO QUE SE VA, EXACTAMENTE: nombre, apellido, nacimiento, correo, celular y notas de la
--     ficha; la fila entera de `medical_history` y su bitácora; los mensajes del hilo; los
--     consentimientos; y las fotos quedan marcadas para que el trabajador borre sus bytes.
--     Lo que queda: la ficha anonimizada con su `purged_at`, sus cobros, sus citas y la línea
--     de auditoría que dice que se fue.
--
-- 3 · DÓNDE VIVE LA FECHA. En `access_audit` no sirve: el correo de la cuenta se anonimiza al
--     borrarla, así que desde la bitácora no se puede volver a la ficha. La fecha va en el
--     VÍNCULO SUELTO, que es la fila que el borrado deja a propósito con su correo dentro. Si
--     la paciente vuelve (`medskin_relink_patient`, 0049), el vínculo deja de estar suelto y
--     el barrendero ya no lo ve: volver cancela el plazo, que es lo correcto.
-- =======================================================================================
ALTER TABLE "patient_link" ADD COLUMN "retention_until" date;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
-- Y en la foto, «los bytes ya se fueron»: sin esto no hay forma de distinguir una foto borrada
-- cuyos objetos siguen en el disco de una cuyos objetos ya no están.
ALTER TABLE "photo" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint

CREATE INDEX "patient_link_retention_idx" ON "patient_link" USING btree ("retention_until")
	WHERE "account_id" IS NULL AND "retention_until" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "photo_purge_idx" ON "photo" USING btree ("practice_id", "deleted_at")
	WHERE "deleted_at" IS NOT NULL AND "purged_at" IS NULL;--> statement-breakpoint

-- `medskin_delete_own_account` se REEMPLAZA para escribir el plazo en el vínculo que suelta.
-- Es la forma de corregir una función ya aplicada: la 0014 no se toca y esta es la siguiente
-- (§3.4, regla 7 · napkin §1.5). El cuerpo es el de la 0014 con UNA línea más —el
-- `retention_until` en el `UPDATE patient_link`— y se copia entero porque `CREATE OR REPLACE`
-- no admite parches.
CREATE OR REPLACE FUNCTION medskin_delete_own_account(p_retention_until date, p_reason text)
RETURNS TABLE (verdict text, deleted_at timestamptz, sessions_revoked integer,
               links_detached integer, practice_deleted boolean, patient_count integer,
               plan_renews_on date)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_account uuid := medskin_current_account();
  v_now timestamptz := now();
  v_deleted_at timestamptz;
  v_region text;
  v_label text;
  v_practice uuid;
  v_practitioner_role text;
  v_owner uuid;
  v_renews date;
  v_patients integer := 0;
  v_team boolean;
  v_sessions integer := 0;
  v_links integer := 0;
  v_practice_deleted boolean := false;
BEGIN
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'medskin_delete_own_account: sin contexto de cuenta'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_retention_until IS NULL OR p_retention_until <= current_date THEN
    RAISE EXCEPTION 'medskin_delete_own_account: el plazo de conservación ya pasó'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_reason IS NOT NULL AND length(p_reason) > 120 THEN
    RAISE EXCEPTION 'medskin_delete_own_account: el motivo no es un campo de texto libre'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.deleted_at, a.region, a.first_name || ' ' || a.last_name
    INTO v_deleted_at, v_region, v_label
    FROM account a WHERE a.id = v_account FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_account', NULL::timestamptz, 0, 0, false, NULL::integer,
                        NULL::date;
    RETURN;
  END IF;
  IF v_deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT 'already', v_deleted_at, 0, 0, false, NULL::integer, NULL::date;
    RETURN;
  END IF;

  SELECT pr.practice_id, pr.role INTO v_practice, v_practitioner_role
    FROM practitioner pr WHERE pr.account_id = v_account AND pr.status = 'activa'
    LIMIT 1;

  IF v_practice IS NOT NULL THEN
    SELECT pc.owner_account_id, pc.renews_on INTO v_owner, v_renews
      FROM practice pc WHERE pc.id = v_practice;
    IF v_owner IS DISTINCT FROM v_account THEN
      RETURN QUERY SELECT 'not_allowed', NULL::timestamptz, 0, 0, false, NULL::integer,
                          NULL::date;
      RETURN;
    END IF;

    SELECT EXISTS (SELECT 1 FROM practitioner pr
                    WHERE pr.practice_id = v_practice AND pr.account_id <> v_account
                      AND pr.status = 'activa')
      INTO v_team;
    IF v_team THEN
      RETURN QUERY SELECT 'has_team', NULL::timestamptz, 0, 0, false, NULL::integer, NULL::date;
      RETURN;
    END IF;

    SELECT count(*)::integer INTO v_patients
      FROM patient p WHERE p.practice_id = v_practice AND p.status <> 'archivada';
    IF v_patients > 0 THEN
      RETURN QUERY SELECT 'has_patients', NULL::timestamptz, 0, 0, false, v_patients,
                          NULL::date;
      RETURN;
    END IF;

    IF v_renews IS NOT NULL AND v_renews > current_date THEN
      RETURN QUERY SELECT 'has_subscription', NULL::timestamptz, 0, 0, false, NULL::integer,
                          v_renews;
      RETURN;
    END IF;
  END IF;

  UPDATE session s SET revoked_at = v_now
   WHERE s.account_id = v_account AND s.revoked_at IS NULL;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  DELETE FROM credential c WHERE c.account_id = v_account;

  -- Una fila por cada doctora que la tenía. `email` se queda: es la llave del «vuelve_si». Y
  -- AHORA TAMBIÉN EL PLAZO, que es lo que esta migración añade: sin él, la fecha que se le
  -- prometió a esta persona no estaba en ninguna fila que un barrendero pudiera leer.
  UPDATE patient_link l
     SET account_id = NULL, status = 'invitada', retention_until = p_retention_until,
         updated_at = v_now
   WHERE l.account_id = v_account;
  GET DIAGNOSTICS v_links = ROW_COUNT;

  UPDATE account a
     SET email = ('borrada+' || a.id::text || '@medskin.invalid')::citext,
         first_name = 'Cuenta',
         last_name = 'borrada',
         phone = NULL,
         status = 'borrada',
         deleted_at = v_now,
         deletion_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         updated_at = v_now
   WHERE a.id = v_account;

  IF v_practice IS NOT NULL THEN
    DELETE FROM practice pc WHERE pc.id = v_practice;
    v_practice_deleted := true;
  END IF;

  INSERT INTO access_audit (practice_id, actor_account_id, actor_label, action,
                            subject_type, subject_id, data, region)
  VALUES (v_practice, v_account, v_label, 'account.delete', 'account', v_account,
          jsonb_build_object('retention_until', p_retention_until,
                             'reason', nullif(btrim(coalesce(p_reason, '')), ''),
                             'sessions_revoked', v_sessions,
                             'links_detached', v_links,
                             'practice_deleted', v_practice_deleted,
                             'practitioner_role', v_practitioner_role),
          v_region);

  RETURN QUERY SELECT 'deleted', v_now, v_sessions, v_links, v_practice_deleted,
                      v_patients, NULL::date;
END
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- EL BARRENDERO · diario, y por lotes
-- ---------------------------------------------------------------------------------------
-- Una pasada: toma hasta `p_limit` fichas cuyo vínculo suelto venció, las anonimiza, borra su
-- dato de salud, marca sus fotos para que el trabajador borre los bytes y deja la línea de
-- auditoría. Devuelve cuántas tocó: `p_limit` significa «puede haber más, vuelve a llamar».
--
-- IDEMPOTENTE POR CONSTRUCCIÓN: `purged_at IS NULL` en el filtro y escrito en la pasada, así
-- que la segunda llamada no encuentra nada que hacer. Y por lotes porque el día que empiece a
-- haber vencimientos, podrían ser muchos a la vez.
CREATE FUNCTION medskin_purge_retained(p_limit integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
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
    -- El dato de salud, entero.
    DELETE FROM medical_history WHERE patient_id = v_row.id;
    DELETE FROM medical_history_audit WHERE patient_id = v_row.id;
    DELETE FROM consent WHERE patient_id = v_row.id;
    DELETE FROM message WHERE thread_id IN (
      SELECT t.id FROM message_thread t WHERE t.patient_id = v_row.id
    );
    DELETE FROM message_thread WHERE patient_id = v_row.id;

    -- Las fotos: marcadas para que el trabajador borre los bytes. La fila se queda con su
    -- motivo, porque «un hueco sin explicación es peor que el hueco» (0037).
    UPDATE photo
       SET deleted_at = coalesce(deleted_at, now()),
           deleted_reason = coalesce(deleted_reason, 'plazo_de_conservacion_cumplido'),
           updated_at = now()
     WHERE patient_id = v_row.id AND deleted_at IS NULL;

    -- Y LA FICHA, ANONIMIZADA: la fila se queda porque `payment` y `appointment` la nombran y
    -- son los libros de la consulta. Lo que se va es la persona.
    UPDATE patient
       SET first_name = 'Ficha',
           last_name = 'anonimizada',
           birth_date = '1900-01-01',
           email = NULL,
           phone = NULL,
           has_whatsapp = false,
           status = 'archivada',
           archived_at = coalesce(archived_at, now()),
           purged_at = now(),
           updated_at = now()
     WHERE id = v_row.id;

    -- El vínculo suelto se va con ella: su correo era la llave del «vuelve_si», y pasado el
    -- plazo ya no hay nada a lo que volver.
    DELETE FROM patient_link WHERE patient_id = v_row.id AND account_id IS NULL;

    -- Y queda la línea de que se fue, con la fecha que se le prometió y sin nada personal.
    INSERT INTO access_audit (practice_id, action, subject_type, subject_id, data)
    VALUES (v_row.practice_id, 'paciente.plazo_cumplido', 'paciente', v_row.id,
            jsonb_build_object('retention_until', v_row.retention_until));

    v_done := v_done + 1;
  END LOOP;
  RETURN v_done;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_purge_retained(integer) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_purge_retained(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_purge_retained(integer) TO app_anonymous;--> statement-breakpoint
GRANT SELECT, UPDATE, DELETE ON "patient_link" TO medskin_access;--> statement-breakpoint
GRANT SELECT, UPDATE ON "patient" TO medskin_access;--> statement-breakpoint
GRANT DELETE ON "medical_history", "medical_history_audit", "consent", "message",
  "message_thread" TO medskin_access;--> statement-breakpoint
GRANT SELECT ON "medical_history", "medical_history_audit", "consent", "message",
  "message_thread" TO medskin_access;--> statement-breakpoint
GRANT INSERT ON "access_audit" TO medskin_access;--> statement-breakpoint
-- `patient_access`, `patient_link_access` y `medical_history_access` YA EXISTEN desde el tramo
-- 1: el borrado de cuenta las necesitaba. Las tres que faltan son estas.
CREATE POLICY medical_history_audit_access ON "medical_history_audit" FOR ALL TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint
CREATE POLICY consent_access ON "consent" FOR ALL TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint
CREATE POLICY message_access ON "message" FOR ALL TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint
CREATE POLICY message_thread_access ON "message_thread" FOR ALL TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- LOS BYTES DE UNA FOTO BORRADA · la otra mitad de un borrado
-- ---------------------------------------------------------------------------------------
-- Borrar una foto marcaba la fila (`deleted_at`) y dejaba los cuatro objetos en el disco para
-- siempre: la maestra y sus tres derivadas. Es disco que nadie contaba y, peor, es una foto de
-- la cara de alguien que pidió que se fuera y sigue estando. `purged_at` es «los bytes ya se
-- fueron», y lo escribe el trabajador después de borrarlos.
CREATE FUNCTION medskin_photos_to_erase(p_limit integer)
RETURNS TABLE (id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT p.id FROM photo p
   WHERE p.deleted_at IS NOT NULL AND p.purged_at IS NULL
   ORDER BY p.deleted_at
   LIMIT greatest(1, least(coalesce(p_limit, 25), 200));
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_photos_to_erase(integer) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_photos_to_erase(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_photos_to_erase(integer) TO app_anonymous;--> statement-breakpoint

CREATE FUNCTION medskin_photo_erased(p_photo_id uuid)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE photo SET purged_at = now(), derivatives_ready = false, updated_at = now()
   WHERE id = p_photo_id;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_photo_erased(uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_photo_erased(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_photo_erased(uuid) TO app_anonymous;
