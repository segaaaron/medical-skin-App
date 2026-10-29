-- =======================================================================================
-- LA FILA QUE NO SE PUEDE MANDAR SE VOLVÍA A ARRENDAR PARA SIEMPRE
--
-- `medskin_notifications_due` no incrementa `attempts`: solo empuja `send_after` cinco minutos
-- (el arrendamiento). Y hay tres caminos en los que el trabajador devuelve sin tocar la fila,
-- todos **después** de que ya esté arrendada: canal de correo sin relé, canal de push sin ningún
-- remitente, y dispositivos que existen pero ninguno de una plataforma con credencial.
--
-- Marcarla fallida sería perderla —y eso está bien decidido—, pero el efecto es el otro: queda
-- `pendiente` con `attempts = 0` **indefinidamente**, se vuelve a arrendar cada cinco minutos, y
-- la purga solo borra lo cerrado. Es un conjunto que solo crece, y hoy —sin credenciales de
-- APNs ni FCM— serían **todos los push**.
--
-- Esto no la cierra: la **aplaza**. El aviso sigue vivo y saldrá el día que la credencial exista,
-- que es lo que se quería; lo que deja de hacer es dar vueltas cada cinco minutos leyendo filas
-- que no se pueden mandar. Una hora es el plazo: si la credencial se pone, el primer aviso tarda
-- como mucho una hora en salir, y eso para un recordatorio o un cuidado no cambia nada.
-- =======================================================================================
CREATE FUNCTION medskin_notification_postpone(p_id uuid, p_minutes integer)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE notification_outbox
     SET send_after = now() + make_interval(mins => greatest(1, least(coalesce(p_minutes, 60), 1440))),
         updated_at = now()
   WHERE id = p_id AND status = 'pendiente';
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_notification_postpone(uuid, integer) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_notification_postpone(uuid, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_notification_postpone(uuid, integer) TO app_anonymous;
