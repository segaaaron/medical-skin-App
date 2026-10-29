-- =======================================================================================
-- LA CORRECCIÓN DE LAS TRES PREGUNTAS, EN LA BASE
--
-- Quien firma el consentimiento puede ser LA PACIENTE, y su rol no tiene `GRANT` sobre
-- `consent_text.answer_key` (0035). Esa es la garantía: «la app no sabe la respuesta y no puede
-- saberla; si la supiera, cualquiera leería el código y la comprensión verificada dejaría de
-- verificar nada».
--
-- Así que la corrección la hace esta función, que devuelve **qué preguntas falló** y nunca
-- cuáles eran las correctas. Con eso la app puede volver al párrafo de esa pregunta —que es lo
-- que el contrato pide— sin poder deducir la respuesta.
-- =======================================================================================
CREATE FUNCTION medskin_consent_wrong_answers(p_treatment_id uuid, p_answers jsonb)
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT coalesce(array_agg(k.key ORDER BY k.key), '{}')
    FROM (
      SELECT ct.answer_key
        FROM consent_text ct
       WHERE ct.treatment_id = p_treatment_id AND ct.published
       ORDER BY ct.created_at DESC
       LIMIT 1
    ) latest,
    LATERAL jsonb_each_text(latest.answer_key) AS k(key, value)
   WHERE p_answers ->> k.key IS DISTINCT FROM k.value;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_consent_wrong_answers(uuid, jsonb) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_consent_wrong_answers(uuid, jsonb) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_consent_wrong_answers(uuid, jsonb) TO app_practitioner, app_patient;--> statement-breakpoint
-- La función corre como `medskin_access`, que necesita el privilegio además de la política.
CREATE POLICY consent_text_access ON "consent_text" FOR SELECT TO medskin_access
  USING (current_user = 'medskin_access');--> statement-breakpoint
GRANT SELECT ON "consent_text" TO medskin_access;
