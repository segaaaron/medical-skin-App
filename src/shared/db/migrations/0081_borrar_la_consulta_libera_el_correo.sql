-- Borrar una consulta dejaba la CUENTA de la doctora viva, y con ella su correo ocupado.
--
-- Medido el 3 de noviembre de 2026, con el padrón ya en «Doctores 0»: el alta del mismo
-- correo seguía contestando «Ese correo ya tiene una cuenta en MedSkin». La causa está en el
-- modelo y es correcta: `account` NO cuelga de `practice` —la ficha es del inquilino, la
-- cuenta es de la persona— y `practice.owner_account_id` es `ON DELETE SET NULL`. El
-- `CASCADE` se llevaba la consulta entera y no podía tocar la cuenta.
--
-- La salida NO es borrar la fila de `account`. `access_audit`, `patient_link` y
-- `medical_history_audit` la nombran, y una bitácora que apunta a la nada no sirve de nada
-- el día que alguien pregunte quién borró qué. La salida es la que esta casa ya eligió para
-- `DELETE /v1/accounts/mine` en `medskin_delete_own_account`: **soltar el correo del índice
-- único** y dejar el resto en un muñón. Un mecanismo, no dos.
--
-- Por qué una función con `SECURITY DEFINER` y no un `GRANT DELETE ON account TO
-- app_platform`: el grant dejaría a la consola tocar CUALQUIER cuenta de la región, incluida
-- la de una paciente que no tiene nada que ver. Aquí solo puede liberar las que estaban
-- atadas a la consulta que acaba de borrar, y la regla vive en la base.
--
-- Qué NO libera, a propósito: las cuentas de las PACIENTES. Su ficha se va con la consulta,
-- pero su cuenta es suya —puede estar vinculada a otra doctora, y borrarla sería decidir por
-- ella—. Si el dueño quiere también eso, es otra migración y otra decisión escrita.

CREATE OR REPLACE FUNCTION medskin_delete_practice(p_practice_id uuid)
RETURNS TABLE(name text, patients integer, accounts_released integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_name text;
  v_patients integer := 0;
  v_now timestamptz := now();
  v_candidates uuid[];
  v_released integer := 0;
BEGIN
  SELECT p.name INTO v_name FROM practice p WHERE p.id = p_practice_id FOR UPDATE;
  -- Sin filas: la consulta no existe. Se devuelve vacío y quien llama lo traduce al
  -- `404 consulta_no_existe` del contrato.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_patients FROM patient p WHERE p.practice_id = p_practice_id;

  -- Las cuentas atadas a ESTA consulta: la dueña y el equipo. Se toman ANTES del borrado,
  -- porque el `CASCADE` se lleva las filas de `practitioner` y después no hay de dónde
  -- leerlas.
  SELECT coalesce(array_agg(DISTINCT x.account_id), '{}'::uuid[])
    INTO v_candidates
    FROM (
      SELECT pc.owner_account_id AS account_id FROM practice pc WHERE pc.id = p_practice_id
      UNION
      SELECT pr.account_id FROM practitioner pr WHERE pr.practice_id = p_practice_id
    ) x
   WHERE x.account_id IS NOT NULL;

  DELETE FROM practice pc WHERE pc.id = p_practice_id;

  -- El token vive 12 h y no cuelga de la consulta: sin esto, quien tuviera la app abierta
  -- seguiría llamando con una credencial de una consulta que ya no existe.
  UPDATE session s
     SET revoked_at = v_now, revoked_reason = 'practice_deleted'
   WHERE s.account_id = ANY(v_candidates) AND s.revoked_at IS NULL;

  -- Fila fuera, no marca: lo que se conserva no puede ser una contraseña viva.
  DELETE FROM credential c WHERE c.account_id = ANY(v_candidates);

  -- La anonimización. El `NOT EXISTS` triple es la guarda: una cuenta que todavía sea equipo
  -- de otra consulta, dueña de otra, o paciente en algún sitio, NO se toca. Hoy no pasa
  -- —una dueña por consulta— y el día que pase, esto ya está decidido.
  WITH liberadas AS (
    UPDATE account a
       SET email = ('borrada+' || a.id::text || '@medskin.invalid')::citext,
           first_name = 'Cuenta',
           last_name = 'borrada',
           phone = NULL,
           status = 'borrada',
           deleted_at = v_now,
           deletion_reason = 'consulta_borrada',
           updated_at = v_now
     WHERE a.id = ANY(v_candidates)
       AND a.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM practitioner pr WHERE pr.account_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM practice pc WHERE pc.owner_account_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM patient_link pl WHERE pl.account_id = a.id)
    RETURNING 1
  )
  SELECT count(*) INTO v_released FROM liberadas;

  RETURN QUERY SELECT v_name, v_patients, v_released;
END
$fn$;--> statement-breakpoint

ALTER FUNCTION medskin_delete_practice(uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_delete_practice(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_delete_practice(uuid) TO app_platform;
