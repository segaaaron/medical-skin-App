-- =======================================================================================
-- LO QUE LA RESERVA NECESITA LEER, Y QUE NINGÚN ROL PODÍA
--
-- Tres agujeros que la primera prueba del tramo 4 destapó, y los tres del mismo tipo: el
-- privilegio se comprueba ANTES que la política, así que una consulta que nombra una columna
-- sin `GRANT` muere con «permission denied» aunque la fila sí fuera suya.
--
-- 1 · EL CRUCE CLÍNICO SE VA A UNA FUNCIÓN. Decidir si un tratamiento está contraindicado para
--     una paciente exige leer `medical_history` ENTERA —`phototype` incluido—, y `phototype` no
--     está en el `GRANT` de `app_patient` a propósito (0006): el fototipo lo evalúa quien la ve.
--     Así que el cruce lo hace una función que devuelve UN BOOLEANO. Ni la app de la paciente
--     ni la de la doctora reciben qué la bloqueó: el motivo es su dato clínico.
--
-- 2 · LOS PASOS DE PREPARACIÓN SÍ SON SUYOS. `treatment_protocol_step` con momento `antes` es
--     lo que su app agenda como aviso local —«no tomes alcohol 24 h antes»— y el contrato los
--     manda DENTRO de la respuesta de la cita para que funcionen sin conexión. Son del
--     tratamiento, no de ninguna persona, y por eso se pueden leer.
-- =======================================================================================
CREATE FUNCTION medskin_treatment_blocked_for(p_treatment_id uuid, p_patient_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM treatment_contraindication ci
      JOIN medical_history h ON h.patient_id = p_patient_id
     WHERE ci.treatment_id = p_treatment_id
       -- Solo las ABSOLUTAS cierran la puerta. Una relativa avisa a la doctora y ella decide:
       -- «puede seguir asumiéndolo, y queda registrado que lo asumió».
       AND ci.absolute
       AND (
            (ci.key = 'embarazo'   AND h.pregnancy_or_lactation = 'embarazo')
         OR (ci.key = 'lactancia'  AND h.pregnancy_or_lactation = 'lactancia')
         OR (ci.key = 'alergia'    AND EXISTS (SELECT 1 FROM unnest(h.allergies) a
                                                WHERE lower(a) LIKE '%' || lower(ci.value) || '%'))
         OR (ci.key = 'medicacion' AND EXISTS (SELECT 1 FROM unnest(h.medication) m
                                                WHERE lower(m) LIKE '%' || lower(ci.value) || '%'))
         OR (ci.key = 'antecedente' AND EXISTS (SELECT 1 FROM unnest(h.past_conditions) pc
                                                 WHERE lower(pc) LIKE '%' || lower(ci.value) || '%'))
         OR (ci.key = 'fototipo_mayor_que' AND h.phototype IS NOT NULL
             AND h.phototype > ci.value::int)
         OR (ci.key = 'fototipo_menor_que' AND h.phototype IS NOT NULL
             AND h.phototype < ci.value::int)
         OR (ci.key = 'edad_menor_que' AND EXISTS (
               SELECT 1 FROM patient p WHERE p.id = p_patient_id
                AND extract(year from age(p.birth_date)) < ci.value::int))
       )
  );
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_treatment_blocked_for(uuid, uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_treatment_blocked_for(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_treatment_blocked_for(uuid, uuid) TO app_practitioner, app_patient;--> statement-breakpoint
-- La función corre como `medskin_access`, que necesita leer las dos tablas del cruce. Las
-- políticas ya existen (`medical_history` desde la 0006, `patient` desde la 0006); lo que
-- faltaba era el privilegio, que es lo que esta migración arregla de verdad.
CREATE POLICY medical_history_access ON "medical_history" FOR SELECT TO medskin_access
  USING (current_user = 'medskin_access');--> statement-breakpoint
GRANT SELECT ON "medical_history" TO medskin_access;--> statement-breakpoint
CREATE POLICY contraindication_access ON "treatment_contraindication" FOR SELECT TO medskin_access
  USING (current_user = 'medskin_access');--> statement-breakpoint
GRANT SELECT ON "treatment_contraindication" TO medskin_access;--> statement-breakpoint

-- Los pasos de preparación, que la paciente sí puede leer: son del tratamiento.
CREATE POLICY protocol_step_patient_select ON "treatment_protocol_step" FOR SELECT TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.practice_id = treatment_protocol_step.practice_id
                    AND l.account_id = medskin_current_account()
                    AND l.status = 'vinculada'));--> statement-breakpoint
GRANT SELECT ON "treatment_protocol_step" TO app_patient;
