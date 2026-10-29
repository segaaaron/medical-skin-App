-- La zona horaria de la consulta, para la paciente. Misma forma y mismo motivo que la moneda
-- de la 0027: `app_patient` no lee `practice`, y sin la zona no hay hueco que dibujar en su
-- app —una agenda calculada con el reloj del teléfono se mueve un día entero cuando viaja—.
CREATE FUNCTION medskin_patient_practice_time_zone(p_practice_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT p.time_zone
    FROM practice p
   WHERE p.id = p_practice_id
     AND EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.practice_id = p.id
                    AND l.account_id = medskin_current_account()
                    AND l.status = 'vinculada');
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_patient_practice_time_zone(uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_patient_practice_time_zone(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_patient_practice_time_zone(uuid) TO app_patient;
