-- Tramo 1 · el delta que hace implementables los endpoints del acceso.
-- Escrita a mano: nada de esto lo expresa drizzle-kit (roles, RLS, políticas, grants por
-- columna y funciones `SECURITY DEFINER`). Las tablas y columnas nuevas sí salen del
-- esquema de drizzle, y van en la sección 1.
--
-- Implementa las decisiones 1, 2, 4, 5, 11 y 12 de docs/contratos/preguntas-abiertas.md
-- («Resueltas · 27 de octubre de 2026»). No reabre ninguna.
--
-- Identificadores en inglés (norma del 27 de octubre). Los VALORES siguen en español
-- donde el contrato los fija: `status = 'activa'`, `role = 'doctora'`,
-- `scope = 'contrasena_temporal'`, `voided_reason = 'intentos'`. Son formato de API, que
-- es lo que la app de iOS ya consume, no identificadores de base.
--
-- §3.4, regla 7: versionada, y NUNCA editada después de aplicarse.

-- =======================================================================================
-- 1 · TABLAS Y COLUMNAS NUEVAS
-- =======================================================================================

-- El señuelo del acceso: UNA fila con un hash de Argon2id de una contraseña aleatoria que
-- nadie conoce. Ver el comentario del esquema.
CREATE TABLE "access_decoy" (
	"only_row" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_decoy_only_row_ck" CHECK ("access_decoy"."only_row")
);--> statement-breakpoint

-- Decisión 5: el vínculo consulta↔dueña vive en `practice`, que ya es tabla de
-- plataforma, en vez de abrirle `practitioner` a la consola.
ALTER TABLE "practice" ADD COLUMN "owner_account_id" uuid;--> statement-breakpoint
ALTER TABLE "practice" ADD CONSTRAINT "practice_owner_account_id_account_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "practice_owner_account_idx" ON "practice" USING btree ("owner_account_id") WHERE owner_account_id is not null;--> statement-breakpoint

-- LAS DOS MARCAS DE LA CONTRASEÑA TEMPORAL, y hacen falta las dos.
--
-- La decisión 2 del 27 de octubre mueve el consumo de la temporal al momento de GUARDAR
-- la definitiva, así que `temp_used_at` ya no responde «¿entró alguna vez con la
-- temporal?». Y esa es justo la pregunta que `recuperacion.md` necesita: «quien no probó
-- nunca que tiene el correo no puede usar el correo para entrar».
--
-- Con una sola columna, la paciente que entra con la temporal y se le cierra la app en la
-- pantalla de contraseña nueva se queda sin las dos salidas a la vez: no puede recuperar
-- (parecería que nunca estrenó) y el 202 de recuperación es idéntico siempre, así que
-- nunca sabría por qué no le llega el código. Dos columnas:
--
--   `temp_first_used_at` → la PRIMERA entrada con la temporal. La marca
--                          `medskin_access_attempt(..., true)`, y es la que mira la regla
--                          de la recuperación.
--   `temp_used_at`       → el CONSUMO, al guardar la definitiva (decisión 2).
--
-- Hacerlo hoy es una columna; hacerlo con pacientes dentro es una migración de datos que
-- no se puede reconstruir, porque el dato que haría falta —si entró— no se guardó nunca.
ALTER TABLE "credential" ADD COLUMN "temp_first_used_at" timestamp with time zone;--> statement-breakpoint

-- Decisión 11: nulo = «los de su rol», y es lo que tendrá el 100 % de las filas hoy.
ALTER TABLE "practitioner" ADD COLUMN "permissions" text[];--> statement-breakpoint
ALTER TABLE "practitioner" ADD CONSTRAINT "practitioner_permissions_ck" CHECK ("practitioner"."permissions" is null or array_length("practitioner"."permissions", 1) > 0);--> statement-breakpoint

-- Decisión 12 · los tres `role` de `practitioner`. El dato existente se mueve ANTES de
-- cambiar la restricción, y en este orden a propósito: `owner_account_id` se rellena
-- mientras `duena` todavía significa algo.
UPDATE "practice" p
   SET "owner_account_id" = (
     SELECT pr."account_id" FROM "practitioner" pr
      WHERE pr."practice_id" = p."id" AND pr."role" = 'duena' AND pr."status" = 'activa'
      ORDER BY pr."created_at" LIMIT 1)
 WHERE p."owner_account_id" IS NULL;--> statement-breakpoint
ALTER TABLE "practitioner" DROP CONSTRAINT "practitioner_role_ck";--> statement-breakpoint
UPDATE "practitioner" SET "role" = 'doctora' WHERE "role" = 'duena';--> statement-breakpoint
UPDATE "practitioner" SET "role" = 'asistente_clinico' WHERE "role" = 'clinico';--> statement-breakpoint
ALTER TABLE "practitioner" ADD CONSTRAINT "practitioner_role_ck" CHECK ("practitioner"."role" in ('doctora', 'recepcion', 'asistente_clinico'));--> statement-breakpoint

-- =======================================================================================
-- 2 · app_anonymous · EL ROL DE LAS PETICIONES SIN SESIÓN
--
-- Decisión 1. `POST /v1/acceso`, los dos de recuperación y `POST /v1/sesion/refresco`
-- llegan sin `practice_id` y sin `account_id`, así que no puede haber política que los
-- lea. Su ÚNICO privilegio es `EXECUTE` sobre las funciones de la sección 4: ni un SELECT,
-- ni un INSERT, ni un GRANT de tabla. Con él no se puede enumerar correos ni por error de
-- programación, porque no hay consulta que escribir.
-- =======================================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_anonymous') THEN
    CREATE ROLE app_anonymous;
  END IF;
  ALTER ROLE app_anonymous NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
END
$$;--> statement-breakpoint
GRANT app_anonymous TO medskin;--> statement-breakpoint
-- USAGE sobre el esquema es lo mínimo para poder nombrar una función. No da acceso a
-- ninguna tabla: eso son los grants de tabla, y no tiene ni uno.
GRANT USAGE ON SCHEMA public TO app_anonymous;--> statement-breakpoint

-- =======================================================================================
-- 3 · medskin_access · EL DUEÑO DE LAS FUNCIONES, Y POR QUÉ NO ES medskin_owner
--
-- `SECURITY DEFINER` ejecuta con los privilegios del DUEÑO de la función. `medskin_owner`
-- es superusuario (es quien crea la base y migra), así que una función suya ejecutaría
-- como superusuario: saltaría RLS, sí, pero también podría escribir cualquier tabla y
-- borrar el esquema. Una función alcanzable desde un endpoint SIN SESIÓN corriendo como
-- superusuario es la regla 1 de §7.3 incumplida con otro sombrero.
--
-- Así que las funciones las posee `medskin_access`: NOLOGIN, NOSUPERUSER, NOBYPASSRLS, y
-- concedido a NADIE —ni a `medskin`—, de modo que no hay forma de adoptarlo. Tiene
-- exactamente los grants por columna que sus funciones necesitan y sus propias políticas.
-- Sí, sus políticas no filtran filas: el filtro es el cuerpo de la función, y la frontera
-- de confianza es su firma (_convenciones.md · «Cuatro roles de base»). La diferencia con
-- el superusuario no es teórica: un fallo dentro de una función llega, como máximo, a las
-- columnas de esta sección.
--
-- RLS sí se le aplica (no es dueño de las tablas y no tiene BYPASSRLS), así que sin las
-- políticas de esta sección sus funciones no leerían ni una fila. Falla cerrada.
-- =======================================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medskin_access') THEN
    CREATE ROLE medskin_access;
  END IF;
  ALTER ROLE medskin_access NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO medskin_access;--> statement-breakpoint
-- `CREATE` es temporal y se retira al final de esta migración: lo exige
-- `ALTER FUNCTION ... OWNER TO`, que pide que el dueño nuevo pueda crear en el esquema.
-- La propiedad se queda; el privilegio, no.
GRANT CREATE ON SCHEMA public TO medskin_access;--> statement-breakpoint

ALTER TABLE "access_decoy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "access_decoy" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY access_decoy_access ON "access_decoy" FOR SELECT TO medskin_access
  USING (current_user = 'medskin_access');--> statement-breakpoint
GRANT SELECT ON "access_decoy" TO medskin_access;--> statement-breakpoint
-- Y ni un grant para app_practitioner, app_patient, app_platform ni app_anonymous: el
-- señuelo es la mitad de la promesa de «mismo tiempo», y lo que no se lee no se compara.

CREATE POLICY account_access ON "account" FOR ALL TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint
GRANT SELECT (id, email, role, region, first_name, last_name, phone, status, locked_until,
              failed_attempts, deleted_at, created_at)
  ON "account" TO medskin_access;--> statement-breakpoint
GRANT INSERT (email, role, region, first_name, last_name, phone) ON "account" TO medskin_access;--> statement-breakpoint
-- La pausa del acceso y su contador, y nada más: la función del acceso no cambia correos
-- ni suspende cuentas.
GRANT UPDATE (failed_attempts, locked_until, updated_at) ON "account" TO medskin_access;--> statement-breakpoint

CREATE POLICY credential_access ON "credential" FOR ALL TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint
-- Aquí sí hay SELECT del hash, y es el único de toda la base: es lo que devuelve al
-- verificado de Argon2id de Node. Ningún rol de aplicación lo tiene.
GRANT SELECT ON "credential" TO medskin_access;--> statement-breakpoint
GRANT INSERT (account_id, hash, is_temporary, temp_expires_at, set_at)
  ON "credential" TO medskin_access;--> statement-breakpoint
GRANT UPDATE (hash, is_temporary, temp_expires_at, temp_first_used_at, temp_used_at,
              set_at, updated_at)
  ON "credential" TO medskin_access;--> statement-breakpoint

CREATE POLICY recovery_code_access ON "recovery_code" FOR ALL TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint
GRANT SELECT ON "recovery_code" TO medskin_access;--> statement-breakpoint
GRANT INSERT (account_id, code_hash, expires_at) ON "recovery_code" TO medskin_access;--> statement-breakpoint
GRANT UPDATE (attempts, used_at, voided_at, voided_reason) ON "recovery_code" TO medskin_access;--> statement-breakpoint

CREATE POLICY session_access ON "session" FOR ALL TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint
GRANT SELECT ON "session" TO medskin_access;--> statement-breakpoint
-- Rota el refresco y revoca. NO crea sesiones: una sesión se crea cuando ya se sabe quién
-- entra, y entonces la escribe `app_practitioner` o `app_patient` bajo su propia política.
GRANT UPDATE (refresh_hash, previous_refresh_hash, refresh_expires_at, refresh_rotated_at,
              revoked_at, revoked_reason, last_seen_at)
  ON "session" TO medskin_access;--> statement-breakpoint

CREATE POLICY practitioner_access ON "practitioner" FOR ALL TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint
GRANT SELECT ON "practitioner" TO medskin_access;--> statement-breakpoint
GRANT INSERT (practice_id, account_id, first_name, last_name, role, permissions)
  ON "practitioner" TO medskin_access;--> statement-breakpoint

CREATE POLICY practice_access ON "practice" FOR ALL TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint
GRANT SELECT ON "practice" TO medskin_access;--> statement-breakpoint
GRANT UPDATE (owner_account_id, updated_at) ON "practice" TO medskin_access;--> statement-breakpoint

CREATE POLICY license_access ON "license" FOR ALL TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint
GRANT SELECT ON "license" TO medskin_access;--> statement-breakpoint
-- Decisión 4: el salto de estado es de la función, no de un grant a la doctora.
GRANT UPDATE (status, submitted_at, response_estimated_at, decided_at, rejection_reason,
              updated_at) ON "license" TO medskin_access;--> statement-breakpoint

CREATE POLICY access_audit_access ON "access_audit" FOR INSERT TO medskin_access
  WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint
GRANT INSERT ON "access_audit" TO medskin_access;--> statement-breakpoint
GRANT USAGE ON SEQUENCE "access_audit_id_seq" TO medskin_access;--> statement-breakpoint
-- Y ni SELECT, ni UPDATE, ni DELETE sobre la bitácora: escribe y no vuelve a mirar.

-- =======================================================================================
-- 4 · LAS FUNCIONES DEL ACCESO
--
-- Cada una: `SECURITY DEFINER`, `search_path` FIJADO (sin eso, un esquema en el camino de
-- búsqueda de quien llama cambia a qué tabla apunta `account`), argumentos validados, y
-- devuelve el VEREDICTO MÍNIMO: nunca la fila.
--
-- Los parámetros de correo se declaran `citext`, no `text`, Y ESO NO ES COSMÉTICO: con un
-- parámetro `text` la comparación contra una columna `citext` se resuelve por el operador
-- `text = text` y pasa a ser SENSIBLE A MAYÚSCULAS. Medido: `'A@b.com'::text` no encuentra
-- la fila que `'A@b.com'::citext` sí encuentra. Es exactamente el error que el tipo citext
-- existe para evitar, y desde una función se cuela sin que nada avise.
--
-- PostgreSQL concede `EXECUTE` a `PUBLIC` por defecto en toda función nueva. Si no se
-- revocara, `app_practitioner` podría llamar a la función del acceso y enumerar correos:
-- el agujero exacto que `app_anonymous` existe para cerrar. Se revoca por defecto y
-- además función por función, y se concede solo al rol que la necesita.
-- =======================================================================================
ALTER DEFAULT PRIVILEGES FOR ROLE medskin_owner IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- LA FRONTERA ENTRE ESTA FUNCIÓN Y NODE, QUE ES LA DECISIÓN DE SEGURIDAD DEL TRAMO
--
-- Argon2id corre en Node, no en la base: no hay extensión de Argon2 y meterla sería una
-- dependencia de C en el motor para hacer lo que el proceso ya hace. Así que el verificado
-- en tiempo constante y el señuelo los ejecuta `backend-senior`, y esta función se limita
-- a que el camino sea IDÉNTICO:
--
--   1. Devuelve SIEMPRE exactamente una fila. Correo que no existe, cuenta borrada y
--      cuenta sin credencial devuelven la misma forma.
--   2. Devuelve SIEMPRE un `hash` que verificar: el de la cuenta, o el señuelo. No hay
--      ningún caso en que el llamador pueda saltarse el Argon2id, que es lo que haría
--      medible el «no existe» con un cronómetro (acceso.md).
--   3. No dice si el correo existe más de lo que el llamador necesita para NO emitir un
--      token: `account_id` nulo significa señuelo. Eso lo sabe el proceso, nunca la
--      respuesta HTTP, que es un solo `401 acceso_no_coincide` en los tres casos.
--
-- Y el orden importa, porque es la otra mitad de la promesa: `backend-senior` verifica
-- Argon2id PRIMERO y solo después mira `status`. Si devolviera `403 cuenta_suspendida`
-- antes de comprobar la contraseña, la suspensión sería el oráculo que el 401 cierra.
--
-- `practice_id`, `practitioner_role` y `permissions` viajan porque `POST /v1/acceso` tiene
-- que resolver a qué consulta pertenece quien entra ANTES de que exista contexto de
-- consulta, y con `app_practitioner` eso es imposible: su política exige el `practice_id`
-- que todavía no se conoce. Es la consulta que `practitioner_account_idx` existe para
-- servir. `permissions` viaja crudo, nulo incluido: resolver la lista del rol es de la
-- aplicación (decisión 11), y una lista resuelta en la base sería la misma tabla dos veces.
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION medskin_access_credential(p_email citext)
RETURNS TABLE (account_id uuid, role text, status text, region text, hash text,
               is_temporary boolean, temp_expires_at timestamptz,
               temp_first_used_at timestamptz, temp_used_at timestamptz,
               locked_until timestamptz,
               attempts_left integer, practice_id uuid, practitioner_role text,
               permissions text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_decoy text;
BEGIN
  IF p_email IS NULL OR btrim(p_email::text) = '' THEN
    RAISE EXCEPTION 'medskin_access_credential: correo vacio'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT d.hash INTO v_decoy FROM access_decoy d WHERE d.only_row;
  IF v_decoy IS NULL THEN
    -- Sin señuelo no hay «mismo tiempo», y sin «mismo tiempo» el 401 miente. Antes
    -- fallar el acceso entero que servirlo con el oráculo abierto.
    RAISE EXCEPTION 'medskin_access_credential: falta el hash senuelo'
      USING ERRCODE = 'internal_error';
  END IF;

  RETURN QUERY
    SELECT a.id, a.role, a.status, a.region,
           coalesce(c.hash, v_decoy),
           coalesce(c.is_temporary, false),
           c.temp_expires_at, c.temp_first_used_at, c.temp_used_at, a.locked_until,
           greatest(5 - a.failed_attempts, 0),
           pr.practice_id, pr.role, pr.permissions
      FROM account a
      LEFT JOIN credential c ON c.account_id = a.id
      -- LATERAL con LIMIT 1: una cuenta en dos consultas no puede devolver dos filas,
      -- porque entonces el llamador tendría que elegir y el token lleva un solo
      -- `practice`. La más antigua, de forma determinista.
      LEFT JOIN LATERAL (
        SELECT p.practice_id, p.role, p.permissions FROM practitioner p
         WHERE p.account_id = a.id AND p.status = 'activa'
         ORDER BY p.created_at, p.id LIMIT 1
      ) pr ON true
     WHERE a.email = p_email AND a.deleted_at IS NULL AND a.status <> 'borrada';

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, NULL::text, NULL::text, v_decoy,
                        false, NULL::timestamptz, NULL::timestamptz, NULL::timestamptz,
                        NULL::timestamptz, 5, NULL::uuid, NULL::text, NULL::text[];
  END IF;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_access_credential(citext) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_access_credential(citext) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_access_credential(citext) TO app_anonymous;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- La pausa del acceso: 5 intentos por cuenta → 15 minutos, y se limpia al entrar bien.
-- Al llegar al quinto el contador vuelve a 0 y lo que queda es la pausa: si no, pasada la
-- pausa el sexto intento dispararía otra, y la cuenta quedaría sellada para siempre.
--
-- Un correo SIN cuenta no tiene fila donde contar y no se le inventa una (sería un padrón
-- de correos tecleados). El contador que hace idéntica la respuesta para un correo que no
-- existe es el de Redis, por correo y por IP, que es donde los contratos lo ponen.
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION medskin_access_attempt(p_email citext, p_success boolean)
RETURNS TABLE (attempts_left integer, locked_until timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  c_limit constant integer := 5;
  c_pause constant interval := interval '15 minutes';
  v_account uuid;
  v_attempts integer;
  v_locked timestamptz;
BEGIN
  IF p_email IS NULL OR btrim(p_email::text) = '' OR p_success IS NULL THEN
    RAISE EXCEPTION 'medskin_access_attempt: argumentos incompletos'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.id, a.failed_attempts INTO v_account, v_attempts
    FROM account a WHERE a.email = p_email AND a.deleted_at IS NULL FOR UPDATE;

  IF v_account IS NULL THEN
    RETURN QUERY SELECT c_limit, NULL::timestamptz;
    RETURN;
  END IF;

  IF p_success THEN
    UPDATE account a SET failed_attempts = 0, locked_until = NULL, updated_at = now()
     WHERE a.id = v_account;
    -- Y aquí se marca la PRIMERA entrada con la temporal, que es lo que habilita la
    -- recuperación por correo. `coalesce` no: la condición va en el WHERE para que la
    -- marca sea la de la primera vez y no se mueva en cada entrada.
    UPDATE credential c
       SET temp_first_used_at = now(), updated_at = now()
     WHERE c.account_id = v_account AND c.is_temporary AND c.temp_first_used_at IS NULL;
    RETURN QUERY SELECT c_limit, NULL::timestamptz;
    RETURN;
  END IF;

  v_attempts := v_attempts + 1;
  IF v_attempts >= c_limit THEN
    v_locked := now() + c_pause;
    v_attempts := 0;
  END IF;

  UPDATE account a
     SET failed_attempts = v_attempts,
         locked_until = coalesce(v_locked, a.locked_until),
         updated_at = now()
   WHERE a.id = v_account;

  RETURN QUERY SELECT CASE WHEN v_locked IS NULL THEN c_limit - v_attempts ELSE 0 END, v_locked;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_access_attempt(citext, boolean) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_access_attempt(citext, boolean) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_access_attempt(citext, boolean) TO app_anonymous;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- El hash de la cuenta EN CONTEXTO, para quien ya está dentro. La autorización no es un
-- argumento: es `medskin.account_id`, que lo fija `withTenantContext()` desde el token.
-- Sin contexto no hay nada que pedir, así que `app_anonymous` no la puede usar ni teniendo
-- el grant (no lo tiene).
--
-- La necesitan dos sitios: `400 contrasena_igual_a_la_temporal` de
-- `POST /v1/acceso/contrasena-nueva` y `401 contrasena_actual_no_coincide` de
-- `PATCH /v1/cuentas/mia/contrasena`. Los dos comparan en Node contra un hash que
-- `credential` no deja leer a ningún rol de aplicación.
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION medskin_current_credential()
RETURNS TABLE (hash text, is_temporary boolean, temp_expires_at timestamptz,
               temp_first_used_at timestamptz, temp_used_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_account uuid := medskin_current_account();
BEGIN
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'medskin_current_credential: sin contexto de cuenta'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT c.hash, c.is_temporary, c.temp_expires_at, c.temp_first_used_at, c.temp_used_at
      FROM credential c WHERE c.account_id = v_account;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_current_credential() OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_current_credential() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_current_credential() TO app_practitioner, app_patient;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- Guardar la contraseña definitiva. Decisión 2: la temporal se consume AL GUARDAR LA
-- NUEVA, no al entrar, y por eso `temp_used_at` se marca en esta misma transacción, junto
-- con la anulación del código de recuperación y la revocación de las demás sesiones.
-- Las tres cosas o ninguna: si se repartieran en tres llamadas, un fallo entre dos dejaría
-- a alguien fuera de su propia cuenta sin salida, que es justo lo que el 500 de
-- `contrasena-nueva` promete que no pasa.
--
-- `p_via` es la prueba de por dónde se llegó, y cada camino tiene su condición:
--   'temporal'     exige que la credencial siga siendo la temporal → si no,
--                  'already_chosen' (409 contrasena_ya_elegida).
--   'recuperacion' exige un código vivo, que se anula aquí → si no, 'no_code'.
-- La autorización, otra vez, es el contexto: `medskin.account_id`, nunca un argumento.
-- NO revoca la sesión que llama (`p_current_session`): «Guardar y entrar» es entrar.
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION medskin_set_final_password(p_hash text, p_via text, p_current_session uuid)
RETURNS TABLE (verdict text, account_id uuid, role text, practice_id uuid,
               permissions text[], sessions_revoked integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_account uuid := medskin_current_account();
  v_was_temporary boolean;
  v_code uuid;
  v_revoked integer := 0;
  v_role text;
  v_practice uuid;
  v_permissions text[];
BEGIN
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'medskin_set_final_password: sin contexto de cuenta'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Un hash de Argon2id codificado nunca es corto. Esto no valida la contraseña (eso es
  -- de Node y de la lista de las más usadas): impide guardar una cadena que no es un hash.
  IF p_hash IS NULL OR length(p_hash) < 40 OR p_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'medskin_set_final_password: el hash no es de Argon2id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_via IS NULL OR p_via NOT IN ('temporal', 'recuperacion') THEN
    RAISE EXCEPTION 'medskin_set_final_password: via desconocida'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT c.is_temporary INTO v_was_temporary
    FROM credential c WHERE c.account_id = v_account FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_credential', v_account, NULL::text, NULL::uuid, NULL::text[], 0;
    RETURN;
  END IF;

  IF p_via = 'temporal' AND NOT v_was_temporary THEN
    RETURN QUERY SELECT 'already_chosen', v_account, NULL::text, NULL::uuid, NULL::text[], 0;
    RETURN;
  END IF;

  IF p_via = 'recuperacion' THEN
    UPDATE recovery_code rc
       SET used_at = now(), voided_at = now(), voided_reason = 'usado'
     WHERE rc.account_id = v_account AND rc.used_at IS NULL AND rc.voided_at IS NULL
       AND rc.expires_at > now()
     RETURNING rc.id INTO v_code;
    IF v_code IS NULL THEN
      RETURN QUERY SELECT 'no_code', v_account, NULL::text, NULL::uuid, NULL::text[], 0;
      RETURN;
    END IF;
  END IF;

  UPDATE credential c
     SET hash = p_hash,
         is_temporary = false,
         -- Se consume aquí, y solo si lo que había era la temporal.
         temp_used_at = CASE WHEN v_was_temporary
                             THEN coalesce(c.temp_used_at, now())
                             ELSE c.temp_used_at END,
         set_at = now(),
         updated_at = now()
   WHERE c.account_id = v_account;

  -- «Quien tuviera el correo con la temporal se queda fuera.» El `refresh_hash` NO se
  -- borra a propósito: con él puesto, un refresco de una sesión revocada se distingue de
  -- uno inventado, y son dos frases distintas en sesion.md.
  UPDATE session s
     SET revoked_at = now(), revoked_reason = 'password_changed'
   WHERE s.account_id = v_account AND s.revoked_at IS NULL
     AND (p_current_session IS NULL OR s.id <> p_current_session);
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  SELECT a.role INTO v_role FROM account a WHERE a.id = v_account;
  SELECT p.practice_id, p.permissions INTO v_practice, v_permissions
    FROM practitioner p WHERE p.account_id = v_account AND p.status = 'activa'
   ORDER BY p.created_at, p.id LIMIT 1;

  RETURN QUERY SELECT 'saved', v_account, v_role, v_practice, v_permissions, v_revoked;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_set_final_password(text, text, uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_set_final_password(text, text, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_set_final_password(text, text, uuid)
  TO app_practitioner, app_patient;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- Acuñar el código de recuperación. 10 minutos, un solo uso, uno vivo por cuenta: pedir
-- otro anula el anterior, aquí mismo.
--
-- Solo acuña si la cuenta está activa Y YA ESTRENÓ su contraseña temporal: «quien no
-- probó nunca que tiene el correo no puede usar el correo para entrar» (recuperacion.md).
-- Su camino es que la doctora le reenvíe el acceso.
--
-- «Estrenó» es `temp_first_used_at IS NOT NULL`, NO `is_temporary = false`: con la
-- decisión 2, quien entró con la temporal y no llegó a elegir sigue con
-- `is_temporary = true`, y mirar esa columna la dejaría sin recuperación justo en el caso
-- para el que la recuperación existe. Ver el comentario de la sección 1.
--
-- Devuelve un booleano, y recuperacion.md dice «devuelve void en los dos casos». No se
-- puede cumplir a la vez que «cuando el correo no existe NO encola nada»: alguien del
-- proceso tiene que saberlo para no encolar. Queda anotado en preguntas-abiertas.md; lo
-- que no cambia es la respuesta HTTP, que es el mismo 202 con el mismo cuerpo y el mismo
-- `caduca_en` calculado en los dos casos.
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION medskin_recovery_mint(p_email citext, p_code_hash text,
                                      p_expires_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_account uuid;
BEGIN
  IF p_email IS NULL OR btrim(p_email::text) = '' THEN
    RAISE EXCEPTION 'medskin_recovery_mint: correo vacio'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_code_hash IS NULL OR p_code_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'medskin_recovery_mint: el codigo no viene hasheado con Argon2id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Cota, no la regla: los 10 minutos los pone el llamador, pero un código que caduca
  -- dentro de una hora no es un código de recuperación.
  IF p_expires_at IS NULL OR p_expires_at <= now()
     OR p_expires_at > now() + interval '15 minutes' THEN
    RAISE EXCEPTION 'medskin_recovery_mint: caducidad fuera de rango'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.id INTO v_account
    FROM account a JOIN credential c ON c.account_id = a.id
   WHERE a.email = p_email AND a.status = 'activa' AND a.deleted_at IS NULL
     AND c.temp_first_used_at IS NOT NULL;
  IF v_account IS NULL THEN
    RETURN false;
  END IF;

  UPDATE recovery_code rc
     SET voided_at = now(), voided_reason = 'codigo_nuevo'
   WHERE rc.account_id = v_account AND rc.used_at IS NULL AND rc.voided_at IS NULL;

  INSERT INTO recovery_code (account_id, code_hash, expires_at)
  VALUES (v_account, p_code_hash, p_expires_at);

  RETURN true;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_recovery_mint(citext, text, timestamptz) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_recovery_mint(citext, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_recovery_mint(citext, text, timestamptz) TO app_anonymous;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- El código vigente de un correo, para compararlo en Node en tiempo constante. Misma
-- frontera y mismo señuelo que el acceso, por el mismo motivo: «un correo sin cuenta
-- responde exactamente lo mismo que un código mal escrito, con el mismo contador y el
-- mismo tiempo de respuesta, aunque por debajo no haya ningún código que comparar».
--
-- Por eso «correo sin cuenta» y «cuenta sin código vivo» devuelven los DOS veredicto
-- 'live' con el señuelo: el llamador compara, falla y responde el mismo 401. Los dos 410
-- —caducado y anulado— sí son estados distintos, y eso ya está en el contrato.
-- No consume intento ni marca nada: validar el código no cambia nada (recuperacion.md).
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION medskin_recovery_live(p_email citext)
RETURNS TABLE (verdict text, account_id uuid, role text, code_hash text,
               expires_at timestamptz, attempts_left integer, voided_reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  c_limit constant integer := 5;
  v_decoy text;
  v_account uuid;
  v_role text;
  v_id uuid;
  v_hash text;
  v_expires timestamptz;
  v_attempts integer;
  v_used timestamptz;
  v_voided timestamptz;
  v_reason text;
BEGIN
  IF p_email IS NULL OR btrim(p_email::text) = '' THEN
    RAISE EXCEPTION 'medskin_recovery_live: correo vacio'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT d.hash INTO v_decoy FROM access_decoy d WHERE d.only_row;
  IF v_decoy IS NULL THEN
    RAISE EXCEPTION 'medskin_recovery_live: falta el hash senuelo'
      USING ERRCODE = 'internal_error';
  END IF;

  SELECT a.id, a.role INTO v_account, v_role
    FROM account a
   WHERE a.email = p_email AND a.deleted_at IS NULL AND a.status = 'activa';

  IF v_account IS NOT NULL THEN
    SELECT rc.id, rc.code_hash, rc.expires_at, rc.attempts, rc.used_at, rc.voided_at,
           rc.voided_reason
      INTO v_id, v_hash, v_expires, v_attempts, v_used, v_voided, v_reason
      FROM recovery_code rc
     WHERE rc.account_id = v_account
     ORDER BY rc.created_at DESC, rc.id DESC LIMIT 1;
  END IF;

  IF v_id IS NULL THEN
    -- Ni cuenta, ni código: el señuelo y el mismo veredicto. `account_id` viaja nulo
    -- cuando no hay cuenta, y el llamador no lo convierte en una respuesta distinta.
    RETURN QUERY SELECT 'live', v_account, v_role, v_decoy,
                        now() + interval '10 minutes', c_limit, NULL::text;
  ELSIF v_used IS NOT NULL OR v_voided IS NOT NULL THEN
    RETURN QUERY SELECT 'voided', v_account, v_role, v_decoy, v_expires, 0,
                        coalesce(v_reason, 'usado');
  ELSIF v_expires <= now() THEN
    RETURN QUERY SELECT 'expired', v_account, v_role, v_decoy, v_expires, 0, NULL::text;
  ELSE
    RETURN QUERY SELECT 'live', v_account, v_role, v_hash, v_expires,
                        greatest(c_limit - v_attempts, 0), NULL::text;
  END IF;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_recovery_live(citext) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_recovery_live(citext) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_recovery_live(citext) TO app_anonymous;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- Un intento fallido de código: lo cuenta, y al quinto anula el código. «No se bloquea tu
-- cuenta: solo ese código» (Arranque · 8), así que no toca `account` ni una columna.
-- Un fallo del SERVIDOR no llama aquí: el 500 promete que «el código sigue valiendo», y
-- solo cuentan los códigos que de verdad se compararon.
-- Sin código que contar devuelve NULL: el número que ve quien no tiene cuenta sale del
-- contador por correo de Redis, igual que en la pausa del acceso.
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION medskin_recovery_miss(p_email citext)
RETURNS TABLE (attempts_left integer, voided boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  c_limit constant integer := 5;
  v_id uuid;
  v_attempts integer;
BEGIN
  IF p_email IS NULL OR btrim(p_email::text) = '' THEN
    RAISE EXCEPTION 'medskin_recovery_miss: correo vacio'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT rc.id, rc.attempts INTO v_id, v_attempts
    FROM recovery_code rc JOIN account a ON a.id = rc.account_id
   WHERE a.email = p_email AND rc.used_at IS NULL AND rc.voided_at IS NULL
     AND rc.expires_at > now()
   FOR UPDATE OF rc;

  IF v_id IS NULL THEN
    RETURN QUERY SELECT NULL::integer, false;
    RETURN;
  END IF;

  v_attempts := v_attempts + 1;
  UPDATE recovery_code rc
     SET attempts = v_attempts,
         voided_at = CASE WHEN v_attempts >= c_limit THEN now() ELSE NULL END,
         voided_reason = CASE WHEN v_attempts >= c_limit THEN 'intentos' ELSE NULL END
   WHERE rc.id = v_id;

  RETURN QUERY SELECT greatest(c_limit - v_attempts, 0), v_attempts >= c_limit;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_recovery_miss(citext) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_recovery_miss(citext) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_recovery_miss(citext) TO app_anonymous;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- Validar y rotar el refresco. `POST /v1/sesion/refresco` no lleva `Authorization`, así
-- que corre con `app_anonymous`: no hay contexto que fijar y el `practice_id` del token
-- nuevo SALE DE LA FILA DE LA SESIÓN, nunca del cuerpo. Si lo aceptara del cliente sería
-- un cambio de consulta gratuito (sesion.md).
--
-- `p_hash` y `p_new_hash` son resúmenes deterministas (SHA-256) de la cadena opaca, no
-- Argon2id: `session_refresh_uq` es un índice único sobre la columna, y un hash con sal
-- distinta en cada cálculo no se podría buscar. Para un secreto de 256 bits generado por
-- el servidor eso es lo correcto; Argon2id protege contraseñas adivinables, no esto.
--
-- «Se revoca toda la familia de sesiones derivadas de ese inicio»: la familia ES la fila.
-- Cada entrada crea una `session` y la rotación la actualiza en su sitio, así que revocar
-- esa fila revoca la cadena entera. No hace falta una columna de familia.
--
-- La ventana de gracia de 20 s no está aquí: el contrato la pone en caché, y 20 segundos
-- no son una fila de base de datos (preguntas-abiertas.md).
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION medskin_session_refresh(p_hash text, p_new_hash text,
                                        p_expires_at timestamptz)
RETURNS TABLE (verdict text, session_id uuid, account_id uuid, practice_id uuid,
               scope text, role text, permissions text[], account_status text,
               refresh_expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_session session;
BEGIN
  IF p_hash IS NULL OR length(p_hash) < 32 THEN
    RAISE EXCEPTION 'medskin_session_refresh: refresco vacio o demasiado corto'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_new_hash IS NULL OR length(p_new_hash) < 32 OR p_new_hash = p_hash THEN
    RAISE EXCEPTION 'medskin_session_refresh: el refresco nuevo no es nuevo'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'medskin_session_refresh: caducidad fuera de rango'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT s.* INTO v_session FROM session s WHERE s.refresh_hash = p_hash FOR UPDATE;

  IF NOT FOUND THEN
    -- ¿Es el inmediatamente anterior? Entonces se usó dos veces: o lo copiaron, o la app
    -- tiene una carrera. Las dos se arreglan entrando otra vez.
    SELECT s.* INTO v_session FROM session s
      WHERE s.previous_refresh_hash = p_hash FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'invalid', NULL::uuid, NULL::uuid, NULL::uuid, NULL::text,
                          NULL::text, NULL::text[], NULL::text, NULL::timestamptz;
      RETURN;
    END IF;
    UPDATE session s SET revoked_at = coalesce(s.revoked_at, now()),
                         revoked_reason = coalesce(s.revoked_reason, 'refresh_reused')
     WHERE s.id = v_session.id;
    RETURN QUERY SELECT 'reused', v_session.id, v_session.account_id, v_session.practice_id,
                        v_session.scope, NULL::text, NULL::text[], NULL::text,
                        NULL::timestamptz;
    RETURN;
  END IF;

  IF v_session.revoked_at IS NOT NULL THEN
    RETURN QUERY SELECT 'revoked', v_session.id, v_session.account_id, v_session.practice_id,
                        v_session.scope, NULL::text, NULL::text[], NULL::text,
                        NULL::timestamptz;
    RETURN;
  END IF;

  IF v_session.refresh_expires_at IS NULL OR v_session.refresh_expires_at <= now() THEN
    RETURN QUERY SELECT 'expired', v_session.id, v_session.account_id, v_session.practice_id,
                        v_session.scope, NULL::text, NULL::text[], NULL::text,
                        NULL::timestamptz;
    RETURN;
  END IF;

  UPDATE session s
     SET previous_refresh_hash = p_hash,
         refresh_hash = p_new_hash,
         refresh_expires_at = p_expires_at,
         refresh_rotated_at = now(),
         last_seen_at = now()
   WHERE s.id = v_session.id;

  RETURN QUERY
    SELECT 'rotated', v_session.id, v_session.account_id, v_session.practice_id,
           v_session.scope, a.role, pr.permissions, a.status, p_expires_at
      FROM account a
      LEFT JOIN LATERAL (
        SELECT p.permissions FROM practitioner p
         WHERE p.account_id = a.id AND p.practice_id = v_session.practice_id
           AND p.status = 'activa' LIMIT 1
      ) pr ON true
     WHERE a.id = v_session.account_id;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_session_refresh(text, text, timestamptz) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_session_refresh(text, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_session_refresh(text, text, timestamptz) TO app_anonymous;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- La cuenta de la paciente, desde la doctora (`POST /v1/pacientes`, parte de acceso).
--
-- NO recibe `account_id`, y es la decisión de seguridad de esta función: si lo recibiera,
-- una doctora podría acuñar una contraseña temporal sobre la cuenta de cualquiera —la
-- paciente de otra consulta, u otra doctora— y entrar con ella. Sin argumento que apuntar,
-- lo único que puede hacer es crear una cuenta nueva con el correo que escribió.
--
-- Si el correo ya tiene cuenta, la REUSA y no acuña nada: «la paciente no recibe
-- contraseña temporal ninguna, ya tiene la suya» (cuentas.md). Eso es todo lo que la
-- función revela de la existencia de la cuenta, y se lo revela a la doctora que acaba de
-- escribir el correo de su propia paciente.
--
-- El `practice_id` y la región salen del CONTEXTO, no de un argumento. `patient_link` es
-- del tramo 2: aquí no hay vínculo que crear todavía, y por eso tampoco hay reenvío de
-- acceso por `account_id` (`POST /v1/cuentas/{id}/acceso`), cuya autorización ES ese
-- vínculo.
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION medskin_create_patient_account(p_email citext, p_first_name text,
                                               p_last_name text, p_phone text,
                                               p_hash text, p_expires_at timestamptz)
RETURNS TABLE (account_id uuid, already_existed boolean, status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_practice uuid := medskin_current_practice();
  v_region text;
  v_account uuid;
  v_status text;
BEGIN
  IF v_practice IS NULL THEN
    RAISE EXCEPTION 'medskin_create_patient_account: sin contexto de consulta'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_email IS NULL OR btrim(p_email::text) = ''
     OR p_first_name IS NULL OR btrim(p_first_name) = ''
     OR p_last_name IS NULL OR btrim(p_last_name) = '' THEN
    RAISE EXCEPTION 'medskin_create_patient_account: faltan correo, nombre o apellido'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_hash IS NULL OR p_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'medskin_create_patient_account: la temporal no viene hasheada con Argon2id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- 72 h, «y no se negocia por canal» (cuentas.md). La cota deja margen de reloj y nada más.
  IF p_expires_at IS NULL OR p_expires_at <= now()
     OR p_expires_at > now() + interval '73 hours' THEN
    RAISE EXCEPTION 'medskin_create_patient_account: la temporal vive 72 h'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT p.region INTO v_region FROM practice p WHERE p.id = v_practice;
  IF v_region IS NULL THEN
    RAISE EXCEPTION 'medskin_create_patient_account: la consulta del contexto no existe'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.id, a.status INTO v_account, v_status FROM account a WHERE a.email = p_email;
  IF v_account IS NOT NULL THEN
    RETURN QUERY SELECT v_account, true, v_status;
    RETURN;
  END IF;

  INSERT INTO account (email, role, region, first_name, last_name, phone)
  VALUES (p_email, 'paciente', v_region, btrim(p_first_name), btrim(p_last_name),
          nullif(btrim(coalesce(p_phone, '')), ''))
  RETURNING account.id, account.status INTO v_account, v_status;

  INSERT INTO credential (account_id, hash, is_temporary, temp_expires_at)
  VALUES (v_account, p_hash, true, p_expires_at);

  RETURN QUERY SELECT v_account, false, v_status;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_create_patient_account(citext, text, text, text, text, timestamptz)
  OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_create_patient_account(citext, text, text, text, text, timestamptz)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_create_patient_account(citext, text, text, text, text, timestamptz)
  TO app_practitioner;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- La consulta y su dueña, desde la plataforma (`POST /v1/plataforma/consultas`).
-- «Una consulta sin dueña no existe, así que el alta es un solo acto»: la fila de
-- `practice` la escribe `app_platform` bajo su propia política, y esta función cierra el
-- acto con la cuenta, su temporal, su `practitioner` y `practice.owner_account_id`.
--
-- Hace falta función y no un grant por dos motivos: `app_platform` no tiene —ni va a
-- tener— políticas sobre `practitioner` (decisión 5), y tampoco tiene nada sobre
-- `credential` (soporte no toca contraseñas, lo promete la pantalla).
--
-- El `409 correo_ya_tiene_cuenta` SÍ revela que el correo existe, y está bien: aquí quien
-- llama es MedSkin sobre su propio padrón (consultas.md).
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION medskin_create_practice_owner(p_practice_id uuid, p_email citext,
                                              p_first_name text, p_last_name text,
                                              p_hash text, p_expires_at timestamptz)
RETURNS TABLE (verdict text, account_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
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

  RETURN QUERY SELECT 'created', v_account;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_create_practice_owner(uuid, citext, text, text, text, timestamptz)
  OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_create_practice_owner(uuid, citext, text, text, text, timestamptz)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_create_practice_owner(uuid, citext, text, text, text, timestamptz)
  TO app_platform;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- Decisión 4 · `license.status` lo mueve esta función, no un grant. La doctora sigue sin
-- `UPDATE` sobre `status`: escribe las seis columnas del cuerpo bajo su propia política
-- —que además solo la deja si el caso está `sin_enviar` o `rechazada`— y después llama
-- aquí. Ese orden es el contrato de esta función.
--
-- No recibe `practice_id`: lo toma del contexto. Nada que forjar. Y comprueba que quien
-- llama es la dueña, que es lo que `403 sin_permiso` promete en la pantalla: «Solo la
-- dueña de la consulta puede enviar la licencia».
-- `respuesta_estimada_en` la calcula el llamador con el calendario de la región: los
-- feriados de Bolivia no son dato de esta base.
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION medskin_license_to_review(p_response_estimated_at timestamptz)
RETURNS TABLE (verdict text, status text, submitted_at timestamptz,
               response_estimated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_practice uuid := medskin_current_practice();
  v_account uuid := medskin_current_account();
  v_owner uuid;
  v_region text;
  v_id uuid;
  v_status text;
  v_complete boolean;
  v_label text;
  v_now timestamptz := now();
BEGIN
  IF v_practice IS NULL OR v_account IS NULL THEN
    RAISE EXCEPTION 'medskin_license_to_review: sin contexto de consulta o de cuenta'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_response_estimated_at IS NULL OR p_response_estimated_at <= v_now THEN
    RAISE EXCEPTION 'medskin_license_to_review: la respuesta estimada ya pasó'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT p.owner_account_id, p.region INTO v_owner, v_region
    FROM practice p WHERE p.id = v_practice;
  IF v_owner IS NULL OR v_owner <> v_account THEN
    RETURN QUERY SELECT 'not_owner', NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT l.id, l.status,
         (coalesce(btrim(l.license_number), '') <> ''
          AND coalesce(btrim(l.credential_key), '') <> ''
          AND l.declaration_accepted AND l.terms_accepted)
    INTO v_id, v_status, v_complete
    FROM license l WHERE l.practice_id = v_practice FOR UPDATE;

  IF v_id IS NULL THEN
    RETURN QUERY SELECT 'no_license', NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_status = 'en_revision' THEN
    RETURN QUERY SELECT 'already_in_review', v_status, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_status = 'verificada' THEN
    RETURN QUERY SELECT 'already_verified', v_status, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  -- Última línea: la transición solo sale de `sin_enviar` o `rechazada`.
  IF v_status NOT IN ('sin_enviar', 'rechazada') THEN
    RETURN QUERY SELECT 'invalid_transition', v_status, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  IF NOT v_complete THEN
    RETURN QUERY SELECT 'incomplete', v_status, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  UPDATE license l
     SET status = 'en_revision',
         submitted_at = v_now,
         response_estimated_at = p_response_estimated_at,
         -- Un reenvío tras un rechazo abre el caso de nuevo: el histórico de quién decidió
         -- qué vive en la bitácora, que no tiene claves foráneas (§12.2.8).
         decided_at = NULL,
         rejection_reason = NULL,
         updated_at = v_now
   WHERE l.id = v_id;

  SELECT p.first_name || ' ' || p.last_name INTO v_label
    FROM practitioner p
   WHERE p.practice_id = v_practice AND p.account_id = v_account;

  INSERT INTO access_audit (practice_id, actor_account_id, actor_label, action,
                            subject_type, subject_id, data, region)
  VALUES (v_practice, v_account, v_label, 'license.to_review', 'license', v_id,
          jsonb_build_object('previous_status', v_status), v_region);

  RETURN QUERY SELECT 'submitted', 'en_revision', v_now, p_response_estimated_at;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_license_to_review(timestamptz) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_license_to_review(timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_license_to_review(timestamptz) TO app_practitioner;--> statement-breakpoint

-- =======================================================================================
-- 5 · LA CONSOLA · decisión 5
--
-- `session` POR COLUMNAS: la consola cuenta sesiones y ve versiones de app. No lee
-- `device`, ni `os`, ni `city`, ni `platform`. Y no es un filtro en el código del
-- endpoint: son tres columnas concedidas y catorce que no, así que
-- `select * from session` con el rol de plataforma es `permiso denegado`.
--
-- La política es nueva y es FOR SELECT a secas: la consola no cierra sesiones de nadie.
-- Lo que puede es levantar la pausa, que es otra cosa y ya estaba concedido en `account`.
-- =======================================================================================
CREATE POLICY session_platform_select ON "session" FOR SELECT TO app_platform
  USING (current_user = 'app_platform');--> statement-breakpoint
GRANT SELECT (account_id, app_version, last_seen_at) ON "session" TO app_platform;--> statement-breakpoint
-- El recuento y las versiones se buscan por `account_id`, que es la primera columna de
-- `session_account_active_idx` (account_id, last_seen_at DESC) WHERE revoked_at IS NULL.

-- La doctora necesita saber si es la dueña: «solo la dueña puede enviar la licencia» y
-- «solo la dueña da de alta al equipo». Bajo su política solo ve su propia fila de
-- `practice`, así que la columna no abre nada.
GRANT SELECT (owner_account_id) ON "practice" TO app_practitioner;--> statement-breakpoint

-- =======================================================================================
-- 6 · LA SEMILLA DEL SEÑUELO
--
-- Hash de Argon2id de 32 bytes aleatorios que nadie guardó: no hay contraseña que lo
-- abra, y no hace falta que la haya. Lo único que importa es que verificar contra él
-- cueste lo mismo que verificar contra uno real, y por eso se generó con los parámetros
-- por defecto de la librería `argon2` de Node (argon2id, m=65536, t=3, p=4).
--
-- SI `backend-senior` CAMBIA ESOS PARÁMETROS, HAY QUE VOLVER A SEMBRAR ESTA FILA: con
-- parámetros distintos el señuelo tarda distinto y el oráculo vuelve por la puerta del
-- reloj. Es un UPDATE de una fila, no una migración.
-- =======================================================================================
INSERT INTO "access_decoy" (only_row, hash)
VALUES (true, '$argon2id$v=19$m=65536,p=4,t=3$uwk383F4FsN/JIKtc1s6ZQ$GVnsaFqlkimVX8dDYgVvxCuUAneDdfTxZ6qz6hUwcLY')
ON CONFLICT (only_row) DO NOTHING;--> statement-breakpoint

-- =======================================================================================
-- 7 · Y SE LE RETIRA EL `CREATE` DEL ESQUEMA
--
-- Las once funciones ya son suyas (el `ALTER ... OWNER TO` va pegado a cada `CREATE`, para
-- que el ACL explícito se escriba sobre el dueño definitivo). Lo que queda es dejar a
-- `medskin_access` como lo que tiene que ser: un rol NOLOGIN que no puede crear nada, al
-- que nadie puede adoptar, y cuyo único papel es ser el dueño de esas once firmas.
-- =======================================================================================
REVOKE CREATE ON SCHEMA public FROM medskin_access;
