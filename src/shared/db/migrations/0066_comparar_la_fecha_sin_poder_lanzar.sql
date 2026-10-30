-- =======================================================================================
-- LA MISMA COMPARACION, SIN PODER LANZAR · «toca volver», tercera versión y última
--
-- La 0063 comparaba `o.data->>'desde'` con `(…)::date::text`, y eso depende de `DateStyle`
-- (medido: con `German`, `date::text` da `29.10.2026`). La 0065 lo arregló casteando el lado
-- izquierdo a `date`, y eso quita la dependencia pero mete otra cosa: **un `::date` sobre un
-- texto que no es fecha LANZA**, y esto corre dentro de un trabajo de la cola.
--
--     ERROR:  invalid input syntax for type date: "ayer"
--
-- Hoy no hay cómo llegar ahí —el único que escribe `kind = 'toca_volver'` es `callBack()`, y lo
-- que pone en `desde` es el `due_on date` que esta misma función devuelve—, pero la garantía es
-- «ningún llamante futuro escribirá otra cosa», que no es una garantía: es una costumbre. Y el
-- precio de que falle es el de siempre en este archivo —el trabajo muere en cada disparo— por una
-- fila mal escrita de una cuenta cualquiera.
--
-- `to_char(fecha, 'YYYY-MM-DD')` da las dos cosas a la vez: **no lo toca `DateStyle`** —el formato
-- va escrito, comprobado con `German`— y **no puede lanzar**, porque el lado izquierdo se queda
-- texto y un texto raro simplemente no casa. Que es exactamente lo que tiene que pasar con una
-- fila que no se entiende: no excluye a nadie, y el aviso se vuelve a encolar —la deduplicación
-- lo para—, en vez de apagar el trabajo entero.
-- =======================================================================================
CREATE OR REPLACE FUNCTION medskin_patients_to_return(p_limit integer)
RETURNS TABLE (practice_id uuid, account_id uuid, email text, treatment_id uuid, due_on date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  WITH ultima AS (
    SELECT s.patient_id, a.treatment_id, a.practice_id, max(s.started_at) AS last_at
      FROM clinical_session s
      JOIN appointment a ON a.id = s.appointment_id
     WHERE s.status = 'firmada'
     GROUP BY s.patient_id, a.treatment_id, a.practice_id
  )
  SELECT u.practice_id, l.account_id, ac.email::text, u.treatment_id,
         (u.last_at + make_interval(days => t.min_interval_days))::date AS due_on
    FROM ultima u
    JOIN treatment t ON t.id = u.treatment_id
    JOIN patient t2 ON t2.id = u.patient_id
    JOIN patient_link l ON l.patient_id = u.patient_id AND l.status = 'vinculada'
    JOIN account ac ON ac.id = l.account_id
   WHERE t.min_interval_days IS NOT NULL
     AND t.planned_sessions > 1
     AND t.status = 'activo'
     AND t2.status = 'activa'
     AND u.last_at + make_interval(days => t.min_interval_days) <= now()
     AND NOT EXISTS (SELECT 1 FROM appointment a2
                      WHERE a2.patient_id = u.patient_id
                        AND a2.treatment_id = u.treatment_id
                        AND a2.status IN ('pendiente_de_sena', 'confirmada')
                        AND a2.starts_at > now())
     -- Quien ya tiene su aviso de ESTE tratamiento para ESTA fecha no vuelve a ocupar un hueco
     -- del `LIMIT`. El formato va escrito —ni `DateStyle` ni un casteo que pueda lanzar— y es el
     -- mismo que el código escribe: `YYYY-MM-DD`.
     AND NOT EXISTS (SELECT 1 FROM notification_outbox o
                      WHERE o.practice_id = u.practice_id
                        AND o.account_id = l.account_id
                        AND o.kind = 'toca_volver'
                        AND o.data->>'tratamiento_id' = u.treatment_id::text
                        AND o.data->>'desde' = to_char(
                              u.last_at + make_interval(days => t.min_interval_days),
                              'YYYY-MM-DD'))
   ORDER BY due_on
   LIMIT greatest(1, least(coalesce(p_limit, 200), 1000));
$fn$;
