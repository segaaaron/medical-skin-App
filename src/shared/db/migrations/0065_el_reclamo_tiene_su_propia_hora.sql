-- =======================================================================================
-- EL ARRENDAMIENTO DE LA EXPORTACIÓN NO ERA UN ARRENDAMIENTO · y «desde» se comparaba como TEXTO
--
-- Las dos salen de la tercera vuelta del QA sobre la 0063. Ninguna rompe nada hoy; las dos
-- rompen en silencio en cuanto haya cola.
-- =======================================================================================

-- ---------------------------------------------------------------------------------------
-- 1 · `medskin_exports_pending` rescataba por `created_at`, que es CUÁNDO SE PIDIÓ
-- ---------------------------------------------------------------------------------------
-- La 0063 añadió el rescate de lo que lleva quince minutos en `armando` —correcto— pero lo midió
-- con el único reloj que la tabla tenía, y ese reloj es la hora de la SOLICITUD, no la del
-- reclamo. Así que una petición que espere más de quince minutos en `pedida` —la cola con cuerpo,
-- o el trabajador parado un rato— nace ya vencida: un minuto después de que alguien la reclame,
-- otro trabajador la considera «colgada» y la vuelve a reclamar.
--
-- Y entonces los dos arman la misma exportación, los dos suben el objeto, los dos llaman a
-- `medskin_export_ready` y **la paciente recibe dos correos con el mismo enlace**. No se corrompe
-- nada —el segundo `object_key` gana y el primero queda huérfano en el almacenamiento hasta su
-- caducidad— pero es el aviso duplicado que toda la bandeja de salida existe para no mandar.
--
-- El arrendamiento necesita su propia hora, y `created_at` no puede servir de las dos: está en
-- `data_export_daily_uq` (`account_id`, `created_at::date`), que es el «una al día» del contrato.
ALTER TABLE "data_export" ADD COLUMN "claimed_at" timestamptz;--> statement-breakpoint

-- El reclamo escribe su hora, y el rescate la lee. `medskin_access` ya tiene `UPDATE` de tabla
-- sobre `data_export`, así que la columna nueva entra sin `GRANT`.
--
-- `claimed_at IS NULL` cubre lo que ya estaba en `armando` cuando esta migración se aplicó: sin
-- esa rama, una fila reclamada por la versión anterior no se rescata nunca.
CREATE OR REPLACE FUNCTION medskin_exports_pending(p_limit integer)
RETURNS TABLE (id uuid, account_id uuid, practice_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE data_export
     SET status = 'armando', claimed_at = now(), created_at = created_at
   WHERE id IN (
     SELECT d.id FROM data_export d
      WHERE d.status = 'pedida'
         -- El rescate, ahora desde la hora DEL RECLAMO: quince minutos armándose es un
         -- trabajador que murió. Armar una exportación son segundos.
         OR (d.status = 'armando'
             AND coalesce(d.claimed_at, d.created_at) < now() - interval '15 minutes')
      ORDER BY d.created_at
      LIMIT greatest(1, least(coalesce(p_limit, 5), 20))
      FOR UPDATE SKIP LOCKED
   )
  RETURNING id, account_id, practice_id;
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 2 · El cruce de «toca volver» dependía de `DateStyle`
-- ---------------------------------------------------------------------------------------
-- La 0063 excluye a quien ya tiene su aviso comparando `o.data->>'desde'` con
-- `(…)::date::text`. Ese `::text` de una fecha lo formatea **`DateStyle`**: con `ISO, MDY` sale
-- `YYYY-MM-DD`, que es justo lo que el código escribe, pero con `SQL` o `German` sale `11/03/2026`
-- o `03.11.2026` y el `NOT EXISTS` **no casa nunca**.
--
-- Y entonces la exclusión se apaga sin un solo error y vuelve el defecto que la 0063 cerró, con
-- el mismo síntoma mudo: «0 encolados», indistinguible de «no había nada que hacer».
--
-- Se compara como FECHA, que es lo que son las dos: `(o.data->>'desde')::date` entiende el
-- `YYYY-MM-DD` del código en cualquier `DateStyle`, porque ISO no es ambiguo.
CREATE OR REPLACE FUNCTION medskin_patients_to_return(p_limit integer)
RETURNS TABLE (practice_id uuid, account_id uuid, email text, treatment_id uuid, due_on date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  WITH ultima AS (
    SELECT s.patient_id, a.treatment_id, a.practice_id, max(s.started_at) AS last_at
      FROM clinical_session s
      JOIN appointment a ON a.id = s.appointment_id
     WHERE s.status = 'firmada'
     GROUP BY s.patient_id, a.treatment_id, a.practice_id
  )
  SELECT u.practice_id, l.account_id, ac.email::text, u.treatment_id,
         (u.last_at + make_interval(days => t.min_interval_days))::date AS due_on
    FROM ultima u
    JOIN treatment t ON t.id = u.treatment_id
    JOIN patient t2 ON t2.id = u.patient_id
    JOIN patient_link l ON l.patient_id = u.patient_id AND l.status = 'vinculada'
    JOIN account ac ON ac.id = l.account_id
   WHERE t.min_interval_days IS NOT NULL
     AND t.planned_sessions > 1
     AND t.status = 'activo'
     AND t2.status = 'activa'
     AND u.last_at + make_interval(days => t.min_interval_days) <= now()
     AND NOT EXISTS (SELECT 1 FROM appointment a2
                      WHERE a2.patient_id = u.patient_id
                        AND a2.treatment_id = u.treatment_id
                        AND a2.status IN ('pendiente_de_sena', 'confirmada')
                        AND a2.starts_at > now())
     -- Quien ya tiene su aviso de ESTE tratamiento para ESTA fecha no vuelve a ocupar un hueco
     -- del `LIMIT`. Comparado como fecha y no como texto: el `::text` de una fecha lo formatea
     -- `DateStyle`, y con otro valor la exclusión se apagaba en silencio.
     AND NOT EXISTS (SELECT 1 FROM notification_outbox o
                      WHERE o.practice_id = u.practice_id
                        AND o.account_id = l.account_id
                        AND o.kind = 'toca_volver'
                        AND o.data->>'tratamiento_id' = u.treatment_id::text
                        AND (o.data->>'desde')::date
                            = (u.last_at + make_interval(days => t.min_interval_days))::date)
   ORDER BY due_on
   LIMIT greatest(1, least(coalesce(p_limit, 200), 1000));
$fn$;
