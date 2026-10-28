-- Tramo 2 · la ficha, el vínculo y los antecedentes.
-- Las cuatro tablas de `docs/contratos/pacientes.md` y de la parte de ficha de
-- `cuentas.md`. Las tablas, sus `CHECK`, sus claves foráneas y sus índices btree salen del
-- esquema de drizzle (`src/shared/db/schema/stage2.ts`); todo lo demás va a mano porque
-- drizzle-kit no lo expresa: las dos extensiones, el dominio, el índice GIN de la búsqueda,
-- RLS forzada, las políticas, los grants por columna y las dos funciones
-- `SECURITY DEFINER`.
--
-- Identificadores en inglés; los VALORES siguen en español donde el contrato los fija
-- (`status = 'invitada'`, `pregnancy_or_lactation = 'no_aplica'`, `field = 'alergias'`):
-- son formato de API, que es lo que las dos apps consumen.
--
-- QUÉ DESBLOQUEA, Y ERA EL ENCARGO: `patient_link` es la autorización literal de
-- `POST /v1/cuentas/{cuenta_id}/acceso` —`EXISTS (SELECT 1 FROM patient_link WHERE
-- account_id = $1)` bajo la política de `practice_id`—, que es lo único que le faltaba a
-- `cuentas.md` para estar entero.
--
-- LAS CUATRO DECISIONES DE ESTA MIGRACIÓN
--
-- 1. `patient_link` tiene DOS CARAS DE POLÍTICA y las dos hacen falta: `practice_id` para
--    la doctora, `account_id` para la paciente. Es la única lectura del sistema que cruza
--    inquilinos, y cruza solo las fichas de quien pregunta. De ahí los dos índices: uno que
--    empieza por el inquilino para la doctora y uno por cuenta sola para la paciente, que
--    no tiene inquilino que poner delante.
-- 2. `app_patient` NO tiene política en `patient`, y por eso `patient_link` copia tres
--    cadenas (consulta, doctora, ciudad). Es la pregunta 7: darle política sobre `practice`
--    o `practitioner` abriría TODOS los inquilinos para poder leer uno.
-- 3. `app_platform` no tiene ni una política ni un grant en ninguna de las cuatro. Soporte
--    no lee contenido de pacientes ni queriendo (_convenciones.md, `Consola.dc.html`).
-- 4. La regla «la doctora gana» NO es un disparador. La base da las columnas de
--    procedencia y los grants por columna; el predicado por campo —«solo si está vacío o lo
--    escribió ella»— lo escribe el endpoint, porque el contrato le exige DECIR qué campos
--    no guardó (`no_guardado`) y un disparador que revirtiera en silencio convertiría esa
--    lista en una mentira. Lo que la base sí garantiza es que la paciente no puede tocar
--    `phototype` ni `notes`: no están en su `GRANT`.
--
-- §3.4, regla 7: versionada, y NUNCA editada después de aplicarse.

-- =======================================================================================
-- 0 · LAS DOS EXTENSIONES Y EL DOMINIO, ANTES DE LAS TABLAS
--
-- `pg_trgm` entra con este tramo y no antes a propósito (preguntas-abiertas.md · «Fuera del
-- tramo 1»): su único uso es `GET /v1/pacientes`, que busca por nombre, apellido, correo y
-- celular con tolerancia a errores de tipeo desde 2 caracteres.
--
-- `btree_gin` entra con ella y es lo que hace cumplible la regla 5 de §7.3 en una búsqueda
-- por trigramas: sin ella, un índice GIN de trigramas no puede llevar el `practice_id`
-- delante —un uuid no tiene clase de operadores GIN propia— y la búsqueda de una consulta
-- recorrería los trigramas de TODAS. Es contrib de PostgreSQL, no un paquete nuevo.
-- =======================================================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gin;
--> statement-breakpoint
-- La procedencia de un campo de los antecedentes: `doctora` | `paciente`, y nada más.
-- Un dominio y no catorce `CHECK` idénticos repartidos entre dos tablas.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'medskin_history_source') THEN
    CREATE DOMAIN medskin_history_source AS text
      CONSTRAINT medskin_history_source_ck CHECK (VALUE IN ('doctora', 'paciente'));
  END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE "medical_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"has_allergies" boolean,
	"allergies" text[] DEFAULT '{}'::text[] NOT NULL,
	"allergies_source" "medskin_history_source",
	"allergies_source_at" timestamp with time zone,
	"takes_medication" boolean,
	"medication" text[] DEFAULT '{}'::text[] NOT NULL,
	"medication_source" "medskin_history_source",
	"medication_source_at" timestamp with time zone,
	"pregnancy_or_lactation" text,
	"pregnancy_or_lactation_source" "medskin_history_source",
	"pregnancy_or_lactation_source_at" timestamp with time zone,
	"phototype" integer,
	"phototype_source" "medskin_history_source",
	"phototype_source_at" timestamp with time zone,
	"past_conditions" text[] DEFAULT '{}'::text[] NOT NULL,
	"past_conditions_source" "medskin_history_source",
	"past_conditions_source_at" timestamp with time zone,
	"previous_treatments" text[] DEFAULT '{}'::text[] NOT NULL,
	"previous_treatments_source" "medskin_history_source",
	"previous_treatments_source_at" timestamp with time zone,
	"notes" text,
	"notes_source" "medskin_history_source",
	"notes_source_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medical_history_pregnancy_ck" CHECK ("medical_history"."pregnancy_or_lactation" is null or "medical_history"."pregnancy_or_lactation" in ('ninguno', 'embarazo', 'lactancia', 'no_sabe', 'no_aplica')),
	CONSTRAINT "medical_history_phototype_ck" CHECK ("medical_history"."phototype" is null or "medical_history"."phototype" between 1 and 6),
	CONSTRAINT "medical_history_allergies_ck" CHECK (case when "medical_history"."has_allergies" then array_length("medical_history"."allergies", 1) > 0
                else "medical_history"."allergies" = '{}'::text[] end),
	CONSTRAINT "medical_history_medication_ck" CHECK (case when "medical_history"."takes_medication" then array_length("medical_history"."medication", 1) > 0
                else "medical_history"."medication" = '{}'::text[] end)
);
--> statement-breakpoint
CREATE TABLE "medical_history_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"field" text NOT NULL,
	"previous_value" jsonb,
	"previous_source" "medskin_history_source",
	"previous_source_at" timestamp with time zone,
	"actor_account_id" uuid,
	"actor_source" "medskin_history_source" NOT NULL,
	CONSTRAINT "medical_history_audit_field_ck" CHECK ("medical_history_audit"."field" in ('alergias', 'medicacion', 'embarazo_o_lactancia', 'fototipo',
                         'antecedentes', 'tratamientos_previos', 'notas'))
);
--> statement-breakpoint
CREATE TABLE "patient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"birth_date" date NOT NULL,
	"email" "citext" NOT NULL,
	"phone" text,
	"has_whatsapp" boolean DEFAULT false NOT NULL,
	"reminders_via" text DEFAULT 'app' NOT NULL,
	"how_arrived" text NOT NULL,
	"referred_by" uuid,
	"status" text DEFAULT 'activa' NOT NULL,
	"archived_at" timestamp with time zone,
	"search_text" text GENERATED ALWAYS AS (lower("patient"."first_name" || ' ' || "patient"."last_name" || ' ' ||
             coalesce("patient"."email"::text, '') || ' ' || coalesce("patient"."phone", ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_status_ck" CHECK ("patient"."status" in ('activa', 'archivada')),
	CONSTRAINT "patient_reminders_via_ck" CHECK ("patient"."reminders_via" in ('app', 'whatsapp', 'ambas')),
	CONSTRAINT "patient_archived_ck" CHECK ("patient"."status" <> 'archivada' or "patient"."archived_at" is not null),
	CONSTRAINT "patient_referred_by_ck" CHECK ("patient"."referred_by" is null or "patient"."referred_by" <> "patient"."id")
);
--> statement-breakpoint
CREATE TABLE "patient_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"account_id" uuid,
	"status" text DEFAULT 'invitada' NOT NULL,
	"email" "citext" NOT NULL,
	"access_sent_at" timestamp with time zone,
	"practice_name" text NOT NULL,
	"practitioner_name" text NOT NULL,
	"city" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_link_status_ck" CHECK ("patient_link"."status" in ('invitada', 'vinculada', 'revocada'))
);
--> statement-breakpoint
ALTER TABLE "medical_history" ADD CONSTRAINT "medical_history_practice_id_practice_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_history" ADD CONSTRAINT "medical_history_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_practice_id_practice_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_referred_by_patient_id_fk" FOREIGN KEY ("referred_by") REFERENCES "public"."patient"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_link" ADD CONSTRAINT "patient_link_practice_id_practice_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_link" ADD CONSTRAINT "patient_link_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_link" ADD CONSTRAINT "patient_link_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "medical_history_patient_uq" ON "medical_history" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "medical_history_practice_idx" ON "medical_history" USING btree ("practice_id","patient_id");--> statement-breakpoint
CREATE INDEX "medical_history_audit_practice_idx" ON "medical_history_audit" USING btree ("practice_id","patient_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "patient_practice_status_idx" ON "patient" USING btree ("practice_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "patient_practice_email_idx" ON "patient" USING btree ("practice_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_link_patient_uq" ON "patient_link" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "patient_link_practice_account_idx" ON "patient_link" USING btree ("practice_id","account_id");--> statement-breakpoint
CREATE INDEX "patient_link_account_idx" ON "patient_link" USING btree ("account_id");--> statement-breakpoint

-- =======================================================================================
-- 1 · EL ÍNDICE DE LA BÚSQUEDA · inquilino delante, trigramas detrás
--
-- `GET /v1/pacientes` busca por nombre, apellido, correo y celular desde 2 caracteres y con
-- tolerancia a errores de tipeo. `search_text` es una columna GENERADA por el motor con las
-- cuatro en minúsculas, así que la consulta es `where search_text % $1` o
-- `where search_text like '%' || $1 || '%'` CON EL PATRÓN TAMBIÉN EN MINÚSCULAS, y el
-- índice sirve las dos.
--
-- Columna generada y no expresión en el índice por dos razones: la consulta tiene un nombre
-- que nombrar en vez de repetir la expresión exacta —si no coincide carácter a carácter, el
-- índice no se usa y nadie se entera—, y `lower()` queda en un solo sitio.
-- =======================================================================================
CREATE INDEX "patient_search_idx" ON "patient"
  USING gin ("practice_id", "search_text" gin_trgm_ops);--> statement-breakpoint

-- =======================================================================================
-- 2 · RLS EN LAS CUATRO. `ENABLE` no basta: sin `FORCE`, el dueño de la tabla se salta las
-- políticas por completo (§7.3, regla 1).
-- =======================================================================================
ALTER TABLE "patient"               ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient"               FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient_link"          ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient_link"          FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "medical_history"       ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "medical_history"       FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "medical_history_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "medical_history_audit" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

-- =======================================================================================
-- 3 · patient · política sobre `practice_id`, y de un solo rol.
--
-- `app_patient` NO tiene política aquí y no es un olvido: la ficha es de la consulta, y lo
-- que la paciente ve de su doctora son las tres cadenas copiadas en `patient_link`.
-- `app_platform` tampoco. Y nadie tiene `DELETE`: la salida es archivar, que no borra nada
-- del expediente (pacientes.md).
-- =======================================================================================
CREATE POLICY patient_practitioner ON "patient" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patient" TO app_practitioner;--> statement-breakpoint

-- =======================================================================================
-- 4 · patient_link · LAS DOS CARAS
--
-- La doctora, por inquilino: ve el vínculo de SU ficha, con el correo del acceso y su
-- estado. Es lo que `GET /v1/pacientes/{id}` devuelve en `vinculo`, y sale de aquí y nunca
-- de `account`.
--
-- La paciente, por cuenta: ve SUS vínculos, los de todas sus doctoras, que es la única
-- lectura del sistema que cruza inquilinos. Y solo seis columnas: las tres copias, el
-- estado, la fecha y los dos identificadores que necesita para escribir su ficha médica
-- —`practice_id` y `patient_id` salen de ESTA fila, nunca del cuerpo de la petición—. No ve
-- `email` (el suyo ya lo tiene en `account`) ni `access_sent_at`, que es cuándo se lo mandó
-- su doctora y es dato de la consulta.
--
-- Lo único que puede escribir es `status`: aceptar o rechazar. Nada más, por grant.
-- =======================================================================================
CREATE POLICY patient_link_practitioner ON "patient_link" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patient_link" TO app_practitioner;--> statement-breakpoint

CREATE POLICY patient_link_patient_select ON "patient_link" FOR SELECT TO app_patient
  USING (account_id = medskin_current_account());--> statement-breakpoint
CREATE POLICY patient_link_patient_update ON "patient_link" FOR UPDATE TO app_patient
  USING (account_id = medskin_current_account())
  WITH CHECK (account_id = medskin_current_account());--> statement-breakpoint
GRANT SELECT (id, practice_id, patient_id, status, practice_name, practitioner_name, city,
              created_at)
  ON "patient_link" TO app_patient;--> statement-breakpoint
GRANT UPDATE (status, updated_at) ON "patient_link" TO app_patient;--> statement-breakpoint

-- =======================================================================================
-- 5 · medical_history · la doctora por inquilino; la paciente, por su vínculo ACEPTADO
--
-- La política de la paciente no puede ser por inquilino porque ella no tiene uno: es un
-- `EXISTS` sobre `patient_link`, que resuelve por `patient_link_patient_uq` —una fila, no
-- un recorrido— y que además pasa por la política de `patient_link`, así que no puede
-- apuntar a un vínculo que no sea suyo.
--
-- Exige `status = 'vinculada'`: mientras no acepte a esa doctora no hay expediente que
-- leer ni que escribir, y es el `409 vinculo_sin_aceptar` del contrato cumplido en la base.
--
-- Y de columnas: ni `phototype` ni `notes`, en SELECT ni en UPDATE. «La misma forma, sin
-- `fototipo` y sin `notas`: el fototipo lo evalúa quien la ve, y `notas` es el cuaderno de
-- la doctora» (pacientes.md). No es una comprobación del endpoint: es un permiso que no
-- existe.
--
-- `app_platform`: ni política ni grant. Soporte no lee antecedentes ni queriendo.
-- =======================================================================================
CREATE POLICY medical_history_practitioner ON "medical_history" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "medical_history" TO app_practitioner;--> statement-breakpoint

CREATE POLICY medical_history_patient_select ON "medical_history" FOR SELECT TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.patient_id = medical_history.patient_id
                    AND l.account_id = medskin_current_account()
                    AND l.status = 'vinculada'));--> statement-breakpoint
CREATE POLICY medical_history_patient_update ON "medical_history" FOR UPDATE TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.patient_id = medical_history.patient_id
                    AND l.account_id = medskin_current_account()
                    AND l.status = 'vinculada'))
  WITH CHECK (EXISTS (SELECT 1 FROM patient_link l
                       WHERE l.patient_id = medical_history.patient_id
                         AND l.account_id = medskin_current_account()
                         AND l.status = 'vinculada'));--> statement-breakpoint
GRANT SELECT (id, practice_id, patient_id,
              has_allergies, allergies, allergies_source, allergies_source_at,
              takes_medication, medication, medication_source, medication_source_at,
              pregnancy_or_lactation, pregnancy_or_lactation_source,
              pregnancy_or_lactation_source_at,
              past_conditions, past_conditions_source, past_conditions_source_at,
              previous_treatments, previous_treatments_source,
              previous_treatments_source_at, updated_at)
  ON "medical_history" TO app_patient;--> statement-breakpoint
GRANT UPDATE (has_allergies, allergies, allergies_source, allergies_source_at,
              takes_medication, medication, medication_source, medication_source_at,
              pregnancy_or_lactation, pregnancy_or_lactation_source,
              pregnancy_or_lactation_source_at,
              past_conditions, past_conditions_source, past_conditions_source_at,
              previous_treatments, previous_treatments_source,
              previous_treatments_source_at, updated_at)
  ON "medical_history" TO app_patient;--> statement-breakpoint

-- =======================================================================================
-- 6 · medical_history_audit · lo que cambió, y no se puede reescribir
--
-- «Nada se borra: un campo que cambia deja su valor anterior en la auditoría, con quién y
-- cuándo» (pacientes.md). Inmutable por las dos vías a la vez, igual que `access_audit`: no
-- hay política de UPDATE ni de DELETE para ningún rol, y tampoco hay GRANT.
--
-- La paciente escribe aquí cuando sobrescribe un valor SUYO, y su `WITH CHECK` no es
-- `true`: la fila tiene que apuntar a la ficha y al inquilino de un vínculo suyo y aceptado.
-- Con `true` podría ensuciar la bitácora clínica de cualquier consulta.
-- No lee: no hay `GRANT SELECT` para ella. La bitácora de la ficha es de la consulta.
-- =======================================================================================
CREATE POLICY medical_history_audit_practitioner_select ON "medical_history_audit"
  FOR SELECT TO app_practitioner
  USING (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY medical_history_audit_practitioner_insert ON "medical_history_audit"
  FOR INSERT TO app_practitioner
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY medical_history_audit_patient_insert ON "medical_history_audit"
  FOR INSERT TO app_patient
  WITH CHECK (EXISTS (SELECT 1 FROM patient_link l
                       WHERE l.patient_id = medical_history_audit.patient_id
                         AND l.practice_id = medical_history_audit.practice_id
                         AND l.account_id = medskin_current_account()
                         AND l.status = 'vinculada'));--> statement-breakpoint
GRANT SELECT ON "medical_history_audit" TO app_practitioner;--> statement-breakpoint
GRANT INSERT ON "medical_history_audit" TO app_practitioner, app_patient;--> statement-breakpoint
GRANT USAGE ON SEQUENCE "medical_history_audit_id_seq" TO app_practitioner, app_patient;--> statement-breakpoint

-- =======================================================================================
-- 7 · medskin_access · lo que sus dos funciones nuevas necesitan, y nada más
-- =======================================================================================
CREATE POLICY patient_link_access ON "patient_link" FOR ALL TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint
GRANT SELECT ON "patient_link" TO medskin_access;--> statement-breakpoint
-- Marcar que se mandó el acceso. Ni el estado del vínculo —eso lo decide la paciente— ni
-- las copias, ni el correo.
GRANT UPDATE (access_sent_at, updated_at) ON "patient_link" TO medskin_access;--> statement-breakpoint

-- =======================================================================================
-- 8 · LAS DOS FUNCIONES QUE `patient_link` HACE POSIBLES
--
-- Las dos existen por el mismo motivo y no por comodidad: la doctora NO PUEDE LEER NI
-- ESCRIBIR la `credential` de su paciente. Su política es `account_id =
-- medskin_current_account()`, así que lo único que alcanza es su propia contraseña, y eso
-- es deliberado: «una doctora no puede resetear la contraseña de su paciente una vez
-- elegida; si pudiera, sería dueña del acceso al expediente de una persona adulta»
-- (cuentas.md). La frontera es la firma de estas dos funciones, y las dos empiezan por la
-- misma pregunta: ¿esa cuenta tiene vínculo en MI consulta?
--
-- Y las dos reciben `p_account_id` —a diferencia de `medskin_create_patient_account`, que
-- no recibe ninguno— porque ahora existe la tabla que convierte ese argumento en una
-- autorización comprobable. Sin `patient_link`, un `account_id` suelto le habría dejado
-- acuñar una temporal sobre la cuenta de cualquiera; con ella, un `account_id` de otra
-- consulta devuelve `paciente_no_existe`, la misma respuesta que uno inventado.
-- =======================================================================================

-- ---------------------------------------------------------------------------------------
-- 8.1 · El estado del acceso de SU paciente, para pintar el botón apagado en vez de que
-- falle al pulsarlo. Es el `vinculo.ya_eligio_contrasena` de `GET /v1/pacientes/{id}` y el
-- mismo dato que dispara el `409 ya_eligio_su_contrasena` del reenvío.
--
-- `STABLE`: solo lee (§7.3, regla 3). Devuelve CUATRO BOOLEANOS Y UNA FECHA, nunca la
-- fila: ni el hash, ni el correo, ni el nombre. Y si no hay vínculo devuelve
-- `linked = false` y lo demás nulo, sin decir si la cuenta existe.
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION medskin_patient_access_state(p_account_id uuid)
RETURNS TABLE (linked boolean, password_chosen boolean, temp_expires_at timestamptz,
               access_sent_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_practice uuid := medskin_current_practice();
  v_sent timestamptz;
  v_found boolean := false;
BEGIN
  IF v_practice IS NULL THEN
    RAISE EXCEPTION 'medskin_patient_access_state: sin contexto de inquilino'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'medskin_patient_access_state: falta la cuenta'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT true, l.access_sent_at INTO v_found, v_sent
    FROM patient_link l
   WHERE l.practice_id = v_practice AND l.account_id = p_account_id
   ORDER BY l.created_at LIMIT 1;

  IF NOT coalesce(v_found, false) THEN
    RETURN QUERY SELECT false, NULL::boolean, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT true,
           -- «Ya eligió la suya» es exactamente lo que `medskin_set_final_password` deja:
           -- `is_temporary = false` y `temp_used_at` marcado en la misma sentencia
           -- (decisión 2 del 27 de octubre).
           coalesce(c.is_temporary = false OR c.temp_used_at IS NOT NULL, false),
           c.temp_expires_at,
           v_sent
      FROM credential c WHERE c.account_id = p_account_id
     UNION ALL
    -- Una cuenta sin credencial no eligió nada, y la fila tiene que salir igual: el
    -- llamador espera siempre una.
    SELECT true, false, NULL::timestamptz, v_sent
     WHERE NOT EXISTS (SELECT 1 FROM credential c WHERE c.account_id = p_account_id);
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_patient_access_state(uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_patient_access_state(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_patient_access_state(uuid) TO app_practitioner;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 8.2 · El reenvío del acceso: `POST /v1/cuentas/{cuenta_id}/acceso`.
-- «Cada llamada acuña una contraseña nueva y mata la anterior», y no es idempotente.
--
-- Devuelve un VEREDICTO, que es lo que el endpoint necesita para elegir entre sus tres
-- respuestas, y nunca una fila:
--
--   `paciente_no_existe`      → 404. No hay vínculo en esta consulta. Misma respuesta que
--                               un `cuenta_id` inventado: no se distingue «no es tuya» de
--                               «no existe».
--   `ya_eligio_su_contrasena` → 409. Ya entró y puso la suya. La doctora no la resetea.
--   `acceso_renovado`         → 200. Temporal nueva, 72 h, y la anterior muerta.
--
-- El `practice_id` sale del CONTEXTO y nunca de un argumento. La fila de la bitácora la
-- escribe el endpoint, que es quien sabe quién la pidió (`audit_log` con quién y cuándo,
-- _convenciones.md · Idempotencia).
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION medskin_resend_patient_access(p_account_id uuid, p_hash text,
                                              p_expires_at timestamptz)
RETURNS TABLE (outcome text, expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_practice uuid := medskin_current_practice();
  v_link uuid;
  v_credential uuid;
  v_chosen boolean;
BEGIN
  IF v_practice IS NULL THEN
    RAISE EXCEPTION 'medskin_resend_patient_access: sin contexto de inquilino'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'medskin_resend_patient_access: falta la cuenta'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_hash IS NULL OR p_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'medskin_resend_patient_access: la temporal no viene hasheada con Argon2id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- 72 h, «y no se negocia por canal» (cuentas.md). La misma cota que el alta.
  IF p_expires_at IS NULL OR p_expires_at <= now()
     OR p_expires_at > now() + interval '73 hours' THEN
    RAISE EXCEPTION 'medskin_resend_patient_access: la temporal vive 72 h'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- LA AUTORIZACIÓN, Y ES LA PRIMERA COSA QUE PASA: el vínculo de esa cuenta en ESTA
  -- consulta. `FOR UPDATE` porque dos reenvíos a la vez no pueden acuñar dos temporales.
  SELECT l.id INTO v_link
    FROM patient_link l
   WHERE l.practice_id = v_practice AND l.account_id = p_account_id
   ORDER BY l.created_at LIMIT 1
     FOR UPDATE;

  IF v_link IS NULL THEN
    RETURN QUERY SELECT 'paciente_no_existe', NULL::timestamptz;
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
    -- La anterior muere aquí: el hash se reemplaza, y `temp_first_used_at` vuelve a nulo
    -- porque esta temporal es otra y todavía no se ha estrenado.
    UPDATE credential
       SET hash = p_hash, is_temporary = true, temp_expires_at = p_expires_at,
           temp_first_used_at = NULL, updated_at = now()
     WHERE id = v_credential;
  END IF;

  UPDATE patient_link SET access_sent_at = now(), updated_at = now() WHERE id = v_link;

  RETURN QUERY SELECT 'acceso_renovado', p_expires_at;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_resend_patient_access(uuid, text, timestamptz) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_resend_patient_access(uuid, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_resend_patient_access(uuid, text, timestamptz)
  TO app_practitioner;--> statement-breakpoint
