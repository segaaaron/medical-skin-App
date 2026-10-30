-- =======================================================================================
-- OFRECER EL HUECO LIBRE · una función, porque quien cancela no puede ver la lista
--
-- El QA encontró que `app_patient` no tiene `UPDATE` sobre `waitlist_entry`, así que cuando
-- cancelaba una paciente y el aviso SÍ se encolaba, el `update offered_until` moría con
-- «permission denied», **abortaba la transacción y la cita no se cancelaba**: 500, la cita
-- seguía confirmada y la decisión de la seña se perdía.
--
-- Y al ir a arreglarlo apareció algo más grande, comprobado en el catálogo: la política
-- `waitlist_patient` acota a `app_patient` a **sus propios asientos**
-- (`EXISTS (patient_link … account_id = medskin_current_account())`). O sea que el `select` que
-- buscaba a quién avisar **no veía a nadie** cuando cancelaba una paciente:
--
--   · si en la lista esperaba OTRA persona → `lista_de_espera_avisada: 0` y **nadie se
--     enteraba nunca**, aunque hubiera cinco esperando;
--   · si la que esperaba era ella misma → el aviso se encolaba y el `UPDATE` reventaba (el 500
--     de arriba).
--
-- Y la mayoría de las cancelaciones las hace la paciente. O sea que «cancelar libera el hueco y
-- avisa a la lista de espera en el acto, en orden de llegada» (`agenda.md`) **no ocurría por el
-- camino principal**, y las pruebas no lo veían porque la de la paciente cancelaba con la lista
-- vacía y la de la lista cancelaba como doctora.
--
-- POR QUÉ UNA FUNCIÓN Y NO UN `GRANT`. Darle `UPDATE` a `app_patient` sería peor: su política
-- es «mi propio vínculo», así que el `UPDATE` sobre el asiento de otra pasaría a afectar **cero
-- filas sin fallar** —RLS filtra, no se queja— y volveríamos a tener un aviso mandado con la
-- reserva sin escribir. Es la lección del napkin §1.6 por el otro lado. Lo que hace falta es
-- que la decisión de A QUIÉN se le ofrece la tome quien puede verla entera, y que el aviso y la
-- reserva se escriban JUNTOS o no se escriba ninguno.
--
-- Las guardas son las de siempre: la consulta es el del contexto —la consulta— o uno al que
-- ESTA cuenta está vinculada —la paciente que cancela—. Y lo que devuelve es el asiento al que
-- se le ofreció, o nulo: ni el nombre de quien espera, ni su cuenta, ni su correo.
-- =======================================================================================
DROP FUNCTION medskin_notify_waitlist(uuid, jsonb, text);--> statement-breakpoint

-- `medskin_access` necesita poder escribir la reserva, y **con su política de `UPDATE`**: con
-- `FORCE ROW LEVEL SECURITY`, la política `FOR SELECT` de la 0048 no autoriza un `UPDATE` y el
-- `UPDATE` afectaría cero filas sin fallar (napkin §1.6, pagada hoy dos veces).
GRANT UPDATE ("offered_until") ON "waitlist_entry" TO medskin_access;--> statement-breakpoint
CREATE POLICY waitlist_access_write ON "waitlist_entry" FOR UPDATE TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint

CREATE FUNCTION medskin_waitlist_offer(
  p_practice_id uuid, p_treatment_id uuid, p_on_date date, p_data jsonb, p_dedupe_prefix text,
  p_offered_until timestamptz
) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  WITH permitido AS (
    -- La guarda, una vez y para toda la consulta.
    SELECT 1
     WHERE p_practice_id = medskin_current_practice()
        OR EXISTS (SELECT 1 FROM patient_link mine
                    WHERE mine.practice_id = p_practice_id
                      AND mine.account_id = medskin_current_account()
                      AND mine.status = 'vinculada')
  ),
  destino AS (
    -- EN ORDEN DE LLEGADA, y la primera a la que de verdad se le puede decir: hace falta una
    -- cuenta vinculada. Una ficha sin cuenta no recibe push, y eso no es un error —es la mitad
    -- de las fichas de una consulta—: se le ofrece a la siguiente.
    --
    -- Y se salta a quien ya tiene una oferta viva: dos huecos ofrecidos a la misma persona con
    -- una sola ventana registrada dejaría a la segunda de la lista sin nada.
    SELECT w.id AS entry_id, w.practice_id, l.account_id
      FROM waitlist_entry w
      JOIN patient_link l ON l.patient_id = w.patient_id
                         AND l.practice_id = w.practice_id
                         AND l.status = 'vinculada'
     WHERE w.practice_id = p_practice_id
       AND w.treatment_id = p_treatment_id
       AND p_on_date BETWEEN w.from_date AND w.to_date
       AND (w.offered_until IS NULL OR w.offered_until < now())
       AND EXISTS (SELECT 1 FROM permitido)
     ORDER BY w.created_at, w.id
     LIMIT 1
  ),
  encolado AS (
    INSERT INTO notification_outbox (practice_id, account_id, kind, channel, subject_key, data,
                                     dedupe_key, send_after)
    SELECT d.practice_id, d.account_id, 'hueco_libre', 'push', 'hueco_libre',
           coalesce(p_data, '{}'::jsonb), p_dedupe_prefix || ':' || d.entry_id::text, now()
      FROM destino d
    ON CONFLICT ("practice_id", "dedupe_key") DO NOTHING
    RETURNING id
  ),
  reservado AS (
    -- LA RESERVA SOLO SI EL AVISO SE ENCOLÓ. Reservarle el hueco a quien no se enteró es
    -- perderlo: la ventana vence y nadie lo tomó.
    UPDATE waitlist_entry
       SET offered_until = coalesce(p_offered_until, now() + interval '30 minutes')
     WHERE id = (SELECT entry_id FROM destino)
       AND EXISTS (SELECT 1 FROM encolado)
    RETURNING id
  )
  SELECT entry_id FROM destino WHERE EXISTS (SELECT 1 FROM reservado);
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_waitlist_offer(uuid, uuid, date, jsonb, text, timestamptz) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_waitlist_offer(uuid, uuid, date, jsonb, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_waitlist_offer(uuid, uuid, date, jsonb, text, timestamptz) TO app_practitioner, app_patient, app_account;
