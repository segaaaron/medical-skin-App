-- Tramo 1 · lo que le faltaba a `cuentas.md` para estar entero: el borrado de la propia
-- cuenta, el alta del equipo y el reenvío de acceso de la consola.
--
-- Escrita a mano: nada de esto lo expresa drizzle-kit. Y NO TRAE NI UNA TABLA NI UNA
-- COLUMNA NUEVA, que es el hallazgo de esta migración: los cuatro endpoints que quedaban
-- se resuelven con tres funciones `SECURITY DEFINER` y los grants que esas funciones
-- necesitan. Las copias de la pregunta 7 —`patient_link.practice_name` y
-- `practitioner_name`— ya las trajo la 0006, así que `GET /v1/cuentas/mia` y
-- `DELETE /v1/plataforma/cuentas/{id}/pausa` ya eran servibles sin tocar nada.
--
-- §3.4, regla 7 · §1.5 del napkin: versionada, y NUNCA editada después de aplicarse.
--
-- =======================================================================================
-- POR QUÉ LOS TRES SON FUNCIONES Y NO GRANTS, Y ES LA MISMA RAZÓN LAS TRES VECES
--
-- Cada uno de los tres actos cruza una frontera que las políticas por fila cierran a
-- propósito, y ninguno se puede abrir con un `GRANT` sin abrirlo también para lo que no
-- es ese acto:
--
--   · Borrar la propia cuenta toca `account` (por `id`), `credential`, `session` (por
--     `account_id`) y `patient_link` (cuya política de paciente es de `SELECT` y cuyo
--     `GRANT UPDATE` es de `status` y nada más). Darle a `app_patient` el `UPDATE` de
--     `patient_link.account_id` sería darle la capacidad de desvincularse de una doctora
--     por fuera de la pantalla que lo hace, y el `UPDATE` de `account.email` sería dejarle
--     cambiar su correo de acceso sin pasar por la verificación. Y sobre todo: son cuatro
--     tablas en UNA transacción que ningún rol puede dejar a medias, que es literalmente
--     lo que el contrato promete («No se borró nada: puedes volver a intentarlo»).
--   · Dar de alta al equipo escribe `account` + `credential` + `practitioner`, y
--     `app_practitioner` no tiene —ni va a tener— `INSERT` sobre `account` ni nada sobre
--     `credential`: su política de `credential` es `account_id = medskin_current_account()`,
--     así que lo único que alcanza es su propia contraseña. Es la misma frontera que
--     impide que una doctora resetee la de su paciente.
--   · El reenvío de la consola escribe `credential` de una cuenta cualquiera, y
--     `app_platform` no tiene un solo grant sobre `credential`: «Va a su propio correo.
--     Soporte no la ve», y eso tiene que ser verdad en la base y no en el controlador.
--
-- Las tres son `VOLATILE` porque las tres ESCRIBEN (§1.8 del napkin, decisión 16): un
-- `INSERT` dentro de una función no volátil se crea sin queja y revienta en la primera
-- llamada real. Las tres son de `medskin_access` y no de `medskin_owner`, que es
-- superusuario (§1.9). Las tres fijan `search_path`. Y los parámetros de correo se
-- declaran `citext` y no `text` (§1.10): con `text` la comparación contra la columna se
-- resuelve por `text = text` y pasa a ser sensible a mayúsculas, en silencio.
-- =======================================================================================

-- =======================================================================================
-- 1 · LOS GRANTS QUE LAS TRES FUNCIONES NECESITAN, Y NI UNO MÁS
--
-- `medskin_access` ya tenía política `FOR ALL` en `account`, `credential`, `session`,
-- `practitioner`, `practice` y `license` (migración 0002) y en `patient_link` (0006). Lo
-- que se amplía aquí son COLUMNAS, y cada línea dice qué endpoint la pide.
-- =======================================================================================

-- El borrado anonimiza la fila de `account` en vez de borrarla: «el expediente se conserva
-- el plazo legal y vuelve a ser visible si la doctora da de alta el mismo correo». Para que
-- ese mismo correo vuelva a poder registrarse hay que SOLTARLO del índice único
-- `account_email_uq`, y para eso hay que poder escribir `email`. Las otras cinco columnas
-- son los `datos_de_contacto` y el `acceso` de la lista `se_borro` del contrato.
-- La 0002 ya le daba `UPDATE (failed_attempts, locked_until, updated_at)`: un `GRANT` de
-- columnas se suma, no reemplaza.
GRANT UPDATE (email, first_name, last_name, phone, status, deleted_at, deletion_reason,
              updated_at)
  ON "account" TO medskin_access;--> statement-breakpoint

-- «se_borro: ["acceso", …]». La credencial de una cuenta borrada no es un dato que
-- conservar: es una contraseña viva. Se borra la fila, no se marca.
GRANT DELETE ON "credential" TO medskin_access;--> statement-breakpoint

-- `patient_link.account_id` a nulo —la columna es `set null` a propósito desde la 0006,
-- «el expediente es de la consulta y sobrevive al borrado de la cuenta de la persona»— y
-- `status` de vuelta a `invitada`, que es la verdad después del borrado: la ficha sigue ahí
-- y nadie tiene acceso a ella.
--
-- `email` NO se toca, y es la decisión de forma del borrado: `patient_link.email` es LA
-- LLAVE de «vuelve_si: tu doctora te da de alta otra vez con este mismo correo». Es lo
-- único que queda uniendo la ficha conservada con la persona, porque `account.email` se
-- suelta justo para que ese correo pueda volver a registrarse. Borrar las dos copias haría
-- imposible la promesa del contrato.
GRANT UPDATE (account_id, status, updated_at) ON "patient_link" TO medskin_access;--> statement-breakpoint

-- `409 consulta_con_pacientes` necesita CONTAR las fichas de la consulta de la dueña, y el
-- error lleva el número en la frase («Tu consulta tiene 148 pacientes»). Dos columnas y
-- ninguna clínica: el identificador y la consulta. `medskin_access` no tenía política en
-- `patient`, así que hace falta la suya —igual que las otras siete de la 0002: no filtra
-- filas, el filtro es el cuerpo de la función y la frontera de confianza es su firma—.
ALTER TABLE "patient" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY patient_access ON "patient" FOR SELECT TO medskin_access
  USING (current_user = 'medskin_access');--> statement-breakpoint
GRANT SELECT (id, practice_id) ON "patient" TO medskin_access;--> statement-breakpoint

-- «Una doctora SIN una sola ficha sí puede borrarse, y entonces la consulta se borra con
-- ella: no hay expediente que conservar. Es el caso de quien probó MedSkin y no siguió.»
-- Solo `DELETE`: la función no cambia ni el plan ni el nombre ni el estado de ninguna
-- consulta, y el `DELETE` solo se ejecuta tras comprobar que no queda una sola `patient`.
GRANT DELETE ON "practice" TO medskin_access;--> statement-breakpoint

-- =======================================================================================
-- 2 · DELETE /v1/cuentas/mia · medskin_delete_own_account()
--
-- NO RECIBE `account_id`, y es la misma decisión de seguridad que la de
-- `medskin_create_patient_account`: la cuenta sale del CONTEXTO
-- (`medskin.account_id`), nunca de un argumento. Con un argumento, cualquiera con sesión
-- podría borrar la cuenta de cualquiera, y la de una doctora se lleva su consulta entera.
--
-- `p_retention_until` ES UN ARGUMENTO Y NO SALE DE UNA TABLA. Es la decisión de producto
-- del 28 de octubre, y cierra la pregunta 8 («Bloquean el tramo 2») igual que la 6 cerró
-- `region_etiqueta`: el plazo legal de conservación es configuración del despliegue
-- (`CONSERVACION_ANOS`), no dato de consulta. Todos las consultas de una región comparten
-- el plazo, y guardarlo por fila serían N copias del mismo literal que se pueden
-- desincronizar.
--
-- LO QUE SÍ ES DATO DE BASE, Y POR ESO EL ARGUMENTO EXISTE EN VEZ DE QUEDARSE FUERA: con
-- qué plazo se borró UNA cuenta concreta es un HECHO HISTÓRICO, no un parámetro. El día que
-- el plazo cambie de siete a diez años, la fila borrada ayer no se reinterpreta. Así que la
-- fecha que la función recibe queda escrita en `access_audit.data.retention_until`, que es
-- una bitácora inmutable y sin dato clínico, y de ahí se reconstruye qué se le prometió a
-- quién. No hace falta una tabla para eso: hace falta una línea de bitácora, que ya existe.
--
-- LOS TRES `409` SE COMPRUEBAN EN EL ORDEN DEL CONTRATO, y el orden importa porque una
-- dueña puede tener los tres a la vez y la pantalla muestra uno: equipo, pacientes,
-- suscripción. «Antes de borrar a la persona hay que desarmar lo que depende de ella», y
-- el equipo es lo primero porque es lo único que ella puede desarmar sola.
--
-- Y RECHAZA A RECEPCIÓN Y AL ASISTENTE («Recepción y asistente, no»): si la cuenta tiene
-- fila activa de `practitioner` y NO es la dueña de esa consulta, el veredicto es
-- `not_allowed` → `403 sin_permiso`. No es una comprobación del controlador que se pueda
-- olvidar: es la misma transacción que borraría.
--
-- NO TOCA `patient`, `medical_history`, `medical_history_audit` NI `patient_link.email`.
-- «La historia clínica es de la consulta» y `patient` es la ficha: su correo y su celular
-- son por dónde la doctora le escribe, y son parte del expediente que se conserva. Lo que
-- se va es el acceso y los datos de contacto DE LA CUENTA.
-- =======================================================================================
CREATE FUNCTION medskin_delete_own_account(p_retention_until date, p_reason text)
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
     SET account_id = NULL, status = 'invitada', updated_at = v_now
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
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_delete_own_account(date, text) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_delete_own_account(date, text) FROM PUBLIC;--> statement-breakpoint
-- Y NO a `app_account`: el token de recuperación es una sesión a medio abrir, y borrar la
-- cuenta es irreversible. La pantalla que lo llama pide la contraseña actual, que es lo que
-- una sesión restringida justamente no tiene. Ni a `app_anonymous`, ni a `app_platform`:
-- soporte no borra la cuenta de nadie, eso es el traspaso de consulta y es otro tramo.
GRANT EXECUTE ON FUNCTION medskin_delete_own_account(date, text)
  TO app_practitioner, app_patient;--> statement-breakpoint

-- =======================================================================================
-- 3 · POST /v1/equipo · medskin_create_team_member()
--
-- El alta de recepción o de asistente clínico, y es el mismo acto que el alta de la dueña
-- (`medskin_create_practice_owner`): cuenta + credencial temporal + fila de `practitioner`,
-- en una transacción. De ahí que se parezca línea por línea.
--
-- EL `practice_id` SALE DEL CONTEXTO Y LA AUTORIZACIÓN ES SER LA DUEÑA, comprobada aquí y
-- no en el controlador: `practice.owner_account_id = medskin_current_account()`. Es la
-- misma comprobación que `medskin_license_to_review`, y por el mismo motivo —«solo la dueña
-- da de alta al equipo»—.
--
-- `p_role` SE VALIDA CONTRA DOS VALORES, no contra los tres del `CHECK` de la tabla: un
-- cuerpo con `rol: "doctora"` es `400 rol_no_asignable` y tiene que fallar aquí también.
-- `account.role` lo pone la función y vale `practitioner`: «una recepcionista es
-- `practitioner` igual que la dueña, las dos entran por la misma puerta»
-- (_convenciones.md). Y `permissions` nace NULO: «los de su rol» (decisión 11), que es lo
-- que tendrá el 100 % de las filas de la primera entrega.
--
-- UN CORREO QUE YA TIENE CUENTA NO SE REUSA, y es lo contrario de lo que hace el alta de
-- paciente. Allí reusar es correcto: la cuenta es de la persona y `patient_link` une N
-- fichas a una cuenta. Aquí no hay tabla que una: una cuenta tiene UN `account.role`, así
-- que convertir en recepcionista la cuenta de una paciente de otra clínica —o de una
-- doctora— le cambiaría el rol de autenticación por debajo. El veredicto es uno solo,
-- `email_taken`, tanto si la persona ya está en este equipo como si su cuenta vive en otra
-- consulta: DOS VEREDICTOS SERÍAN EL ORÁCULO que §12.2.1 cierra, y la dueña no tiene por
-- qué saber que ese correo tiene cuenta en otra clínica. El endpoint lo traduce al único
-- `409` que el contrato define, `correo_ya_en_el_equipo`.
--
-- LA IDEMPOTENCIA POR CABECERA NO NECESITA NADA NUEVO: `idempotency_key` existe desde la
-- 0000 con su política por consulta y su `GRANT SELECT, INSERT, UPDATE, DELETE` para
-- `app_practitioner`, y su clave primaria es `(account_id, key)`. Y la función es segura
-- ante un reintento sin cabecera igual: el segundo intento con el mismo correo encuentra la
-- cuenta y devuelve `email_taken` en vez de crear una segunda.
-- =======================================================================================
CREATE FUNCTION medskin_create_team_member(p_email citext, p_first_name text,
                                           p_last_name text, p_role text,
                                           p_hash text, p_expires_at timestamptz)
RETURNS TABLE (verdict text, account_id uuid, practitioner_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_practice uuid := medskin_current_practice();
  v_caller uuid := medskin_current_account();
  v_owner uuid;
  v_region text;
  v_account uuid;
  v_practitioner uuid;
BEGIN
  IF v_practice IS NULL OR v_caller IS NULL THEN
    RAISE EXCEPTION 'medskin_create_team_member: sin contexto de consulta o de cuenta'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_email IS NULL OR btrim(p_email::text) = ''
     OR p_first_name IS NULL OR btrim(p_first_name) = ''
     OR p_last_name IS NULL OR btrim(p_last_name) = '' THEN
    RAISE EXCEPTION 'medskin_create_team_member: faltan correo, nombre o apellido'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_hash IS NULL OR p_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'medskin_create_team_member: la temporal no viene hasheada con Argon2id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- 72 h, la misma cota que el alta de paciente y la de la dueña.
  IF p_expires_at IS NULL OR p_expires_at <= now()
     OR p_expires_at > now() + interval '73 hours' THEN
    RAISE EXCEPTION 'medskin_create_team_member: la temporal vive 72 h'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- `400 rol_no_asignable`: ni `doctora`, ni `duena`, ni `paciente`. Y se comprueba ANTES
  -- de mirar el correo, para que un cuerpo mal formado no revele nada del padrón.
  IF p_role IS NULL OR p_role NOT IN ('recepcion', 'asistente_clinico') THEN
    RETURN QUERY SELECT 'role_not_assignable', NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  SELECT pc.owner_account_id, pc.region INTO v_owner, v_region
    FROM practice pc WHERE pc.id = v_practice;
  IF v_region IS NULL THEN
    RAISE EXCEPTION 'medskin_create_team_member: la consulta del contexto no existe'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_owner IS NULL OR v_owner <> v_caller THEN
    RETURN QUERY SELECT 'not_owner', NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  -- Un solo veredicto, exista la cuenta en este equipo o en cualquier otro sitio.
  SELECT a.id INTO v_account FROM account a WHERE a.email = p_email;
  IF v_account IS NOT NULL THEN
    RETURN QUERY SELECT 'email_taken', NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  INSERT INTO account (email, role, region, first_name, last_name)
  VALUES (p_email, 'practitioner', v_region, btrim(p_first_name), btrim(p_last_name))
  RETURNING account.id INTO v_account;

  INSERT INTO credential (account_id, hash, is_temporary, temp_expires_at)
  VALUES (v_account, p_hash, true, p_expires_at);

  INSERT INTO practitioner (practice_id, account_id, first_name, last_name, role)
  VALUES (v_practice, v_account, btrim(p_first_name), btrim(p_last_name), p_role)
  RETURNING practitioner.id INTO v_practitioner;

  RETURN QUERY SELECT 'created', v_account, v_practitioner;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_create_team_member(citext, text, text, text, text, timestamptz)
  OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_create_team_member(citext, text, text, text, text, timestamptz)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_create_team_member(citext, text, text, text, text, timestamptz)
  TO app_practitioner;--> statement-breakpoint

-- =======================================================================================
-- 4 · POST /v1/plataforma/cuentas/{cuenta_id}/acceso/reenviar
--     medskin_platform_resend_access()
--
-- «Reenviar la contraseña temporal · Va a su propio correo. Soporte no la ve.» Y eso es
-- literal en el contrato: la respuesta es `{ enviado_en, caduca_en }` y NO lleva
-- `contrasena_temporal`. Esta función es lo que lo hace verdad en la base y no en el
-- controlador: **no devuelve ni el hash ni el correo ni la contraseña**, solo el veredicto
-- y la fecha de caducidad. El correo al que se escribe lo saca el endpoint de
-- `account.email`, que `app_platform` ya lee por columna desde la 0000.
--
-- ESTA SÍ RECIBE `p_account_id`, al contrario que la del alta de paciente, y es correcto
-- aquí por el motivo exacto por el que allí no lo era: `app_platform` ya tiene
-- `GRANT SELECT (id, email, role, status, locked_until)` sobre TODAS las filas de `account`
-- con su política `current_user = 'app_platform'`. El argumento no le da alcance que no
-- tuviera; lo que le da es la capacidad de acuñar una temporal sin ver `credential`, que es
-- justo lo que la pantalla promete.
--
-- Y LO QUE NO PUEDE HACER: reenviar a quien ya eligió su contraseña. `409
-- ya_eligio_su_contrasena` no es una cortesía, es el mismo límite que tiene la doctora en
-- `medskin_resend_patient_access` y por la misma razón —si soporte pudiera resetear una
-- contraseña elegida, soporte sería dueño del acceso a la cuenta de una persona adulta—.
-- Tampoco alcanza una cuenta borrada: para ella es `cuenta_no_existe`, igual que un
-- `cuenta_id` inventado.
--
-- `current_user` DENTRO DE UNA `SECURITY DEFINER` ES `medskin_access`, no quien llama, así
-- que el portero no es un predicado del cuerpo: es el `GRANT EXECUTE` a `app_platform` y
-- nadie más, contra un `medskin` que es NOINHERIT y tiene que adoptar el rol para usarlo.
-- Es el mismo portero de las once funciones de la 0002.
--
-- La fila de la bitácora la escribe el endpoint, que es quien sabe qué operador de la
-- consola la pidió: la identidad de la plataforma vive fuera de la región y no hay fila de
-- `account` que nombrar aquí («Las dos quedan en `audit_log` con quién las ejecutó»).
-- =======================================================================================
CREATE FUNCTION medskin_platform_resend_access(p_account_id uuid, p_hash text,
                                               p_expires_at timestamptz)
RETURNS TABLE (outcome text, expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_deleted timestamptz;
  v_credential uuid;
  v_chosen boolean;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'medskin_platform_resend_access: falta la cuenta'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_hash IS NULL OR p_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'medskin_platform_resend_access: la temporal no viene hasheada con Argon2id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now()
     OR p_expires_at > now() + interval '73 hours' THEN
    RAISE EXCEPTION 'medskin_platform_resend_access: la temporal vive 72 h'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.deleted_at INTO v_deleted FROM account a WHERE a.id = p_account_id FOR UPDATE;
  IF NOT FOUND OR v_deleted IS NOT NULL THEN
    RETURN QUERY SELECT 'cuenta_no_existe', NULL::timestamptz;
    RETURN;
  END IF;

  SELECT c.id, (c.is_temporary = false OR c.temp_used_at IS NOT NULL)
    INTO v_credential, v_chosen
    FROM credential c WHERE c.account_id = p_account_id FOR UPDATE;

  IF coalesce(v_chosen, false) THEN
    RETURN QUERY SELECT 'ya_eligio_su_contrasena', NULL::timestamptz;
    RETURN;
  END IF;

  IF v_credential IS NULL THEN
    INSERT INTO credential (account_id, hash, is_temporary, temp_expires_at)
    VALUES (p_account_id, p_hash, true, p_expires_at);
  ELSE
    -- La anterior muere aquí, igual que en el reenvío de la doctora, y
    -- `temp_first_used_at` vuelve a nulo porque esta temporal es otra y no se ha estrenado.
    UPDATE credential
       SET hash = p_hash, is_temporary = true, temp_expires_at = p_expires_at,
           temp_first_used_at = NULL, updated_at = now()
     WHERE id = v_credential;
  END IF;

  RETURN QUERY SELECT 'acceso_renovado', p_expires_at;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_platform_resend_access(uuid, text, timestamptz)
  OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_platform_resend_access(uuid, text, timestamptz)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_platform_resend_access(uuid, text, timestamptz)
  TO app_platform;
