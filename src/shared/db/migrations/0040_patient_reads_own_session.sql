-- =======================================================================================
-- LA PACIENTE LEE QUE SU SESIÓN EXISTE · y nada de lo que dice
--
-- El semáforo es «de sus sesiones» y la incidencia es «sobre una sesión suya» (`cuidados.md`),
-- así que para las dos hay que poder resolver la sesión desde su app. Lo que NO puede leer es
-- el expediente: ni la nota, ni las aplicaciones, ni los puntos, ni las observaciones.
--
-- Por eso el `GRANT` es POR COLUMNA y deja fuera `observations`, `practitioner_account_id`,
-- `voided_reason` y todo lo demás: lo que la política abre es la existencia de la sesión y su
-- fecha, que es lo que su propia pantalla necesita para pedir el semáforo y reportar algo.
-- =======================================================================================
CREATE POLICY clinical_session_patient_select ON "clinical_session" FOR SELECT TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.patient_id = clinical_session.patient_id
                    AND l.account_id = medskin_current_account()
                    AND l.status = 'vinculada'));--> statement-breakpoint
GRANT SELECT (id, practice_id, patient_id, appointment_id, started_at, ended_at, status)
  ON "clinical_session" TO app_patient;--> statement-breakpoint

-- Y la cita y el tratamiento, por lo mismo: el semáforo cuelga del tratamiento de esa sesión.
-- `appointment` ya tiene su política para `app_patient` (0030) y `treatment` la suya (0026);
-- lo que faltaba era poder llegar desde la sesión hasta el semáforo, que es esta lectura.
CREATE POLICY traffic_light_patient_select ON "treatment_traffic_light" FOR SELECT TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.practice_id = treatment_traffic_light.practice_id
                    AND l.account_id = medskin_current_account()
                    AND l.status = 'vinculada'));--> statement-breakpoint
GRANT SELECT ON "treatment_traffic_light" TO app_patient;
