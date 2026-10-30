-- =======================================================================================
-- DOS COSAS QUE EL CÓDIGO PEDÍA Y LA BASE NO DABA · 29 de octubre de 2026
--
-- 1 · CANJEAR UNA PROMOCIÓN SIENDO PACIENTE ERA UN 500 SEGURO. `app_patient` tiene `SELECT`
--     sobre `promotion` y nada más (0026, y está bien: una paciente no edita promociones),
--     pero reservar con promoción descuenta el cupo DENTRO de la misma transacción. O sea
--     que `update promotion set redeemed = redeemed + 1` por la puerta de la paciente daba
--     «permission denied for table promotion» en el único momento en que importa: al
--     confirmar la cita con descuento. Lo encontró la prueba del último cupo.
--
--     La salida es la misma de siempre en este esquema: una FUNCIÓN. Y de paso cierra el
--     hallazgo H-05 sin depender de que el `CHECK` reviente, porque el cupo se comprueba
--     DENTRO del `UPDATE`: si no queda, no afecta ninguna fila y devuelve nulo. Una
--     transacción abortada no hace falta para decir «ya no hay cupo».
--
--     Tres guardas, y ninguna es decorativa:
--       · `practice_id = p_practice_id`, que el identificador del cuerpo no elige consulta;
--       · la consulta es el del contexto —la consulta— o uno al que ESTA cuenta está
--         vinculada —la paciente—, así que nadie mueve el contador de una consulta ajena;
--       · el cupo, que es la regla.
--
-- 2 · ARCHIVAR UNA FICHA TENÍA QUE BORRAR LAS DERIVADAS DE SUS FOTOS, y nadie las borraba
--     (H-18). «Las derivadas se borran y la maestra se queda», y se regeneran al
--     reactivarla. No hace falta tabla nueva: el estado ya está en los datos —`patient.status`
--     y `photo.derivatives_ready`—, así que lo que falta son las dos consultas que el
--     trabajador necesita y los dos sellos que escribe. Mismo patrón que la 0038: el
--     trabajador no tiene contexto de consulta y pide el trabajo por función.
-- =======================================================================================
GRANT UPDATE ON "promotion" TO medskin_access;--> statement-breakpoint
CREATE POLICY promotion_access ON "promotion" FOR ALL TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint

CREATE FUNCTION medskin_promotion_redeem(p_promotion_id uuid, p_practice_id uuid)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE promotion
     SET redeemed = redeemed + 1, updated_at = now()
   WHERE id = p_promotion_id
     AND practice_id = p_practice_id
     AND (quota IS NULL OR redeemed < quota)
     AND (practice_id = medskin_current_practice()
          OR EXISTS (SELECT 1 FROM patient_link l
                      WHERE l.practice_id = p_practice_id
                        AND l.account_id = medskin_current_account()
                        AND l.status = 'vinculada'))
  RETURNING true;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_promotion_redeem(uuid, uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_promotion_redeem(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_promotion_redeem(uuid, uuid) TO app_patient;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_promotion_redeem(uuid, uuid) TO app_practitioner;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- Las derivadas de una ficha archivada · H-18
-- ---------------------------------------------------------------------------------------
-- Lo que hay que borrar: fotos listas, con derivadas, de una ficha ARCHIVADA. Devuelve
-- identificadores y nada más, como las tres de la 0038.
CREATE FUNCTION medskin_photos_to_purge(p_limit integer)
RETURNS TABLE (id uuid, practice_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT p.id, p.practice_id
    FROM photo p
    JOIN patient t ON t.id = p.patient_id
   WHERE p.status = 'lista' AND p.derivatives_ready AND p.deleted_at IS NULL
     AND t.status = 'archivada'
   ORDER BY p.updated_at
   LIMIT greatest(1, least(coalesce(p_limit, 25), 200));
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_photos_to_purge(integer) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_photos_to_purge(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_photos_to_purge(integer) TO app_anonymous;--> statement-breakpoint

-- Y lo que hay que regenerar: fotos listas, SIN derivadas, de una ficha activa. Es el camino
-- de vuelta, y es el que hace que archivar no sea una pérdida: «se regeneran al reactivarla».
CREATE FUNCTION medskin_photos_to_rebuild(p_limit integer)
RETURNS TABLE (id uuid, practice_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT p.id, p.practice_id
    FROM photo p
    JOIN patient t ON t.id = p.patient_id
   WHERE p.status = 'lista' AND NOT p.derivatives_ready AND p.deleted_at IS NULL
     AND t.status = 'activa'
   ORDER BY p.updated_at
   LIMIT greatest(1, least(coalesce(p_limit, 25), 200));
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_photos_to_rebuild(integer) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_photos_to_rebuild(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_photos_to_rebuild(integer) TO app_anonymous;--> statement-breakpoint

-- El sello, en los dos sentidos. Lo escribe el trabajador DESPUÉS de tocar el almacenamiento,
-- así que si muere entre las dos cosas el siguiente intento vuelve a encontrar la foto: la
-- operación es idempotente porque las claves son deterministas (0037).
CREATE FUNCTION medskin_photo_derivatives(p_photo_id uuid, p_ready boolean)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE photo SET derivatives_ready = p_ready, updated_at = now() WHERE id = p_photo_id;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_photo_derivatives(uuid, boolean) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_photo_derivatives(uuid, boolean) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_photo_derivatives(uuid, boolean) TO app_anonymous;--> statement-breakpoint

-- `patient.status` entra en el predicado de las dos consultas de arriba, y `photo` se recorre
-- por `derivatives_ready`: un índice parcial por consulta para que el barrido no lea la tabla
-- entera cada cinco segundos. Escrito a mano y con la consulta primero (lección de la 0011).
CREATE INDEX "photo_derivatives_idx" ON "photo" USING btree ("practice_id", "derivatives_ready", "updated_at")
  WHERE "status" = 'lista' AND "deleted_at" IS NULL;
