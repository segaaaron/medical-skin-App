-- Lo que hay que vigilar y antes no lo miraba nadie: avisos que no salen, fotos que no avanzan
-- y cuánto ocupan las maestras.
--
-- Una sola función para el rol de los trabajos (`app_anonymous`), que no tiene `SELECT` sobre
-- estas tablas. Devuelve números, nunca filas ni identificadores. Es de solo lectura y entra por
-- los índices parciales que ya existen (`notification_due_idx`, `photo_pending_idx`).
--
-- `p_overdue_seconds`: cuánto tiempo pasado de su hora cuenta un aviso como atrasado.
-- `p_stuck_seconds`: cuánto tiempo en `procesando` cuenta una foto como detenida.
CREATE FUNCTION medskin_ops_snapshot(p_overdue_seconds integer, p_stuck_seconds integer)
RETURNS TABLE (
  notifications_overdue bigint,
  photos_stuck bigint,
  photos_total bigint,
  master_bytes bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT
    (SELECT count(*) FROM notification_outbox
      WHERE status = 'pendiente'
        AND send_after < now() - make_interval(secs => greatest(p_overdue_seconds, 1))),
    (SELECT count(*) FROM photo
      WHERE status = 'procesando' AND deleted_at IS NULL
        AND created_at < now() - make_interval(secs => greatest(p_stuck_seconds, 1))),
    (SELECT count(*) FROM photo WHERE deleted_at IS NULL),
    (SELECT coalesce(sum(master_bytes), 0)::bigint FROM photo WHERE deleted_at IS NULL);
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_ops_snapshot(integer, integer) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_ops_snapshot(integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_ops_snapshot(integer, integer) TO app_anonymous;
