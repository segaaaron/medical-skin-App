-- =======================================================================================
-- `FOR UPDATE` NO SE PUEDE APLICAR AL LADO NULABLE DE UN `OUTER JOIN`
--
-- La 0056 puso `FOR UPDATE SKIP LOCKED` en una consulta que lleva `LEFT JOIN alert_preference`
-- —la tabla de las preferencias de aviso, que no existe para una cuenta que nunca las tocó— y
-- Postgres la rechaza: «FOR UPDATE cannot be applied to the nullable side of an outer join».
-- Tiene razón: no hay fila que bloquear cuando no hay fila.
--
-- Lo que hay que bloquear es la fila de la BANDEJA, y eso se dice con `FOR UPDATE OF d`. Lo
-- cazó la suite en la primera corrida; la 0056 ya está aplicada y no se toca.
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
      --
      -- `OF d` Y NO `FOR UPDATE` A SECAS: con el `LEFT JOIN` a `alert_preference`, Postgres
      -- rechaza bloquear «el lado nulable de un `OUTER JOIN`» —y tiene razón, no hay fila que
      -- bloquear cuando la cuenta no tiene preferencias—. Lo que hay que bloquear es la fila de
      -- la bandeja, que es la que se entrega.
      FOR UPDATE OF d SKIP LOCKED
   )
  RETURNING o.id, o.practice_id, o.account_id, o.kind, o.channel, o.subject_key, o.data,
            o.attempts;
$fn$;
