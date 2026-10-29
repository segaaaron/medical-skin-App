-- =======================================================================================
-- LA 0051 REESCRIBIÓ `medskin_delete_own_account` DE MEMORIA, Y ESO NO SE HACE
--
-- La 0051 necesitaba UNA línea más en esa función —escribir el plazo en el vínculo que
-- suelta— y `CREATE OR REPLACE` no admite parches: hay que volver a escribir el cuerpo
-- entero. El cuerpo que se escribió allí era una RECONSTRUCCIÓN, y se equivocó en seis
-- sitios: los nombres de los cuatro veredictos (`already_deleted`, `practice_has_team`,
-- `practice_has_patients`, `subscription_active`), la columna (`plan_renews_on`, no
-- `renews_on`), el `revoked_reason` de las sesiones, el `FOR UPDATE` de la consulta, el orden
-- del `practitioner` y el recuento de pacientes. Lo cazó `account-lifecycle.spec.ts` en la
-- primera corrida: «column pc.renews_on does not exist».
--
-- Esta migración pone el cuerpo EXACTO de la 0014 —copiado del archivo, no recordado— con la
-- única línea que la 0051 quería añadir. Y la lección, que va al napkin: un `CREATE OR
-- REPLACE` de una función que ya existe se construye COPIANDO el cuerpo aplicado, nunca
-- escribiéndolo otra vez.
-- =======================================================================================
CREATE OR REPLACE FUNCTION medskin_delete_own_account(p_retention_until date, p_reason text)
RETURNS TABLE (verdict text, deleted_at timestamptz, sessions_revoked integer,
               links_detached integer, practice_deleted boolean, patient_count integer,
               plan_renews_on date)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_account uuid := medskin_current_account();
  v_now timestamptz := now();
  v_deleted_at timestamptz;
  v_region text;
  v_label text;
  v_practice uuid;
  v_practitioner_role text;
  v_owner uuid;
  v_renews date;
  v_patients integer := 0;
  v_team boolean;
  v_sessions integer := 0;
  v_links integer := 0;
  v_practice_deleted boolean := false;
BEGIN
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'medskin_delete_own_account: sin contexto de cuenta'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- El plazo tiene que ser una fecha futura: un «se conserva hasta ayer» no es una promesa,
  -- y un nulo dejaría la bitácora sin el único dato que la hace reconstruible.
  IF p_retention_until IS NULL OR p_retention_until <= current_date THEN
    RAISE EXCEPTION 'medskin_delete_own_account: el plazo de conservación ya pasó'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_reason IS NOT NULL AND length(p_reason) > 120 THEN
    RAISE EXCEPTION 'medskin_delete_own_account: el motivo no es un campo de texto libre'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.deleted_at, a.region, a.first_name || ' ' || a.last_name
    INTO v_deleted_at, v_region, v_label
    FROM account a WHERE a.id = v_account FOR UPDATE;
  IF NOT FOUND THEN
    -- El contexto trae una cuenta que no existe: no hay nada que borrar y nada que decir.
    RETURN QUERY SELECT 'no_account', NULL::timestamptz, 0, 0, false, NULL::integer,
                        NULL::date;
    RETURN;
  END IF;

  -- «Idempotente sí, por naturaleza: borrar lo ya borrado devuelve el mismo 200.» La fecha
  -- que vuelve es la del borrado DE VERDAD, no la de este reintento: el 200 repetido tiene
  -- que decir lo mismo que el primero.
  IF v_deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT 'already_deleted', v_deleted_at, 0, 0, false, NULL::integer,
                        NULL::date;
    RETURN;
  END IF;

  -- ¿Es equipo de alguna consulta? Si lo es y no es la dueña, no puede borrarse desde aquí.
  SELECT p.practice_id, p.role INTO v_practice, v_practitioner_role
    FROM practitioner p
   WHERE p.account_id = v_account AND p.status = 'activa'
   ORDER BY p.created_at, p.id LIMIT 1;

  IF v_practice IS NOT NULL THEN
    SELECT pc.owner_account_id, pc.plan_renews_on INTO v_owner, v_renews
      FROM practice pc WHERE pc.id = v_practice FOR UPDATE;

    IF v_owner IS NULL OR v_owner <> v_account THEN
      RETURN QUERY SELECT 'not_allowed', NULL::timestamptz, 0, 0, false, NULL::integer,
                          NULL::date;
      RETURN;
    END IF;

    -- 409 consulta_con_equipo · lo único que ella puede desarmar sola, así que va primero.
    SELECT EXISTS (SELECT 1 FROM practitioner p
                    WHERE p.practice_id = v_practice AND p.status = 'activa'
                      AND p.account_id <> v_account)
      INTO v_team;
    IF v_team THEN
      RETURN QUERY SELECT 'practice_has_team', NULL::timestamptz, 0, 0, false,
                          NULL::integer, NULL::date;
      RETURN;
    END IF;

    -- 409 consulta_con_pacientes · el número viaja porque la frase lo lleva dentro.
    SELECT count(*) INTO v_patients FROM patient p WHERE p.practice_id = v_practice;
    IF v_patients > 0 THEN
      RETURN QUERY SELECT 'practice_has_patients', NULL::timestamptz, 0, 0, false,
                          v_patients, NULL::date;
      RETURN;
    END IF;

    -- 409 suscripcion_activa · la fecha viaja por lo mismo.
    IF v_renews IS NOT NULL AND v_renews >= current_date THEN
      RETURN QUERY SELECT 'subscription_active', NULL::timestamptz, 0, 0, false, 0,
                          v_renews;
      RETURN;
    END IF;
  END IF;

  -- -------------------------------------------------------------------------------------
  -- A partir de aquí procede, y las cuatro escrituras son UNA transacción. Si alguna falla,
  -- la que ya pasó se deshace: es lo que el `500` promete literalmente.
  -- -------------------------------------------------------------------------------------

  -- «Todas las sesiones se revocan en el acto, en todos los dispositivos.» Incluida la que
  -- llama: al contrario que el cambio de contraseña, aquí no queda cuenta a la que volver.
  UPDATE session s SET revoked_at = v_now, revoked_reason = 'account_deleted'
   WHERE s.account_id = v_account AND s.revoked_at IS NULL;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  -- El acceso. Fila fuera, no marca: lo que se conserva no puede ser una contraseña viva.
  DELETE FROM credential c WHERE c.account_id = v_account;

  -- Una fila por cada doctora que la tenía. `email` se queda: es la llave del «vuelve_si».
  UPDATE patient_link l
     SET account_id = NULL, status = 'invitada', retention_until = p_retention_until,
         updated_at = v_now
   WHERE l.account_id = v_account;
  GET DIAGNOSTICS v_links = ROW_COUNT;

  -- La anonimización. El correo se SUELTA del índice único para que ese mismo correo pueda
  -- volver a darse de alta, que es la mitad de la promesa del contrato; el nombre se va
  -- porque es dato de contacto, y la fila se queda porque `access_audit`, `patient_link` y
  -- `medical_history_audit` la nombran y una bitácora que apunta a la nada no sirve.
  UPDATE account a
     SET email = ('borrada+' || a.id::text || '@medskin.invalid')::citext,
         first_name = 'Cuenta',
         last_name = 'borrada',
         phone = NULL,
         status = 'borrada',
         deleted_at = v_now,
         deletion_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         updated_at = v_now
   WHERE a.id = v_account;

  -- La consulta de quien probó MedSkin y no siguió. Se llega aquí solo con cero fichas, sin
  -- equipo y sin plan vigente, así que el `cascade` no se lleva ningún expediente: se lleva
  -- la licencia, su propia fila de `practitioner` y sus sesiones.
  IF v_practice IS NOT NULL THEN
    DELETE FROM practice pc WHERE pc.id = v_practice;
    v_practice_deleted := true;
  END IF;

  -- El plazo con el que se borró ESTA cuenta, que es el dato histórico que ninguna variable
  -- de entorno puede contar hacia atrás. Sin nada personal: identificadores y una fecha.
  INSERT INTO access_audit (practice_id, actor_account_id, actor_label, action,
                            subject_type, subject_id, data, region)
  VALUES (v_practice, v_account, v_label, 'account.delete', 'account', v_account,
          jsonb_build_object('retention_until', p_retention_until,
                             'reason', nullif(btrim(coalesce(p_reason, '')), ''),
                             'sessions_revoked', v_sessions,
                             'links_detached', v_links,
                             'practice_deleted', v_practice_deleted,
                             'practitioner_role', v_practitioner_role),
          v_region);

  RETURN QUERY SELECT 'deleted', v_now, v_sessions, v_links, v_practice_deleted,
                      v_patients, NULL::date;
END
$fn$;
