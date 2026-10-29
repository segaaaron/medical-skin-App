-- =======================================================================================
-- EL TELÉFONO DE LA CONSULTA, PARA LA RESPUESTA DE UNA INCIDENCIA
--
-- `cuidados.md`: «`si_es_urgente` viaja SIEMPRE y lleva el teléfono de la consulta, incluso
-- cuando la paciente marcó `leve`. Una app no es un servicio de urgencias y no puede
-- comportarse como si lo fuera.»
--
-- El teléfono vive en `practice`, y `app_patient` no lee esa tabla —darle política abriría
-- todos los inquilinos para poder leer uno—. Misma forma que la moneda (0027) y la zona
-- horaria (0033): una función que devuelve UNA CADENA y solo de una consulta que la tiene
-- vinculada.
-- =======================================================================================
CREATE FUNCTION medskin_patient_practice_phone(p_practice_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT p.phone
    FROM practice p
   WHERE p.id = p_practice_id
     AND EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.practice_id = p.id
                    AND l.account_id = medskin_current_account()
                    AND l.status = 'vinculada');
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_patient_practice_phone(uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_patient_practice_phone(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_patient_practice_phone(uuid) TO app_patient, app_practitioner;
