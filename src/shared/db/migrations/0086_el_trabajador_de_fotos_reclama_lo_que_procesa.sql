-- El trabajador de fotos reclama lo que procesa.
--
-- Versionada, y nunca editada después de aplicarse.
--
-- `medskin_photos_pending` (0038) es un SELECT sin bloqueo: dos pasadas o dos instancias leen
-- las mismas fotos `procesando`, las decodifican dos veces y `medskin_photo_failed` cuenta dos
-- intentos por un solo fallo. `medskin_photos_claim` bloquea con `FOR UPDATE SKIP LOCKED` y
-- deja un arrendamiento en `claimed_until`: otra pasada no devuelve la foto hasta que venza.
-- Si el trabajador muere a mitad, la foto vuelve sola cuando vence.
--
-- `medskin_photos_pending` se queda como está: el trabajador la deja de usar en su propio
-- cambio, no aquí.

ALTER TABLE "photo" ADD COLUMN "claimed_until" timestamp with time zone;--> statement-breakpoint

CREATE FUNCTION medskin_photos_claim(p_limit integer, p_max_attempts integer, p_lease_seconds integer)
RETURNS TABLE (id uuid, practice_id uuid, patient_id uuid, attempts integer)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  WITH picked AS (
    SELECT p.id
      FROM photo p
     WHERE p.status = 'procesando' AND p.attempts < p_max_attempts AND p.deleted_at IS NULL
       AND (p.claimed_until IS NULL OR p.claimed_until <= now())
     ORDER BY p.created_at
     LIMIT greatest(1, least(coalesce(p_limit, 5), 50))
       FOR UPDATE SKIP LOCKED
  )
  UPDATE photo p
     SET claimed_until = now() + make_interval(secs => greatest(1, least(coalesce(p_lease_seconds, 300), 3600)))
    FROM picked
   WHERE p.id = picked.id
  RETURNING p.id, p.practice_id, p.patient_id, p.attempts;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_photos_claim(integer, integer, integer) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_photos_claim(integer, integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_photos_claim(integer, integer, integer) TO app_anonymous;--> statement-breakpoint

-- Las dos de cierre sueltan el arrendamiento. Tras un fallo con intentos restantes, la foto
-- queda libre para la pasada siguiente, igual que antes.
CREATE OR REPLACE FUNCTION medskin_photo_processed(
  p_photo_id uuid, p_real_type text, p_width integer, p_height integer,
  p_master_format text, p_master_bytes integer, p_camera text, p_iso integer, p_taken_at timestamptz
) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE photo
     SET status = 'lista', real_type = p_real_type, width = p_width, height = p_height,
         master_format = p_master_format, master_bytes = p_master_bytes,
         derivatives_ready = true, camera = p_camera, iso = p_iso,
         taken_at = coalesce(taken_at, p_taken_at), failed_reason = NULL,
         claimed_until = NULL, updated_at = now()
   WHERE id = p_photo_id;
$fn$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION medskin_photo_failed(p_photo_id uuid, p_reason text, p_max_attempts integer)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE photo
     SET attempts = attempts + 1,
         status = CASE WHEN attempts + 1 >= p_max_attempts THEN 'fallida' ELSE 'procesando' END,
         failed_reason = p_reason, claimed_until = NULL, updated_at = now()
   WHERE id = p_photo_id
  RETURNING attempts;
$fn$;
