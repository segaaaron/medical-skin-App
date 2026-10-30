-- =======================================================================================
-- EL TRABAJO QUE ARMA LA EXPORTACIÓN · 29 de octubre de 2026
--
-- `negocio.md` promete «se encola, se arma, y el enlace llega por correo», y el tramo 8 dejó
-- la fila de `data_export` naciendo `pedida` y a nadie que la mirara: la respuesta decía «te
-- llega por correo» y no llegaba nunca.
--
-- ESTAS TRES FUNCIONES SON SOLO LA LISTA Y LOS SELLOS. Lo que el trabajo NO hace por aquí es
-- leer los datos: eso lo hace **bajo las políticas de quien la pidió** —con su `account_id` y
-- su rol—, que es la frase del contrato que impide que este endpoint sea la puerta de atrás
-- del aislamiento. Si los datos se juntaran con `SECURITY DEFINER`, una exportación sería el
-- único camino del sistema que cruza consultas, y sería el camino que más datos mueve.
-- =======================================================================================
GRANT SELECT, UPDATE ON "data_export" TO medskin_access;--> statement-breakpoint
CREATE POLICY data_export_access ON "data_export" FOR ALL TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint

-- Lo que falta armar. Devuelve identificadores y nada más: ni el correo, ni un dato de nadie.
CREATE FUNCTION medskin_exports_pending(p_limit integer)
RETURNS TABLE (id uuid, account_id uuid, practice_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE data_export
     SET status = 'armando'
   WHERE id IN (
     SELECT d.id FROM data_export d
      WHERE d.status = 'pedida'
      ORDER BY d.created_at
      LIMIT greatest(1, least(coalesce(p_limit, 5), 20))
      -- `SKIP LOCKED` para que dos procesos no armen la misma: la fila que uno tomó, el otro
      -- ni la ve. Es lo mismo que hace el barrido de idempotencia con su cota.
      FOR UPDATE SKIP LOCKED
   )
  RETURNING id, account_id, practice_id;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_exports_pending(integer) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_exports_pending(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_exports_pending(integer) TO app_anonymous;--> statement-breakpoint

CREATE FUNCTION medskin_export_ready(p_id uuid, p_object_key text, p_expires_at timestamptz)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE data_export
     SET status = 'lista', object_key = p_object_key, expires_at = p_expires_at
   WHERE id = p_id;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_export_ready(uuid, text, timestamptz) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_export_ready(uuid, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_export_ready(uuid, text, timestamptz) TO app_anonymous;--> statement-breakpoint

-- Una exportación que falla queda `fallida` y NO se reintenta sola: lo que falla aquí suele ser
-- el almacenamiento o un dato que no se pudo leer, y volver a intentarlo cada minuto sobre el
-- mismo problema llena el disco de intentos. La paciente puede pedir otra mañana, que es lo que
-- su propio límite de una al día ya permite.
CREATE FUNCTION medskin_export_failed(p_id uuid)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE data_export SET status = 'fallida' WHERE id = p_id;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_export_failed(uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_export_failed(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_export_failed(uuid) TO app_anonymous;--> statement-breakpoint

-- Y la caducidad: a las 24 h la fila pasa a `vencida` y el objeto se puede borrar. Sin esto, el
-- `410 exportacion_vencida` del contrato lo decide una comparación en el caso de uso y el
-- archivo se queda en el disco para siempre.
CREATE FUNCTION medskin_exports_expired(p_limit integer)
RETURNS TABLE (id uuid, object_key text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE data_export
     SET status = 'vencida'
   WHERE id IN (
     SELECT d.id FROM data_export d
      WHERE d.status = 'lista' AND d.expires_at < now()
      LIMIT greatest(1, least(coalesce(p_limit, 50), 500))
      FOR UPDATE SKIP LOCKED
   )
  RETURNING id, object_key;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_exports_expired(integer) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_exports_expired(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_exports_expired(integer) TO app_anonymous;
