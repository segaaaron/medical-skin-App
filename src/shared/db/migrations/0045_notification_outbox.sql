-- =======================================================================================
-- LA BANDEJA DE SALIDA DE LOS AVISOS · 29 de octubre de 2026 · hallazgo H-01
--
-- Tres respuestas del backend afirmaban que alguien había sido avisado y no existía una sola
-- línea que avisara: «Tu doctora lo recibió y te va a responder por el chat» al reportar una
-- incidencia, `lista_de_espera_avisada: 1` al cancelar —con el hueco reservado 30 minutos a
-- alguien que nunca se enteró— y «te llega por correo» al pedir una exportación. El tramo 7
-- dejó construida la mitad que RECIBE (`device`, `alert_preference`, sus cuatro endpoints) y
-- ninguna de la que MANDA.
--
-- ESTA TABLA ES LA MITAD QUE MANDA, y su forma la decide una regla del contrato que no se
-- negocia: **NINGÚN PUSH LLEVA CONTENIDO CLÍNICO** (§11.1 · `cuidados.md`). De ahí que no
-- haya una columna `texto`:
--
--   · `subject_key` es la CLAVE de la frase, no la frase. El texto vive en el código del
--     remitente, es neutro —«Tienes un mensaje de tu doctora»— y la app, ya desbloqueada y
--     autenticada, pide el contenido a la API.
--   · `data` lleva IDENTIFICADORES para que la app abra la pantalla correcta. Ni el nombre del
--     tratamiento, ni el de la paciente, ni el texto de un mensaje. Lo que se escriba aquí
--     acaba en una pantalla de bloqueo, y una pantalla de bloqueo se lee sin desbloquear.
--
-- `dedupe_key` ES LA IDEMPOTENCIA, y es lo que `cuidados.md` pide cuando dice que los ocho
-- trabajos son «idempotentes por su identificador»: el programador de recordatorios corre
-- cada cinco minutos y vuelve a ver la misma cita, así que lo que impide el segundo aviso es
-- un índice único, no que el trabajo se acuerde de lo que hizo.
--
-- Y UNA FILA NO SE BORRA AL ENVIARSE: queda con `sent_at`. Es lo que permite responder «esto
-- se te mandó el día 3 a las 9:14» cuando una paciente dice que no le llegó nada, que es la
-- pregunta que de verdad se hace.
-- =======================================================================================
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	-- A QUIÉN: la CUENTA, no la ficha. El push va a los dispositivos de una cuenta y el correo
	-- a su correo; una ficha sin cuenta no recibe avisos y eso no es un error, es el producto.
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"subject_key" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	-- El retraso nativo: un cuidado del día 7 nace con su instante y espera en la tabla.
	"send_after" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"failed_reason" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_kind_ck" CHECK ("notification_outbox"."kind" in
		('recordatorio_cita', 'preparacion_previa', 'cuidado', 'hueco_libre', 'promocion',
		 'toca_volver', 'consentimiento_por_firmar', 'exportacion', 'incidencia', 'mensaje',
		 'seguridad')),
	CONSTRAINT "notification_channel_ck" CHECK ("notification_outbox"."channel" in ('push', 'correo')),
	CONSTRAINT "notification_status_ck" CHECK ("notification_outbox"."status" in
		('pendiente', 'enviado', 'fallido', 'descartado')),
	-- Un envío que se dice hecho tiene su instante. Sin esto, «enviado» es una opinión.
	CONSTRAINT "notification_sent_ck" CHECK ("notification_outbox"."status" <> 'enviado'
		or "notification_outbox"."sent_at" is not null),
	-- Y uno que falló dice por qué: «un hueco sin explicación es peor que el hueco» (0037).
	CONSTRAINT "notification_failed_ck" CHECK ("notification_outbox"."status" <> 'fallido'
		or "notification_outbox"."failed_reason" is not null)
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade;--> statement-breakpoint

-- La idempotencia de los ocho trabajos, en un índice.
CREATE UNIQUE INDEX "notification_dedupe_uq" ON "notification_outbox" USING btree ("practice_id", "dedupe_key");--> statement-breakpoint
-- La consulta del trabajador: lo pendiente que ya toca, por inquilino primero (lección 0011).
CREATE INDEX "notification_due_idx" ON "notification_outbox" USING btree ("practice_id", "send_after")
	WHERE "status" = 'pendiente';--> statement-breakpoint
-- Y la de la pantalla «qué se le mandó a esta cuenta».
CREATE INDEX "notification_account_idx" ON "notification_outbox" USING btree ("practice_id", "account_id", "created_at" DESC NULLS FIRST);--> statement-breakpoint

ALTER TABLE "notification_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- La consulta ve LO SUYO, y de lectura: quien escribe es la función de abajo, para que la
-- puerta de la paciente —que no tiene inquilino— pueda encolar el aviso de una incidencia sin
-- recibir `INSERT` sobre una tabla de otro inquilino.
CREATE POLICY notification_practitioner ON "notification_outbox" FOR SELECT TO app_practitioner
	USING ("practice_id" = medskin_current_practice());--> statement-breakpoint
-- Y cada cuenta ve los avisos que le mandaron: es su historial, y lo pide la pantalla de
-- avisos de la app.
CREATE POLICY notification_own ON "notification_outbox" FOR SELECT TO app_patient, app_account
	USING ("account_id" = medskin_current_account());--> statement-breakpoint
CREATE POLICY notification_access ON "notification_outbox" FOR ALL TO medskin_access
	USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint
GRANT SELECT ON "notification_outbox" TO app_practitioner, app_patient, app_account;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "notification_outbox" TO medskin_access;--> statement-breakpoint
GRANT SELECT, DELETE ON "device" TO medskin_access;--> statement-breakpoint
GRANT UPDATE ("failures", "last_seen_at") ON "device" TO medskin_access;--> statement-breakpoint
CREATE POLICY device_access ON "device" FOR ALL TO medskin_access
	USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint
GRANT SELECT ON "alert_preference" TO medskin_access;--> statement-breakpoint
CREATE POLICY alert_preference_access ON "alert_preference" FOR SELECT TO medskin_access
	USING (current_user = 'medskin_access');--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- ENCOLAR · lo llaman los casos de uso, desde la puerta de la consulta y la de la paciente
-- ---------------------------------------------------------------------------------------
-- Las mismas tres guardas que `medskin_promotion_redeem` (0043): el inquilino es el del
-- contexto —la consulta— o uno al que ESTA cuenta está vinculada —la paciente—, así que nadie
-- encola un aviso en el inquilino de al lado.
--
-- `ON CONFLICT DO NOTHING` y devuelve nulo: encolar dos veces el mismo aviso no es un error,
-- es el trabajo repetible haciendo su trabajo.
CREATE FUNCTION medskin_notify(
  p_practice_id uuid, p_account_id uuid, p_kind text, p_channel text, p_subject_key text,
  p_data jsonb, p_dedupe text, p_send_after timestamptz
) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  INSERT INTO notification_outbox (practice_id, account_id, kind, channel, subject_key, data,
                                   dedupe_key, send_after)
  SELECT p_practice_id, p_account_id, p_kind, p_channel, p_subject_key,
         coalesce(p_data, '{}'::jsonb), p_dedupe, coalesce(p_send_after, now())
   WHERE p_practice_id = medskin_current_practice()
      OR EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.practice_id = p_practice_id
                    AND l.account_id = medskin_current_account()
                    AND l.status = 'vinculada')
  ON CONFLICT ("practice_id", "dedupe_key") DO NOTHING
  RETURNING id;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_notify(uuid, uuid, text, text, text, jsonb, text, timestamptz) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_notify(uuid, uuid, text, text, text, jsonb, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_notify(uuid, uuid, text, text, text, jsonb, text, timestamptz) TO app_practitioner, app_patient, app_account;--> statement-breakpoint

-- El programador global —recordatorios, «toca volver»— no tiene contexto de inquilino, igual
-- que el trabajador de fotos. Esta es su puerta para encolar: sin guardas de contexto, pero
-- solo para `app_anonymous`, que es el rol de los trabajos y cuyo único privilegio son
-- funciones como esta (napkin §1.6).
CREATE FUNCTION medskin_notify_job(
  p_practice_id uuid, p_account_id uuid, p_kind text, p_channel text, p_subject_key text,
  p_data jsonb, p_dedupe text, p_send_after timestamptz
) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  INSERT INTO notification_outbox (practice_id, account_id, kind, channel, subject_key, data,
                                   dedupe_key, send_after)
  VALUES (p_practice_id, p_account_id, p_kind, p_channel, p_subject_key,
          coalesce(p_data, '{}'::jsonb), p_dedupe, coalesce(p_send_after, now()))
  ON CONFLICT ("practice_id", "dedupe_key") DO NOTHING
  RETURNING id;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_notify_job(uuid, uuid, text, text, text, jsonb, text, timestamptz) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_notify_job(uuid, uuid, text, text, text, jsonb, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_notify_job(uuid, uuid, text, text, text, jsonb, text, timestamptz) TO app_anonymous;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- EL HORARIO DE SILENCIO · «ningún push entre las 22:00 y las 07:00 de la zona de la consulta»
-- ---------------------------------------------------------------------------------------
-- La ventana CRUZA LA MEDIANOCHE, así que no se puede comparar con un `between` y punto: de
-- 22:00 a 07:00 es «después de las 22 O antes de las 7». Y si alguien pone una ventana que no
-- cruza —de 13:00 a 15:00, una siesta— tiene que funcionar igual.
--
-- `IMMUTABLE`: solo mira sus argumentos, así que puede entrar en un predicado sin costar un
-- plan (la lección de la 0023 al revés: aquí no hay `SET search_path` porque no hace falta
-- ninguna tabla).
CREATE FUNCTION medskin_in_quiet_hours(p_at time, p_from time, p_to time)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
           WHEN p_from IS NULL OR p_to IS NULL THEN false
           WHEN p_from = p_to THEN false
           WHEN p_from < p_to THEN p_at >= p_from AND p_at < p_to
           ELSE p_at >= p_from OR p_at < p_to
         END;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_in_quiet_hours(time, time, time) OWNER TO medskin_owner;--> statement-breakpoint

-- Lo que toca mandar AHORA. Aquí se aplican las dos reglas que `alert_preference` guardaba y
-- nadie leía: el interruptor por tipo y el horario de silencio.
--
-- Las dos excepciones del silencio son del contrato y no se tocan: **seguridad de la cuenta**
-- —que además «no se apaga»— y el **hueco libre de la lista de espera que la propia paciente
-- pidió**. Un hueco que se avisa a las 7 de la mañana ya lo tomó otra.
--
-- El correo no tiene horario: no suena.
CREATE FUNCTION medskin_notifications_due(p_limit integer, p_max_attempts integer)
RETURNS TABLE (id uuid, practice_id uuid, account_id uuid, kind text, channel text,
               subject_key text, data jsonb, attempts integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT o.id, o.practice_id, o.account_id, o.kind, o.channel, o.subject_key, o.data, o.attempts
    FROM notification_outbox o
    JOIN practice pr ON pr.id = o.practice_id
    LEFT JOIN alert_preference ap ON ap.account_id = o.account_id
   WHERE o.status = 'pendiente'
     AND o.send_after <= now()
     AND o.attempts < p_max_attempts
     AND NOT (o.kind IN ('recordatorio_cita', 'preparacion_previa')
              AND coalesce(ap.appointment_reminders, true) = false)
     AND NOT (o.kind IN ('cuidado', 'toca_volver')
              AND coalesce(ap.care_reminders, true) = false)
     AND NOT (o.kind = 'promocion' AND coalesce(ap.promotions, true) = false)
     AND (o.channel <> 'push'
          OR o.kind IN ('seguridad', 'hueco_libre')
          OR NOT medskin_in_quiet_hours(
                   (now() AT TIME ZONE pr.time_zone)::time,
                   coalesce(ap.quiet_from, '22:00'::time),
                   coalesce(ap.quiet_to, '07:00'::time)))
   ORDER BY o.send_after
   LIMIT greatest(1, least(coalesce(p_limit, 100), 500));
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_notifications_due(integer, integer) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_notifications_due(integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_notifications_due(integer, integer) TO app_anonymous;--> statement-breakpoint

-- Los tres sellos del envío. Como en la 0038: la cuenta de los intentos la lleva la base, para
-- que dos trabajadores no la pierdan.
CREATE FUNCTION medskin_notification_sent(p_id uuid)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE notification_outbox
     SET status = 'enviado', sent_at = now(), failed_reason = NULL, updated_at = now()
   WHERE id = p_id;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_notification_sent(uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_notification_sent(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_notification_sent(uuid) TO app_anonymous;--> statement-breakpoint

CREATE FUNCTION medskin_notification_failed(p_id uuid, p_reason text, p_max_attempts integer)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE notification_outbox
     SET attempts = attempts + 1,
         status = CASE WHEN attempts + 1 >= p_max_attempts THEN 'fallido' ELSE 'pendiente' END,
         failed_reason = p_reason,
         -- Retroceso exponencial en la propia fila: 1, 2, 4, 8 minutos. No hace falta que la
         -- cola lo recuerde, porque lo que decide cuándo volver es `send_after`.
         send_after = now() + make_interval(mins => least(60, power(2, attempts)::integer)),
         updated_at = now()
   WHERE id = p_id
  RETURNING attempts;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_notification_failed(uuid, text, integer) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_notification_failed(uuid, text, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_notification_failed(uuid, text, integer) TO app_anonymous;--> statement-breakpoint

-- «Descartado» no es «fallido»: es un aviso que YA NO TIENE SENTIDO MANDAR —la cuenta no tiene
-- ningún dispositivo con permiso, o la cita que se recordaba se canceló—. Un fallido se
-- reintenta; un descartado, no, y la diferencia es la que hace legible la cola de fallidos.
CREATE FUNCTION medskin_notification_dropped(p_id uuid, p_reason text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE notification_outbox
     SET status = 'descartado', failed_reason = p_reason, updated_at = now()
   WHERE id = p_id;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_notification_dropped(uuid, text) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_notification_dropped(uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_notification_dropped(uuid, text) TO app_anonymous;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- LOS TOKENS · la higiene que el tramo 7 escribió en un comentario y nadie ejecutaba
-- ---------------------------------------------------------------------------------------
-- A quién mandarle el push: los dispositivos de esa cuenta con el permiso concedido y menos de
-- tres fallos. El `failures` que `registerDevice` pone a cero era hasta hoy el único escritor
-- de esa columna: nadie la subía nunca.
CREATE FUNCTION medskin_devices_of(p_account_id uuid)
RETURNS TABLE (id uuid, token text, platform text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT d.id, d.token, d.platform
    FROM device d
   WHERE d.account_id = p_account_id AND d.permission = 'concedido' AND d.failures < 3
   ORDER BY d.last_seen_at DESC;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_devices_of(uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_devices_of(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_devices_of(uuid) TO app_anonymous;--> statement-breakpoint

-- Un fallo que NO es «este token ya no existe»: se cuenta, y a los tres el dispositivo deja de
-- recibir. No se borra: el token puede volver a la vida cuando la app lo refresque.
CREATE FUNCTION medskin_device_failed(p_id uuid)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE device SET failures = failures + 1 WHERE id = p_id RETURNING failures;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_device_failed(uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_device_failed(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_device_failed(uuid) TO app_anonymous;--> statement-breakpoint

-- Y el que SÍ lo es —`410 Unregistered` de APNs, `UNREGISTERED` de FCM—: el token se borra en
-- el acto. «Con un 30 % de tokens muertos el proveedor estrangula al remitente», y eso se
-- lleva por delante los avisos que sí importan.
CREATE FUNCTION medskin_device_gone(p_id uuid)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  DELETE FROM device WHERE id = p_id;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_device_gone(uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_device_gone(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_device_gone(uuid) TO app_anonymous;--> statement-breakpoint

-- El barrido diario: 90 días sin refrescar es un teléfono que se cambió o una app que se
-- desinstaló. Devuelve cuántos borró, con cota, como el barrido de idempotencia.
CREATE FUNCTION medskin_devices_stale(p_days integer, p_limit integer)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  WITH viejos AS (
    SELECT d.id FROM device d
     WHERE d.last_seen_at < now() - make_interval(days => greatest(1, coalesce(p_days, 90)))
     LIMIT greatest(1, least(coalesce(p_limit, 1000), 10000))
  ), borrados AS (
    DELETE FROM device WHERE id IN (SELECT id FROM viejos) RETURNING 1
  )
  SELECT count(*)::integer FROM borrados;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_devices_stale(integer, integer) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_devices_stale(integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_devices_stale(integer, integer) TO app_anonymous;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- LOS DOS PROGRAMADORES QUE MIRAN LA AGENDA · recordatorio de cita y «toca volver»
-- ---------------------------------------------------------------------------------------
-- Cruzan inquilinos a propósito, como las tres de la 0038: un programador global no tiene
-- petición ni inquilino, y lo que devuelven son IDENTIFICADORES y un correo, nunca el nombre
-- de un tratamiento.
--
-- La ventana: citas que empiezan dentro de `p_hours` ± `p_window_minutes`. Se llama cada cinco
-- minutos con ventana de cinco, y lo que impide el aviso repetido es `notification_dedupe_uq`,
-- no la precisión de esta ventana.
CREATE FUNCTION medskin_appointments_to_remind(p_hours integer, p_window_minutes integer)
RETURNS TABLE (appointment_id uuid, practice_id uuid, account_id uuid, email text,
               starts_at timestamptz, requires_consent boolean, has_consent boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT a.id, a.practice_id, l.account_id, ac.email::text, a.starts_at,
         t.requires_consent,
         EXISTS (SELECT 1 FROM consent c
                  WHERE c.patient_id = a.patient_id AND c.treatment_id = a.treatment_id
                    AND c.purpose = 'clinico' AND c.revoked_at IS NULL) AS has_consent
    FROM appointment a
    JOIN treatment t ON t.id = a.treatment_id
    JOIN patient_link l ON l.patient_id = a.patient_id AND l.status = 'vinculada'
    JOIN account ac ON ac.id = l.account_id
   WHERE a.status IN ('pendiente_de_sena', 'confirmada')
     AND a.starts_at > now()
     AND a.starts_at <= now() + make_interval(hours => p_hours,
                                              mins => greatest(1, coalesce(p_window_minutes, 5)))
     AND a.starts_at > now() + make_interval(hours => p_hours);
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_appointments_to_remind(integer, integer) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_appointments_to_remind(integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_appointments_to_remind(integer, integer) TO app_anonymous;--> statement-breakpoint

-- «Toca volver»: la última sesión firmada de un tratamiento que se repite, más su intervalo
-- mínimo, ya pasó, y no hay ninguna cita viva de ese tratamiento. Es el aviso que genera la
-- re-reserva (§6.2 punto 1), y por eso trae el `treatment_id`: la app abre los huecos.
CREATE FUNCTION medskin_patients_to_return(p_limit integer)
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
   ORDER BY due_on
   LIMIT greatest(1, least(coalesce(p_limit, 200), 1000));
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_patients_to_return(integer) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_patients_to_return(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_patients_to_return(integer) TO app_anonymous;--> statement-breakpoint

-- El correo del destinatario, para el canal de correo. Una función y no un `JOIN` en el
-- trabajador: `account.email` es `citext` y no sale de ninguna política que el rol del trabajo
-- pueda ver.
CREATE FUNCTION medskin_account_email(p_account_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT a.email::text FROM account a WHERE a.id = p_account_id AND a.status = 'activa';
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_account_email(uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_account_email(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_account_email(uuid) TO app_anonymous;
