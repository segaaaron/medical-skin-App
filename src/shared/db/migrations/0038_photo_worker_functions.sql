-- =======================================================================================
-- EL TRABAJADOR DE FOTOS NO PUEDE SER `medskin_access` · y está bien
--
-- El primer intento del trabajador hacía `SET LOCAL ROLE medskin_access` y la base lo rechazó:
-- «permission denied to set role». Es exactamente la garantía del tramo 1: `medskin_access` es
-- NOLOGIN y **el rol de la aplicación no puede convertirse en él**, porque si pudiera, saltarse
-- cada política del sistema sería una línea de SQL.
--
-- Así que el trabajador pide el trabajo por FUNCIONES, igual que el barrido de idempotencia
-- (0024): la función corre como su dueño, devuelve lo justo, y lo que el trabajador tiene es
-- `EXECUTE` y nada más. No hay contexto de inquilino porque no hay petición, y por eso estas
-- tres funciones son las únicas del sistema que cruzan inquilinos a propósito: procesar una
-- foto no es leerla, y lo que devuelven son identificadores y estado, nunca un byte ni un
-- nombre.
-- =======================================================================================
CREATE FUNCTION medskin_photos_pending(p_limit integer, p_max_attempts integer)
RETURNS TABLE (id uuid, practice_id uuid, patient_id uuid, attempts integer)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT p.id, p.practice_id, p.patient_id, p.attempts
    FROM photo p
   WHERE p.status = 'procesando' AND p.attempts < p_max_attempts AND p.deleted_at IS NULL
   ORDER BY p.created_at
   LIMIT greatest(1, least(coalesce(p_limit, 5), 50));
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_photos_pending(integer, integer) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_photos_pending(integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_photos_pending(integer, integer) TO app_anonymous;--> statement-breakpoint

-- Lo que el trabajador escribe cuando la foto salió bien. La metadata útil entra aquí; el GPS
-- no entra por ninguna parte, ni en el archivo ni en la base.
CREATE FUNCTION medskin_photo_processed(
  p_photo_id uuid, p_real_type text, p_width integer, p_height integer,
  p_master_format text, p_master_bytes integer, p_camera text, p_iso integer, p_taken_at timestamptz
) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE photo
     SET status = 'lista', real_type = p_real_type, width = p_width, height = p_height,
         master_format = p_master_format, master_bytes = p_master_bytes,
         derivatives_ready = true, camera = p_camera, iso = p_iso,
         taken_at = coalesce(taken_at, p_taken_at), failed_reason = NULL, updated_at = now()
   WHERE id = p_photo_id;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_photo_processed(uuid, text, integer, integer, text, integer, text, integer, timestamptz) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_photo_processed(uuid, text, integer, integer, text, integer, text, integer, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_photo_processed(uuid, text, integer, integer, text, integer, text, integer, timestamptz) TO app_anonymous;--> statement-breakpoint

-- Y lo que escribe cuando falló: TRES intentos y la foto queda `fallida` con el motivo real.
-- La cuenta la lleva la base y no el trabajador, para que dos trabajadores no la pierdan.
CREATE FUNCTION medskin_photo_failed(p_photo_id uuid, p_reason text, p_max_attempts integer)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE photo
     SET attempts = attempts + 1,
         status = CASE WHEN attempts + 1 >= p_max_attempts THEN 'fallida' ELSE 'procesando' END,
         failed_reason = p_reason, updated_at = now()
   WHERE id = p_photo_id
  RETURNING attempts;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_photo_failed(uuid, text, integer) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_photo_failed(uuid, text, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_photo_failed(uuid, text, integer) TO app_anonymous;
