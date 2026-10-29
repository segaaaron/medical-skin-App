-- =======================================================================================
-- SU PROPIA FECHA DE NACIMIENTO, PARA LA CONTRAINDICACIÓN POR EDAD
--
-- `treatment_contraindication` admite `edad_menor_que`, y cruzarla necesita la fecha de
-- nacimiento de la ficha. `app_patient` NO TIENE `GRANT` sobre `patient` —ella lee
-- `patient_link`, nunca la ficha— y eso se queda: la ficha es de la consulta.
--
-- Así que una función que devuelve UNA FECHA, la suya, y solo de una consulta que la tenga
-- vinculada. Sin esto, `edad_menor_que` sería una contraindicación escrita que nunca bloquea:
-- un tratamiento vetado para menores se le ofrecería igual, que es el fallo que §6.2 punto 7
-- no se permite.
-- =======================================================================================
CREATE FUNCTION medskin_patient_birth_date(p_practice_id uuid)
RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT p.birth_date
    FROM patient p
    JOIN patient_link l ON l.patient_id = p.id
   WHERE l.practice_id = p_practice_id
     AND l.account_id = medskin_current_account()
     AND l.status = 'vinculada'
   LIMIT 1;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_patient_birth_date(uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_patient_birth_date(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_patient_birth_date(uuid) TO app_patient;
