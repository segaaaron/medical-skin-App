-- =======================================================================================
-- LA BANDEJA DE SALIDA, TRES COSAS QUE LE FALTABAN · 29 de octubre de 2026 (tarde)
--
-- Releyendo lo que se escribió esta mañana, con el mismo rigor del `/flujo`:
--
-- 1 · NADIE RECLAMABA LA FILA. `medskin_notifications_due` era `STABLE` y devolvía lo
--     pendiente; marcar el envío venía después, en OTRA transacción. Con un solo proceso no se
--     nota; con dos —y el despliegue de producción va a tener al menos dos cuando se parta la
--     API del trabajador— **las dos leen la misma fila y la paciente recibe el mismo push dos
--     veces**. El trabajador de exportación sí reclama (`SKIP LOCKED` y `status = 'armando'`);
--     este no.
--
--     Se reclama con un ARRENDAMIENTO sobre `send_after`, no con un estado nuevo: al entregar
--     la fila se empuja `send_after` cinco minutos hacia delante, así que el otro trabajador no
--     la ve. Si el que la tomó muere, vuelve a aparecer sola en cinco minutos —que es
--     exactamente lo que se quiere— y no hace falta un barrendero de filas «enviando» que se
--     quedaron colgadas, que es la parte que siempre se olvida de una máquina de estados.
--
-- 2 · NO TENÍA RETENCIÓN. Una fila enviada se quedaba para siempre. Dos problemas: disco que el
--     presupuesto no cuenta («una cola que nunca se limpia es una fuga de disco lenta»,
--     `servicios.md` §6.3), y un rastro que, sin ser clínico, dice demasiado: mil filas
--     `incidencia` de una cuenta son mil veces que esa persona reportó que algo no iba bien.
--     Noventa días es lo que hace falta para responder «esto se te mandó el día 3 a las 9:14»,
--     que es la pregunta que de verdad se hace.
--
-- 3 · Y el que no es de la base, arreglado en el código: un dispositivo de una plataforma SIN
--     remitente configurado hacía fallar el aviso tres veces y lo mataba. Si solo hay APNs y
--     el token es de Android, el canal no se intentó: eso no es un fallo, es que falta una
--     credencial.
-- =======================================================================================
CREATE OR REPLACE FUNCTION medskin_notifications_due(p_limit integer, p_max_attempts integer)
RETURNS TABLE (id uuid, practice_id uuid, account_id uuid, kind text, channel text,
               subject_key text, data jsonb, attempts integer)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE notification_outbox o
     -- EL ARRENDAMIENTO: cinco minutos para mandarlo. Si este trabajador muere, la fila vuelve
     -- sola; si lo manda, `medskin_notification_sent` la cierra antes de que importe.
     SET send_after = now() + interval '5 minutes'
   WHERE o.id IN (
     SELECT d.id
       FROM notification_outbox d
       JOIN practice pr ON pr.id = d.practice_id
       LEFT JOIN alert_preference ap ON ap.account_id = d.account_id
      WHERE d.status = 'pendiente'
        AND d.send_after <= now()
        AND d.attempts < p_max_attempts
        -- Las preferencias por tipo, que `alert_preference` guardaba y nadie leía.
        AND NOT (d.kind IN ('recordatorio_cita', 'preparacion_previa')
                 AND coalesce(ap.appointment_reminders, true) = false)
        AND NOT (d.kind IN ('cuidado', 'toca_volver')
                 AND coalesce(ap.care_reminders, true) = false)
        AND NOT (d.kind = 'promocion' AND coalesce(ap.promotions, true) = false)
        -- El horario de silencio de la consulta, con las dos excepciones del contrato:
        -- seguridad de la cuenta —que además no se apaga— y el hueco libre que ella pidió.
        AND (d.channel <> 'push'
             OR d.kind IN ('seguridad', 'hueco_libre')
             OR NOT medskin_in_quiet_hours(
                      (now() AT TIME ZONE pr.time_zone)::time,
                      coalesce(ap.quiet_from, '22:00'::time),
                      coalesce(ap.quiet_to, '07:00'::time)))
      ORDER BY d.send_after
      LIMIT greatest(1, least(coalesce(p_limit, 100), 500))
      -- Lo que impide que dos trabajadores manden el mismo push: el que llega segundo no ve
      -- la fila que el primero tiene bloqueada, en vez de esperar por ella.
      FOR UPDATE SKIP LOCKED
   )
  RETURNING o.id, o.practice_id, o.account_id, o.kind, o.channel, o.subject_key, o.data,
            o.attempts;
$fn$;--> statement-breakpoint

-- La retención de la bandeja. Devuelve cuántas borró; `p_limit` significa «puede haber más».
CREATE FUNCTION medskin_notifications_purge(p_days integer, p_limit integer)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  WITH viejas AS (
    SELECT o.id FROM notification_outbox o
     WHERE o.status IN ('enviado', 'descartado', 'fallido')
       AND o.updated_at < now() - make_interval(days => greatest(1, coalesce(p_days, 90)))
     LIMIT greatest(1, least(coalesce(p_limit, 5000), 50000))
  ), borradas AS (
    DELETE FROM notification_outbox WHERE id IN (SELECT id FROM viejas) RETURNING 1
  )
  SELECT count(*)::integer FROM borradas;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_notifications_purge(integer, integer) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_notifications_purge(integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_notifications_purge(integer, integer) TO app_anonymous;--> statement-breakpoint
GRANT DELETE ON "notification_outbox" TO medskin_access;--> statement-breakpoint

-- El índice de la retención: lo cerrado y viejo, sin recorrer lo pendiente.
CREATE INDEX "notification_purge_idx" ON "notification_outbox" USING btree ("updated_at")
	WHERE "status" <> 'pendiente';
