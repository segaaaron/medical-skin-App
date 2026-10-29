-- =======================================================================================
-- ENCOLAR SIN SABER A QUÉ CUENTA · 29 de octubre de 2026
--
-- `medskin_notify` (0045) pide la cuenta del destinatario, y hay dos caminos donde quien
-- encola NO PUEDE SABERLA, y es correcto que no pueda:
--
-- 1 · LA INCIDENCIA. La encola la PACIENTE —«Tu doctora lo recibió»— y va a la consulta.
--     `app_patient` no lee `practice`, así que no conoce `owner_account_id`, y dárselo para
--     esto abriría la tabla de todos los inquilinos para poder leer uno (la decisión de la
--     0027). La función lo resuelve ella.
--
-- 2 · EL HUECO LIBRE DE LA LISTA DE ESPERA. Lo encola quien CANCELA —que puede ser otra
--     paciente— y va a la cuenta de la siguiente de la lista. Una paciente no lee el
--     `patient_link` de otra, y no va a leerlo.
--
-- Las dos guardas son las mismas de siempre: el inquilino es el del contexto —la consulta— o
-- uno al que ESTA cuenta está vinculada. Y lo que devuelven es un identificador o nulo: ni el
-- nombre de la doctora, ni el de la otra paciente, ni su correo.
-- =======================================================================================
CREATE FUNCTION medskin_notify_practice(
  p_practice_id uuid, p_kind text, p_channel text, p_subject_key text, p_data jsonb,
  p_dedupe text, p_send_after timestamptz
) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  INSERT INTO notification_outbox (practice_id, account_id, kind, channel, subject_key, data,
                                   dedupe_key, send_after)
  SELECT pr.id, pr.owner_account_id, p_kind, p_channel, p_subject_key,
         coalesce(p_data, '{}'::jsonb), p_dedupe, coalesce(p_send_after, now())
    FROM practice pr
   WHERE pr.id = p_practice_id
     AND pr.owner_account_id IS NOT NULL
     AND (pr.id = medskin_current_practice()
          OR EXISTS (SELECT 1 FROM patient_link l
                      WHERE l.practice_id = pr.id
                        AND l.account_id = medskin_current_account()
                        AND l.status = 'vinculada'))
  ON CONFLICT ("practice_id", "dedupe_key") DO NOTHING
  RETURNING id;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_notify_practice(uuid, text, text, text, jsonb, text, timestamptz) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_notify_practice(uuid, text, text, text, jsonb, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_notify_practice(uuid, text, text, text, jsonb, text, timestamptz) TO app_practitioner, app_patient, app_account;--> statement-breakpoint

-- A la cuenta de UNA FICHA de esa consulta, si la tiene. Una ficha sin cuenta no recibe avisos
-- y eso no es un error: es la mitad de las fichas de una consulta, y por eso el `INSERT … SELECT`
-- no inserta nada en vez de fallar.
CREATE FUNCTION medskin_notify_patient(
  p_practice_id uuid, p_patient_id uuid, p_kind text, p_channel text, p_subject_key text,
  p_data jsonb, p_dedupe text, p_send_after timestamptz
) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  INSERT INTO notification_outbox (practice_id, account_id, kind, channel, subject_key, data,
                                   dedupe_key, send_after)
  SELECT p_practice_id, l.account_id, p_kind, p_channel, p_subject_key,
         coalesce(p_data, '{}'::jsonb), p_dedupe, coalesce(p_send_after, now())
    FROM patient_link l
   WHERE l.patient_id = p_patient_id
     AND l.practice_id = p_practice_id
     AND l.status = 'vinculada'
     AND (p_practice_id = medskin_current_practice()
          OR EXISTS (SELECT 1 FROM patient_link mine
                      WHERE mine.practice_id = p_practice_id
                        AND mine.account_id = medskin_current_account()
                        AND mine.status = 'vinculada'))
   LIMIT 1
  ON CONFLICT ("practice_id", "dedupe_key") DO NOTHING
  RETURNING id;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_notify_patient(uuid, uuid, text, text, text, jsonb, text, timestamptz) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_notify_patient(uuid, uuid, text, text, text, jsonb, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_notify_patient(uuid, uuid, text, text, text, jsonb, text, timestamptz) TO app_practitioner, app_patient, app_account;--> statement-breakpoint

-- Y la de la lista de espera: dado el ASIENTO de la lista, su cuenta. Quien cancela no conoce
-- la ficha de quien espera, y no tiene por qué: lo que pasa por aquí es el identificador del
-- asiento que el propio `UPDATE` de la cancelación acaba de marcar.
CREATE FUNCTION medskin_notify_waitlist(
  p_entry_id uuid, p_data jsonb, p_dedupe text
) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  INSERT INTO notification_outbox (practice_id, account_id, kind, channel, subject_key, data,
                                   dedupe_key, send_after)
  SELECT w.practice_id, l.account_id, 'hueco_libre', 'push', 'hueco_libre',
         coalesce(p_data, '{}'::jsonb), p_dedupe, now()
    FROM waitlist_entry w
    JOIN patient_link l ON l.patient_id = w.patient_id AND l.practice_id = w.practice_id
                       AND l.status = 'vinculada'
   WHERE w.id = p_entry_id
     AND (w.practice_id = medskin_current_practice()
          OR EXISTS (SELECT 1 FROM patient_link mine
                      WHERE mine.practice_id = w.practice_id
                        AND mine.account_id = medskin_current_account()
                        AND mine.status = 'vinculada'))
   LIMIT 1
  ON CONFLICT ("practice_id", "dedupe_key") DO NOTHING
  RETURNING id;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_notify_waitlist(uuid, jsonb, text) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_notify_waitlist(uuid, jsonb, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_notify_waitlist(uuid, jsonb, text) TO app_practitioner, app_patient, app_account;
