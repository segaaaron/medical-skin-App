-- =======================================================================================
-- `patient.email` ES `NOT NULL`, y el barrendero lo ponía en nulo
--
-- La 0051 anonimizaba la ficha con `email = NULL` y la columna no lo admite: la pasada
-- reventaba con «null value in column "email" of relation "patient"». Lo cazó la misma prueba
-- que destapó lo de las políticas.
--
-- Y la columna tiene razón en ser `NOT NULL`: el correo de la ficha es por dónde la doctora le
-- escribe, y una ficha sin forma de contacto no es una ficha. Así que se anonimiza igual que
-- `account.email` en el borrado de cuenta (0014): un correo del dominio inválido, único por
-- fila, que no es de nadie y no colisiona con ningún índice.
-- =======================================================================================
CREATE OR REPLACE FUNCTION medskin_purge_retained(p_limit integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_row record;
  v_done integer := 0;
BEGIN
  FOR v_row IN
    SELECT p.id, p.practice_id, l.retention_until
      FROM patient_link l
      JOIN patient p ON p.id = l.patient_id
     WHERE l.account_id IS NULL
       AND l.retention_until IS NOT NULL
       AND l.retention_until <= current_date
       AND p.purged_at IS NULL
     ORDER BY l.retention_until
     LIMIT greatest(1, least(coalesce(p_limit, 50), 500))
  LOOP
    DELETE FROM medical_history WHERE patient_id = v_row.id;
    DELETE FROM medical_history_audit WHERE patient_id = v_row.id;
    DELETE FROM consent WHERE patient_id = v_row.id;
    DELETE FROM message WHERE thread_id IN (
      SELECT t.id FROM message_thread t WHERE t.patient_id = v_row.id
    );
    DELETE FROM message_thread WHERE patient_id = v_row.id;

    UPDATE photo
       SET deleted_at = coalesce(deleted_at, now()),
           deleted_reason = coalesce(deleted_reason, 'plazo_de_conservacion_cumplido'),
           updated_at = now()
     WHERE patient_id = v_row.id AND deleted_at IS NULL;

    UPDATE patient
       SET first_name = 'Ficha',
           last_name = 'anonimizada',
           birth_date = '1900-01-01',
           email = ('anonima+' || v_row.id::text || '@medskin.invalid')::citext,
           phone = NULL,
           has_whatsapp = false,
           status = 'archivada',
           archived_at = coalesce(archived_at, now()),
           purged_at = now(),
           updated_at = now()
     WHERE id = v_row.id;

    DELETE FROM patient_link WHERE patient_id = v_row.id AND account_id IS NULL;

    INSERT INTO access_audit (practice_id, action, subject_type, subject_id, data)
    VALUES (v_row.practice_id, 'paciente.plazo_cumplido', 'paciente', v_row.id,
            jsonb_build_object('retention_until', v_row.retention_until));

    v_done := v_done + 1;
  END LOOP;
  RETURN v_done;
END
$fn$;
