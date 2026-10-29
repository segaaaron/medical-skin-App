-- =======================================================================================
-- LA MONEDA DE LA CONSULTA, PARA LA PACIENTE
--
-- `GET /v1/catalog` devuelve `moneda`, y la moneda vive en `practice.currency`: la única
-- columna de la verdad (`tratamientos.md`, decisión 2). Pero `app_patient` NO TIENE POLÍTICA
-- sobre `practice` y no se le va a dar: darle una abriría todos los inquilinos para poder leer
-- uno, que es exactamente lo que la pregunta 7 cerró copiando el nombre en `patient_link`.
--
-- Así que una función, como la del estado del acceso: devuelve UNA CADENA y solo de una
-- consulta que la tenga a ella vinculada. Si el vínculo no es suyo, devuelve nulo y no dice si
-- esa consulta existe.
--
-- `STABLE`: solo lee (§7.3, regla 3). Y con `search_path` fijo, porque esta SÍ puede llevarlo:
-- no es una función de política —no entra en ningún predicado de RLS— así que perder el
-- empotrado no cuesta un índice (la lección de la 0022 y la 0023).
-- =======================================================================================
CREATE FUNCTION medskin_patient_practice_currency(p_practice_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT p.currency
    FROM practice p
   WHERE p.id = p_practice_id
     AND EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.practice_id = p.id
                    AND l.account_id = medskin_current_account()
                    AND l.status = 'vinculada');
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_patient_practice_currency(uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_patient_practice_currency(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_patient_practice_currency(uuid) TO app_patient;
