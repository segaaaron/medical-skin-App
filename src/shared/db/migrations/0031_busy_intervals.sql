-- =======================================================================================
-- LOS INTERVALOS OCUPADOS · dos horas, nunca una fila
--
-- Para calcular un hueco hay que saber qué está ocupado, y lo ocupado son las citas DE LAS
-- DEMÁS. La política de `appointment` para `app_patient` le deja ver SOLO las suyas, y eso se
-- queda así: la agenda de una consulta dice a qué hora va cada paciente, y eso es dato de
-- salud en una clínica de estética.
--
-- Así que esta función devuelve PARES DE INSTANTES y nada más: ni el `patient_id`, ni el
-- tratamiento, ni el estado. Con eso el servidor resta y saca el hueco; con una fila, la app
-- de una paciente sabría quién va a las cuatro.
--
-- QUIÉN PUEDE LLAMARLA: la consulta sobre la suya, o una paciente sobre una consulta que la
-- tiene vinculada. La comprobación va DENTRO, porque una función `SECURITY DEFINER` corre con
-- los privilegios de su dueño y sin esto sería la puerta de atrás a la agenda de cualquiera.
--
-- `STABLE`: solo lee. Y con `search_path` fijo, que puede llevarlo porque no entra en ningún
-- predicado de política (la lección de la 0022).
-- =======================================================================================
CREATE FUNCTION medskin_busy_intervals(p_practice_id uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (starts_at timestamptz, ends_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF p_practice_id IS NULL OR p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'medskin_busy_intervals: faltan parámetros'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Ni la consulta del contexto ni un vínculo aceptado: no hay nada que contar.
  IF NOT (
    medskin_current_practice() = p_practice_id
    OR EXISTS (SELECT 1 FROM patient_link l
                WHERE l.practice_id = p_practice_id
                  AND l.account_id = medskin_current_account()
                  AND l.status = 'vinculada')
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT a.starts_at, a.ends_at
      FROM appointment a
     WHERE a.practice_id = p_practice_id
       -- Lo cancelado no ocupa; lo atendido y lo que espera seña, sí: «mientras la seña está
       -- pendiente el hueco se guarda».
       AND a.status IN ('pendiente_de_sena', 'confirmada', 'atendida', 'no_asistio')
       AND a.starts_at < p_to
       AND a.ends_at > p_from
     ORDER BY a.starts_at;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_busy_intervals(uuid, timestamptz, timestamptz) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_busy_intervals(uuid, timestamptz, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_busy_intervals(uuid, timestamptz, timestamptz) TO app_practitioner, app_patient;--> statement-breakpoint
-- `medskin_access` necesita leer `appointment` para que la función de arriba funcione: el
-- privilegio se comprueba ANTES que la política, y aquí no hay política que valga sin él
-- (la lección de la 0029).
CREATE POLICY appointment_access ON "appointment" FOR SELECT TO medskin_access
  USING (current_user = 'medskin_access');--> statement-breakpoint
GRANT SELECT (practice_id, starts_at, ends_at, status) ON "appointment" TO medskin_access;
