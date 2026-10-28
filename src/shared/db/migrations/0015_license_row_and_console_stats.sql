-- Tramo 1 · `inquilinos.md`, los cinco endpoints. Lo que les faltaba a la base, y no es
-- mucho: con la 0000-0014 delante, TRES de los cinco ya eran servibles sin tocar nada.
--
-- Escrita a mano: nada de esto lo expresa drizzle-kit. NO TRAE NI UNA TABLA NI UNA COLUMNA
-- NUEVA, así que no hay `FORCE ROW LEVEL SECURITY` que añadir ni índice con el inquilino
-- delante que crear: las tres tablas del recurso —`practice`, `license`, `practitioner`—
-- vienen de la 0000 con sus políticas forzadas, y sus índices ya empiezan por el inquilino
-- (`license_practice_uq (practice_id)`, `patient_practice_status_idx (practice_id, status,
-- created_at DESC)`, `session_practice_idx (practice_id, last_seen_at DESC)`).
--
-- §3.4, regla 7 · §1.5 del napkin: versionada, y NUNCA editada después de aplicarse.
--
-- =======================================================================================
-- LO QUE SE COMPROBÓ CONTRA EL CATÁLOGO, ENDPOINT POR ENDPOINT (28 oct 2026, PG 17.11)
--
--   POST /v1/plataforma/inquilinos        · `app_platform` tiene `arwd` sobre `practice` y
--     su política (`current_user = 'app_platform'`) cubre el `INSERT`. La dueña la crea
--     `medskin_create_practice_owner(...)`, que ya existe y ya está concedida. FALTABA la
--     fila de `license`: ver abajo, y es lo único.
--   GET  /v1/inquilinos/mio               · servible tal cual. `practice` por `id`
--     (política sobre `id`), `license` por `practice_id` (`license_practice_uq`), el
--     recuento de fichas por `patient_practice_status_idx`, y `first_day_*` ya son
--     columnas de `practice` desde la 0000. No se tocó nada.
--   POST /v1/inquilinos/mio/licencia      · servible tal cual. La doctora hace `UPDATE` de
--     las cuatro columnas del formulario (grants por columna de la 0002, política que solo
--     deja mientras el estado es `sin_enviar` o `rechazada`) y después llama a
--     `medskin_license_to_review(...)`, que valida la transición, exige ser la dueña y
--     deja su fila en `access_audit`. No se tocó nada.
--   GET  /v1/plataforma/inquilinos/{id}   · casi servible. Faltaban DOS datos que el
--     contrato promete y que la consola no alcanza: `plan.pacientes` y `versiones_app`.
--     Los resuelve `medskin_platform_practice_stats(...)`, abajo.
--   POST /v1/plataforma/inquilinos/{id}/licencia/decision · servible tal cual, y esto se
--     midió antes de escribir una función que habría sobrado: ver el bloque siguiente.
--
-- =======================================================================================
-- POR QUÉ LA DECISIÓN DE LA LICENCIA **NO** LLEVA FUNCIÓN, Y LA DE LA DOCTORA SÍ
--
-- `medskin_license_to_review(...)` existe porque la doctora NO tiene el `UPDATE` de
-- `license.status` —ese grant de columna es de `medskin_access` y de nadie más—, así que
-- sin función no hay forma de mover el estado desde su rol. La consola es el caso
-- contrario: `app_platform` ya tiene `UPDATE` de tabla entera sobre `license` desde la
-- 0000 y su política lo admite. Medido el 28 oct con `SET LOCAL ROLE app_platform` y
-- contexto de verdad: el `UPDATE ... WHERE practice_id = $1 AND status = 'en_revision'`
-- devuelve la fila, y el `INSERT` en `access_audit` entra. Una función `SECURITY DEFINER`
-- aquí no cerraría ninguna frontera que las políticas no cierren ya: sería una capa que
-- hay que leer para entender un `UPDATE`.
--
-- Lo que la consola escribe, en UNA transacción (para `backend-senior`, parametrizado):
--
--   SELECT status FROM license WHERE practice_id = $1 FOR UPDATE;
--     -- sin fila        -> 404 `licencia_no_existe`
--     -- <> 'en_revision'-> 409 `licencia_ya_decidida` (y 404 si el contrato prefiere eso
--     --                    cuando está en `sin_enviar`: es decisión de producto, no de la
--     --                    base; la base distingue los dos casos)
--   UPDATE license SET status = $2, decided_at = now(), rejection_reason = $3,
--          reviewed_by = $4, updated_at = now()
--    WHERE practice_id = $1 AND status = 'en_revision' RETURNING status, decided_at;
--   INSERT INTO access_audit (practice_id, actor_account_id, actor_label, action,
--                             subject_type, subject_id, data, region) VALUES (...);
--
-- El `WHERE ... AND status = 'en_revision'` ES la validación de la transición, y el
-- `CHECK license_rejection_reason_ck` de la 0000 ya obliga a que un rechazo traiga motivo
-- de 10 a 300 caracteres: un `motivo_rechazo` vacío revienta en la base, no solo en el
-- controlador. `license.reviewed_by` no tiene clave foránea a `account` a propósito: la
-- persona de la plataforma no tiene fila en `account` (`plataforma-acceso.md`).
--
-- =======================================================================================
-- 1 · LA FILA DE `license` NACE CON LA CONSULTA
--
-- El hueco era silencioso, que es la peor clase. La doctora puede hacer `UPDATE` de su
-- licencia pero NO tiene `INSERT` sobre `license` —no lo tiene ni lo va a tener: una
-- consulta tiene una licencia y una sola, y quién la crea no es negociable—, así que una
-- consulta dada de alta sin su fila deja a su dueña sin poder enviar nada: su `UPDATE`
-- toca cero filas, no falla, y `medskin_license_to_review` responde `no_license`, que no
-- es ninguno de los errores del contrato. El alta pasa, la pantalla miente y nadie se
-- entera hasta que la doctora llama.
--
-- Se arregla donde está el acto, no en el controlador: `medskin_create_practice_owner`
-- ya crea la cuenta, la credencial temporal, la fila de `practitioner` y el vínculo
-- `practice.owner_account_id` en una transacción. La licencia en `sin_enviar` es la quinta
-- pieza del MISMO acto («Una consulta sin dueña no existe», `inquilinos.md`), y así
-- `backend-senior` no tiene que acordarse de nada.
--
-- NO se hizo con un disparador en `practice`, que era la otra opción obvia: insertaría la
-- fila ANTES de que la siembra de las pruebas y de `seed.ts` inserten la suya con su `id`
-- fijo, y ese `INSERT` moriría contra `license_practice_uq`. Un disparador que obliga a
-- reescribir la siembra de tres archivos ajenos para añadir una fila por omisión no es una
-- fila por omisión: es un acoplamiento.
--
-- `medskin_access` necesita el `INSERT` de la columna, y solo de esa: el estado sale del
-- `DEFAULT 'sin_enviar'` y los demás campos los llena la doctora con sus propios grants.
GRANT INSERT (practice_id) ON "license" TO medskin_access;--> statement-breakpoint

-- Las consultas que ya existían se quedan con su invariante cumplida. Una sola vez, y es
-- idempotente: si ya tienen fila, no hace nada.
INSERT INTO license (practice_id)
SELECT p.id FROM practice p
 WHERE NOT EXISTS (SELECT 1 FROM license l WHERE l.practice_id = p.id);--> statement-breakpoint

-- `CREATE OR REPLACE` y no un `ALTER` de la 0002, que ya se aplicó y no se toca. El cuerpo
-- va entero porque es como se versiona una función: lo único que cambia respecto de la
-- 0002 es el `INSERT INTO license`, marcado abajo.
CREATE OR REPLACE FUNCTION medskin_create_practice_owner(
  p_practice_id uuid,
  p_email citext,
  p_first_name text,
  p_last_name text,
  p_hash text,
  p_expires_at timestamptz
) RETURNS TABLE (verdict text, account_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_region text;
  v_owner uuid;
  v_account uuid;
BEGIN
  IF p_practice_id IS NULL OR p_email IS NULL OR btrim(p_email::text) = ''
     OR p_first_name IS NULL OR btrim(p_first_name) = ''
     OR p_last_name IS NULL OR btrim(p_last_name) = '' THEN
    RAISE EXCEPTION 'medskin_create_practice_owner: argumentos incompletos'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_hash IS NULL OR p_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'medskin_create_practice_owner: la temporal no viene hasheada con Argon2id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now()
     OR p_expires_at > now() + interval '73 hours' THEN
    RAISE EXCEPTION 'medskin_create_practice_owner: la temporal vive 72 h'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT p.region, p.owner_account_id INTO v_region, v_owner
    FROM practice p WHERE p.id = p_practice_id FOR UPDATE;
  IF v_region IS NULL THEN
    RETURN QUERY SELECT 'practice_not_found', NULL::uuid;
    RETURN;
  END IF;
  -- Refuerzo de la clave natural `(correo_doctora, region)`: un reintento no pone una
  -- segunda dueña.
  IF v_owner IS NOT NULL THEN
    RETURN QUERY SELECT 'practice_has_owner', v_owner;
    RETURN;
  END IF;

  SELECT a.id INTO v_account FROM account a WHERE a.email = p_email;
  IF v_account IS NOT NULL THEN
    RETURN QUERY SELECT 'email_taken', v_account;
    RETURN;
  END IF;

  INSERT INTO account (email, role, region, first_name, last_name)
  VALUES (p_email, 'practitioner', v_region, btrim(p_first_name), btrim(p_last_name))
  RETURNING account.id INTO v_account;

  INSERT INTO credential (account_id, hash, is_temporary, temp_expires_at)
  VALUES (v_account, p_hash, true, p_expires_at);

  -- `permissions` nulo: los de su rol (decisión 11).
  INSERT INTO practitioner (practice_id, account_id, first_name, last_name, role)
  VALUES (p_practice_id, v_account, btrim(p_first_name), btrim(p_last_name), 'doctora');

  UPDATE practice p SET owner_account_id = v_account, updated_at = now()
   WHERE p.id = p_practice_id;

  -- LO ÚNICO NUEVO DE LA 0015. `sin_enviar` sale del `DEFAULT`, que es lo que el 201 del
  -- contrato promete. `ON CONFLICT` y no un `IF NOT EXISTS` porque la siembra de las
  -- pruebas y de `seed.ts` crea su propia fila con `id` fijo: el que llegue primero gana y
  -- el segundo no revienta.
  INSERT INTO license (practice_id) VALUES (p_practice_id)
  ON CONFLICT (practice_id) DO NOTHING;

  RETURN QUERY SELECT 'created', v_account;
END
$$;--> statement-breakpoint

ALTER FUNCTION medskin_create_practice_owner(uuid, citext, text, text, text, timestamptz)
  OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_create_practice_owner(uuid, citext, text, text, text, timestamptz)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_create_practice_owner(uuid, citext, text, text, text, timestamptz)
  TO app_platform;--> statement-breakpoint

-- =======================================================================================
-- 2 · LOS DOS DATOS DE LA FICHA DE LA CONSOLA QUE `app_platform` NO ALCANZA
--
-- `GET /v1/plataforma/inquilinos/{id}` promete `plan.pacientes` y `versiones_app`, y
-- medido el 28 oct con el rol de verdad:
--
--   · `SELECT count(*) FROM patient WHERE practice_id = $1` -> **permission denied for
--     table patient**. Y así se queda: la garantía del contrato no es un filtro del
--     controlador, es que `app_platform` no tiene ni un grant ni una política sobre
--     `patient`, `medical_history`, `session_note`, `photo` ni `message`. Concederle
--     `SELECT (practice_id)` y una política de `SELECT` para poder contar abriría la tabla
--     entera a `COUNT(*) FILTER (...)` y a cualquier `WHERE` futuro. No se abre.
--   · `session.practice_id` -> **permission denied**. La 0003 le concedió CINCO columnas de
--     `session` y ninguna más (`account_id`, `revoked_at`, `app_version`, `platform`,
--     `last_seen_at`), y hay una prueba que falla si aparece una sexta. Así que por su rol
--     la consola solo puede agrupar sesiones por cuenta, y las cuentas de una consulta
--     salen de `practitioner`, que tampoco alcanza (pregunta 5 del acta: la consola conoce
--     el vínculo por `practice.owner_account_id`, no por `practitioner`). Las versiones de
--     la consulta, con eso, serían las de la dueña y no las del equipo.
--
-- Los dos se resuelven con UNA función que devuelve TRES números y ni una fila. Es la
-- diferencia que define `Consola.dc.html`: «cuántas fotos en cola, no qué foto». Lo que
-- sale de aquí no se puede volver a preguntar de otra forma —no hay `WHERE` que pasarle
-- más que el inquilino— y no hay por dónde sacarle un nombre, un correo ni una fecha de
-- nacimiento.
--
-- `STABLE` y no `VOLATILE`: solo lee (§1.8, decisión 16, al revés). `STRICT`: con el
-- inquilino nulo devuelve cero filas en vez de inventar un cero, que es la validación de
-- argumento más corta que existe. De `medskin_access` y no de `medskin_owner`, que es
-- superusuario (§1.9): un `SECURITY DEFINER` del dueño se saltaría RLS en TODAS las tablas
-- y no solo en la que necesita. `search_path` fijado.
--
-- No se le compara `current_user` dentro, y es deliberado: la frontera es el `GRANT
-- EXECUTE`, que va por OID y sobrevive a un `ALTER ROLE ... RENAME`. Las políticas de la
-- consola sí comparan la CADENA `'app_platform'` (§5.3 del napkin) y es una bomba de
-- relojería conocida: renombrar el rol conserva los grants y deja las políticas sin dar
-- acceso para siempre y sin un solo error. Esta función no añade un literal más a esa
-- cuenta. **Si se renombra un rol, hay que recrear las políticas en la misma migración.**
GRANT SELECT (status) ON "patient" TO medskin_access;--> statement-breakpoint

CREATE OR REPLACE FUNCTION medskin_platform_practice_stats(p_practice_id uuid)
RETURNS TABLE (patient_count bigint, app_version_ios text, app_version_android text)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  -- Las fichas archivadas NO cuentan contra el límite del plan: archivar libera un cupo,
  -- o archivar no sirve de nada para una consulta que llegó a su tope. Es la MISMA regla
  -- que tiene que usar `GET /v1/inquilinos/mio`, que cuenta por su cuenta con el mismo
  -- índice. Levantada como pregunta de producto: ningún contrato lo dice.
  SELECT
    (SELECT count(*) FROM patient p
      WHERE p.practice_id = p_practice_id AND p.status = 'activa'),
    -- La versión que la consulta está corriendo HOY en cada plataforma: la de la sesión
    -- viva vista más recientemente. `ORDER BY ... DESC` es `DESC NULLS FIRST`, que es
    -- exactamente el orden de `session_practice_idx (practice_id, last_seen_at DESC)`
    -- (§1.13 del napkin: con `NULLS LAST` el índice no sirve para el `ORDER BY`).
    (SELECT s.app_version FROM session s
      WHERE s.practice_id = p_practice_id AND s.platform = 'ios' AND s.revoked_at IS NULL
      ORDER BY s.last_seen_at DESC LIMIT 1),
    (SELECT s.app_version FROM session s
      WHERE s.practice_id = p_practice_id AND s.platform = 'android' AND s.revoked_at IS NULL
      ORDER BY s.last_seen_at DESC LIMIT 1)
$$;--> statement-breakpoint

ALTER FUNCTION medskin_platform_practice_stats(uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_platform_practice_stats(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_platform_practice_stats(uuid) TO app_platform;--> statement-breakpoint

-- =======================================================================================
-- LO QUE NO SE TOCÓ, DICHO A PROPÓSITO
--
-- `license_review_queue_idx (status, submitted_at)` se queda como está. Ninguno de los
-- cinco endpoints ejecuta su consulta: la ficha de la consola entra por `practice.id`
-- (clave primaria) y la licencia por `license_practice_uq (practice_id)`. El índice sirve
-- a la LISTA de la cola de revisión, que es la pantalla que sigue y que todavía no tiene
-- contrato escrito (`plataforma-acceso.md` solo declara el permiso
-- `plataforma:licencias:decidir`). Su excepción a la regla 5 sigue siendo la medida del
-- README y del napkin §1.14, y esta migración no añade ninguna excepción nueva: no crea un
-- solo índice.
--
-- Tampoco se creó índice para el borrado de la credencial a los 90 días de la decisión
-- (`inquilinos.md`, reglas de negocio). Ese barrido es un trabajo de cola que todavía no
-- existe, no tiene puerto de archivos hasta el tramo 6, y un índice sobre `decided_at`
-- para cero filas y ningún lector es un índice que nadie midió.
