-- =======================================================================================
-- LA DECISIÓN DE LA LICENCIA AVISA A LA DUEÑA · 29 de octubre de 2026
--
-- `decide-license.ts` escribía la decisión, la bitácora y la respuesta de la consola, y la
-- doctora no se enteraba de nada: su consulta pasaba de «en revisión» a «activa» —o a
-- «rechazada»— y lo único que podía hacer era abrir la app y mirar. En una aprobación eso es
-- una espera innecesaria; en un rechazo es peor, porque hay algo que corregir y nadie se lo
-- dijo.
--
-- La consola entra con `app_platform`, que no tiene consulta de contexto porque legítimamente
-- actúa sobre todos: no puede usar `medskin_notify` —cuyas guardas son «la consulta del
-- contexto o uno al que esta cuenta está vinculada»—. Esta función es la suya, con la guarda
-- que sí le corresponde: resuelve la cuenta DUEÑA de esa consulta y encola ahí, y en ningún
-- otro sitio. Y los dos canales, porque es «seguridad de la cuenta» en el sentido del
-- contrato: push y correo, y no se apaga.
-- =======================================================================================
CREATE FUNCTION medskin_notify_owner(
  p_practice_id uuid, p_kind text, p_channel text, p_subject_key text, p_data jsonb,
  p_dedupe text
) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  INSERT INTO notification_outbox (practice_id, account_id, kind, channel, subject_key, data,
                                   dedupe_key, send_after)
  SELECT pr.id, pr.owner_account_id, p_kind, p_channel, p_subject_key,
         coalesce(p_data, '{}'::jsonb), p_dedupe, now()
    FROM practice pr
   WHERE pr.id = p_practice_id AND pr.owner_account_id IS NOT NULL
  ON CONFLICT ("practice_id", "dedupe_key") DO NOTHING
  RETURNING id;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_notify_owner(uuid, text, text, text, jsonb, text) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_notify_owner(uuid, text, text, text, jsonb, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_notify_owner(uuid, text, text, text, jsonb, text) TO app_platform;
