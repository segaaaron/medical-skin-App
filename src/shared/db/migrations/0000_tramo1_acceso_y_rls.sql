-- Tramo 1 · plataforma, acceso y sesión.
-- Generada con `pnpm db:generate` y completada a mano con lo que drizzle-kit no expresa:
-- extensiones, los tres roles de base, RLS forzada, políticas y grants por columna.
-- §3.4, regla 7: versionada, y NUNCA editada después de aplicarse. Si está mal, se escribe
-- la siguiente.

-- Extensiones (§3.2). `pg_trgm` no entra todavía: su único uso es la búsqueda de paciente
-- por nombre con errores de tipeo, que es del tramo 2. Una extensión que no se usa es
-- superficie que mantener.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE TABLE "acceso_auditoria" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ocurrio_en" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid,
	"actor_cuenta_id" uuid,
	"actor_etiqueta" text,
	"accion" text NOT NULL,
	"sujeto_tipo" text,
	"sujeto_id" uuid,
	"datos" jsonb,
	"region" text
);
--> statement-breakpoint
CREATE TABLE "clave_idempotencia" (
	"clave" text NOT NULL,
	"cuenta_id" uuid NOT NULL,
	"practice_id" uuid,
	"cuerpo_hash" text NOT NULL,
	"estado_http" integer,
	"respuesta" jsonb,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"caduca_en" timestamp with time zone NOT NULL,
	CONSTRAINT "clave_idempotencia_cuenta_id_clave_pk" PRIMARY KEY("cuenta_id","clave")
);
--> statement-breakpoint
CREATE TABLE "codigo_recuperacion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cuenta_id" uuid NOT NULL,
	"codigo_hash" text NOT NULL,
	"caduca_en" timestamp with time zone NOT NULL,
	"intentos" integer DEFAULT 0 NOT NULL,
	"usada_en" timestamp with time zone,
	"anulada_en" timestamp with time zone,
	"anulada_motivo" text,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "codigo_recuperacion_anulada_ck" CHECK ("codigo_recuperacion"."anulada_motivo" is null or "codigo_recuperacion"."anulada_motivo" in ('intentos', 'codigo_nuevo', 'usado')),
	CONSTRAINT "codigo_recuperacion_intentos_ck" CHECK ("codigo_recuperacion"."intentos" between 0 and 5)
);
--> statement-breakpoint
CREATE TABLE "credencial" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cuenta_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"es_temporal" boolean DEFAULT true NOT NULL,
	"temporal_caduca_en" timestamp with time zone,
	"temporal_usada_en" timestamp with time zone,
	"establecida_en" timestamp with time zone,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credencial_temporal_caduca_ck" CHECK ("credencial"."es_temporal" = false or "credencial"."temporal_caduca_en" is not null)
);
--> statement-breakpoint
CREATE TABLE "cuenta" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"correo" "citext" NOT NULL,
	"rol" text NOT NULL,
	"region" text NOT NULL,
	"nombre" text NOT NULL,
	"apellido" text NOT NULL,
	"celular" text,
	"estado" text DEFAULT 'activa' NOT NULL,
	"intentos_fallidos" integer DEFAULT 0 NOT NULL,
	"pausa_hasta" timestamp with time zone,
	"borrado_en" timestamp with time zone,
	"motivo_borrado" text,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cuenta_rol_ck" CHECK ("cuenta"."rol" in ('practitioner', 'paciente')),
	CONSTRAINT "cuenta_region_ck" CHECK ("cuenta"."region" in ('eu', 'us', 'latam')),
	CONSTRAINT "cuenta_estado_ck" CHECK ("cuenta"."estado" in ('activa', 'suspendida', 'borrada'))
);
--> statement-breakpoint
CREATE TABLE "licencia" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"estado" text DEFAULT 'sin_enviar' NOT NULL,
	"pais_ejercicio" text,
	"especialidad" text,
	"matricula" text,
	"credencial_clave" text,
	"declaracion_aceptada" boolean DEFAULT false NOT NULL,
	"terminos_aceptados" boolean DEFAULT false NOT NULL,
	"enviada_en" timestamp with time zone,
	"respuesta_estimada_en" timestamp with time zone,
	"decidida_en" timestamp with time zone,
	"motivo_rechazo" text,
	"revisada_por" uuid,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "licencia_estado_ck" CHECK ("licencia"."estado" in ('sin_enviar', 'en_revision', 'verificada', 'rechazada')),
	CONSTRAINT "licencia_motivo_rechazo_ck" CHECK ("licencia"."estado" <> 'rechazada' or length("licencia"."motivo_rechazo") between 10 and 300),
	CONSTRAINT "licencia_matricula_ck" CHECK ("licencia"."matricula" is null or length("licencia"."matricula") between 3 and 40)
);
--> statement-breakpoint
CREATE TABLE "practice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" text NOT NULL,
	"region" text NOT NULL,
	"pais" text NOT NULL,
	"zona_horaria" text NOT NULL,
	"moneda" text NOT NULL,
	"plan" text NOT NULL,
	"limite_pacientes" integer NOT NULL,
	"plan_renueva_en" date,
	"estado" text DEFAULT 'activa' NOT NULL,
	"direccion" text,
	"ciudad" text,
	"telefono" text,
	"logo_url" text,
	"nota_interna" text,
	"primer_dia_datos_consulta" boolean DEFAULT false NOT NULL,
	"primer_dia_horarios" boolean DEFAULT false NOT NULL,
	"primer_dia_primer_tratamiento" boolean DEFAULT false NOT NULL,
	"primer_dia_cerrada" boolean DEFAULT false NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practice_region_ck" CHECK ("practice"."region" in ('eu', 'us', 'latam')),
	CONSTRAINT "practice_plan_ck" CHECK ("practice"."plan" in ('individual', 'consultorio', 'clinica')),
	CONSTRAINT "practice_estado_ck" CHECK ("practice"."estado" in ('activa', 'pausada')),
	CONSTRAINT "practice_pais_ck" CHECK ("practice"."pais" ~ '^[A-Z]{2}$'),
	CONSTRAINT "practice_nombre_ck" CHECK (length("practice"."nombre") between 2 and 120)
);
--> statement-breakpoint
CREATE TABLE "practitioner" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"cuenta_id" uuid NOT NULL,
	"nombre" text NOT NULL,
	"apellido" text NOT NULL,
	"rol" text NOT NULL,
	"estado" text DEFAULT 'activa' NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practitioner_rol_ck" CHECK ("practitioner"."rol" in ('duena', 'clinico', 'recepcion')),
	CONSTRAINT "practitioner_estado_ck" CHECK ("practitioner"."estado" in ('activa', 'retirada'))
);
--> statement-breakpoint
CREATE TABLE "service_failure" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"service" text NOT NULL,
	"operation" text NOT NULL,
	"severity" text NOT NULL,
	"error_code" text NOT NULL,
	"error_message" text NOT NULL,
	"cause_chain" jsonb,
	"stack" text,
	"external_status" integer,
	"external_body" jsonb,
	"practice_id" uuid,
	"actor_id" uuid,
	"subject_type" text,
	"subject_id" uuid,
	"trace_id" text NOT NULL,
	"span_id" text,
	"request_id" text,
	"input_digest" text,
	"app_version" text,
	"platform" text,
	"region" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"will_retry" boolean NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	CONSTRAINT "service_failure_severity_ck" CHECK ("service_failure"."severity" in ('warning', 'error', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "sesion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cuenta_id" uuid NOT NULL,
	"practice_id" uuid,
	"alcance" text NOT NULL,
	"refresco_hash" text,
	"refresco_caduca_en" timestamp with time zone,
	"refresco_rotado_en" timestamp with time zone,
	"refresco_anterior_hash" text,
	"revocada_en" timestamp with time zone,
	"revocada_motivo" text,
	"dispositivo_id" text NOT NULL,
	"dispositivo" text,
	"sistema" text,
	"app_version" text,
	"plataforma" text,
	"ciudad" text,
	"entro_en" timestamp with time zone DEFAULT now() NOT NULL,
	"ultima_vez" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sesion_alcance_ck" CHECK ("sesion"."alcance" in ('contrasena_temporal', 'recuperacion', 'segundo_factor', 'completo', 'suplantacion')),
	CONSTRAINT "sesion_plataforma_ck" CHECK ("sesion"."plataforma" is null or "sesion"."plataforma" in ('ios', 'android', 'server')),
	CONSTRAINT "sesion_alcance_sin_refresco_ck" CHECK ("sesion"."alcance" = 'completo' or "sesion"."refresco_hash" is null)
);
--> statement-breakpoint
ALTER TABLE "codigo_recuperacion" ADD CONSTRAINT "codigo_recuperacion_cuenta_id_cuenta_id_fk" FOREIGN KEY ("cuenta_id") REFERENCES "public"."cuenta"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credencial" ADD CONSTRAINT "credencial_cuenta_id_cuenta_id_fk" FOREIGN KEY ("cuenta_id") REFERENCES "public"."cuenta"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licencia" ADD CONSTRAINT "licencia_practice_id_practice_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner" ADD CONSTRAINT "practitioner_practice_id_practice_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner" ADD CONSTRAINT "practitioner_cuenta_id_cuenta_id_fk" FOREIGN KEY ("cuenta_id") REFERENCES "public"."cuenta"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sesion" ADD CONSTRAINT "sesion_cuenta_id_cuenta_id_fk" FOREIGN KEY ("cuenta_id") REFERENCES "public"."cuenta"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sesion" ADD CONSTRAINT "sesion_practice_id_practice_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acceso_auditoria_practice_idx" ON "acceso_auditoria" USING btree ("practice_id","ocurrio_en" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "acceso_auditoria_actor_idx" ON "acceso_auditoria" USING btree ("actor_cuenta_id","ocurrio_en" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "acceso_auditoria_accion_idx" ON "acceso_auditoria" USING btree ("accion","ocurrio_en" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "clave_idempotencia_practice_idx" ON "clave_idempotencia" USING btree ("practice_id","caduca_en") WHERE practice_id is not null;--> statement-breakpoint
CREATE INDEX "clave_idempotencia_purga_idx" ON "clave_idempotencia" USING btree ("caduca_en");--> statement-breakpoint
CREATE UNIQUE INDEX "codigo_recuperacion_vivo_uq" ON "codigo_recuperacion" USING btree ("cuenta_id") WHERE usada_en is null and anulada_en is null;--> statement-breakpoint
CREATE INDEX "codigo_recuperacion_cuenta_idx" ON "codigo_recuperacion" USING btree ("cuenta_id","creado_en" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "credencial_cuenta_uq" ON "credencial" USING btree ("cuenta_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cuenta_correo_uq" ON "cuenta" USING btree ("correo");--> statement-breakpoint
CREATE UNIQUE INDEX "licencia_practice_uq" ON "licencia" USING btree ("practice_id");--> statement-breakpoint
CREATE INDEX "licencia_cola_revision_idx" ON "licencia" USING btree ("estado","enviada_en");--> statement-breakpoint
CREATE UNIQUE INDEX "practitioner_practice_cuenta_uq" ON "practitioner" USING btree ("practice_id","cuenta_id");--> statement-breakpoint
CREATE INDEX "practitioner_practice_estado_idx" ON "practitioner" USING btree ("practice_id","estado");--> statement-breakpoint
CREATE INDEX "practitioner_cuenta_idx" ON "practitioner" USING btree ("cuenta_id");--> statement-breakpoint
CREATE INDEX "service_failure_occurred_idx" ON "service_failure" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "service_failure_operacion_idx" ON "service_failure" USING btree ("service","operation","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "service_failure_codigo_idx" ON "service_failure" USING btree ("error_code","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "service_failure_practice_idx" ON "service_failure" USING btree ("practice_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "service_failure_trace_idx" ON "service_failure" USING btree ("trace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sesion_refresco_uq" ON "sesion" USING btree ("refresco_hash") WHERE refresco_hash is not null;--> statement-breakpoint
CREATE INDEX "sesion_refresco_anterior_idx" ON "sesion" USING btree ("refresco_anterior_hash") WHERE refresco_anterior_hash is not null;--> statement-breakpoint
CREATE INDEX "sesion_cuenta_activas_idx" ON "sesion" USING btree ("cuenta_id","ultima_vez" DESC NULLS LAST) WHERE revocada_en is null;--> statement-breakpoint
CREATE INDEX "sesion_practice_idx" ON "sesion" USING btree ("practice_id","ultima_vez" DESC NULLS LAST) WHERE practice_id is not null;--> statement-breakpoint
-- =======================================================================================
-- LOS TRES ROLES DE BASE, EL CONTEXTO, RLS Y LOS GRANTS
-- Nada de esto lo expresa drizzle-kit. Va a mano y en el mismo archivo que crea las
-- tablas (§3.4, regla 1: la tabla, el FORCE, sus políticas y sus índices, juntos).
--
-- CÓMO ADOPTA LA APLICACIÓN CADA ROL, Y POR QUÉ
-- ---------------------------------------------------------------------------------------
-- Decisión: UN solo rol de login —`medskin`, el que ya existe— que no hereda nada, y
-- `SET LOCAL ROLE` dentro de la transacción. NO tres roles de login separados.
--
-- 1. PgBouncer agrupa por (usuario, base). Tres roles de login serían tres pools: el
--    mismo despliegue multiplicaría por tres las conexiones al servidor y habría tres
--    tamaños que ajustar a ojo en vez de uno. Y el PgBouncer que ya corre —como el de
--    producción— abre la conexión al servidor con un único `DB_USER`: tres logins
--    exigirían tres secciones de `pgbouncer.ini`, tres entradas de `userlist.txt` y tres
--    secretos que rotar, para no ganar nada que esto no dé.
--
-- 2. `SET LOCAL ROLE` es seguro en modo transacción por la MISMA razón que la regla 2 de
--    §7.3: `LOCAL` se deshace en el `COMMIT`, igual que `set_config(..., true)`. Un
--    `SET ROLE` de sesión se filtraría al siguiente cliente que reutiliza la conexión,
--    exactamente como se filtra un `SET` de sesión del contexto de consulta. Por eso el
--    ayudante de `contexto-consulta.ts` emite las tres cosas —el rol y los dos
--    contextos— con alcance de transacción, en la misma transacción y en la misma
--    llamada: ninguna se puede olvidar sin olvidar las otras dos.
--
-- 3. `current_user` pasa a ser el rol adoptado, y eso es lo que leen las políticas de la
--    consola (`current_user = 'app_plataforma'`, _convenciones.md). Con un rol de login
--    que heredase los tres, `current_user` seguiría siendo `medskin`, esas políticas no
--    dispararían nunca y, peor, la unión de los tres juegos de permisos aplicaría
--    siempre. De ahí `ALTER ROLE medskin NOINHERIT` y la retirada de los grants directos
--    que puso `infra/postgres/init/01-usuario-app.sql`: sin `SET LOCAL ROLE` la conexión
--    de la aplicación no puede leer ni escribir NADA. Falla cerrada, no abierta.
--
-- Ninguno de los tres con `SUPERUSER` ni con `BYPASSRLS`. Y ninguno con `LOGIN`: no se
-- puede llegar a ellos por la red, solo adoptarlos desde `medskin`.
-- =======================================================================================
DO $$
BEGIN
  -- Idempotente a propósito: los roles son del clúster y las migraciones son de la base.
  -- Quien tire la base y vuelva a migrar se encuentra los roles ya puestos.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_doctora') THEN
    CREATE ROLE app_doctora;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_paciente') THEN
    CREATE ROLE app_paciente;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_plataforma') THEN
    CREATE ROLE app_plataforma;
  END IF;

  -- Sin condición: si alguno existía ya y estaba mal, queda bien.
  ALTER ROLE app_doctora    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  ALTER ROLE app_paciente   NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  ALTER ROLE app_plataforma NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  ALTER ROLE medskin        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  ALTER ROLE medskin        LOGIN NOINHERIT;
END
$$;--> statement-breakpoint

-- `medskin` puede ADOPTAR los tres, no los hereda: con NOINHERIT no tiene ni un
-- privilegio hasta que la transacción hace `SET LOCAL ROLE`.
GRANT app_doctora, app_paciente, app_plataforma TO medskin;--> statement-breakpoint

-- Y se le quitan los grants directos del script de arranque, que daban DML sobre todo a
-- la conexión de la aplicación y dejaban los tres roles de adorno.
REVOKE SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM medskin;--> statement-breakpoint
REVOKE USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public FROM medskin;--> statement-breakpoint
-- Y los que se darían solos a cada tabla futura. Una tabla nueva nace cerrada: sus grants
-- y sus políticas se escriben en la migración que la crea, o no se lee.
ALTER DEFAULT PRIVILEGES FOR ROLE medskin_owner IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM medskin;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE medskin_owner IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES FROM medskin;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO app_doctora, app_paciente, app_plataforma;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- Las dos funciones de contexto. §7.3, regla 3: STABLE, nunca VOLATILE. Una VOLATILE en
-- una política pasó de 0,3 ms a cerca de 1 900 ms en PostgreSQL 17.
--
-- No se marcan LEAKPROOF a propósito, y no incumple la regla: LEAKPROOF importa cuando la
-- función RECIBE el dato de la fila y podría filtrarlo por un mensaje de error, lo que
-- impide empujar el predicado por una barrera de seguridad. Estas no reciben nada: leen un
-- parámetro de la transacción. En `practice_id = medskin_practice_actual()` la función
-- está en el lado constante, STABLE la deja plegada a un parámetro y el índice sobre
-- `practice_id` se usa igual. Marcarla además exigiría superusuario en cada despliegue
-- para no ganar nada.
--
-- El segundo argumento `true` de current_setting es «missing_ok»: sin contexto fijado
-- devuelve NULL en vez de reventar. Y NULL no es igual a nada, así que una transacción sin
-- contexto no ve ni una fila. Es el valor por defecto correcto: cerrado.
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION medskin_practice_actual() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('medskin.practice_id', true), '')::uuid $$;--> statement-breakpoint
CREATE FUNCTION medskin_cuenta_actual() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('medskin.cuenta_id', true), '')::uuid $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- RLS en las diez tablas. ENABLE no basta: sin FORCE, el dueño de la tabla se salta las
-- políticas por completo (§7.3, regla 1).
-- ---------------------------------------------------------------------------------------
ALTER TABLE "practice"            ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "practice"            FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "licencia"            ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "licencia"            FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "practitioner"        ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "practitioner"        FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cuenta"              ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cuenta"              FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credencial"          ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credencial"          FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sesion"              ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sesion"              FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "codigo_recuperacion" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "codigo_recuperacion" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clave_idempotencia"  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clave_idempotencia"  FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "service_failure"     ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "service_failure"     FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "acceso_auditoria"    ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "acceso_auditoria"    FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

-- =======================================================================================
-- practice · contexto `medskin.practice_id`, y la política va sobre `id`, no sobre
-- `practice_id`: esta tabla ES la consulta.
-- =======================================================================================
CREATE POLICY practice_doctora_lee ON "practice" FOR SELECT TO app_doctora
  USING (id = medskin_practice_actual());--> statement-breakpoint
CREATE POLICY practice_doctora_edita ON "practice" FOR UPDATE TO app_doctora
  USING (id = medskin_practice_actual())
  WITH CHECK (id = medskin_practice_actual());--> statement-breakpoint
CREATE POLICY practice_plataforma ON "practice" FOR ALL TO app_plataforma
  USING (current_user = 'app_plataforma')
  WITH CHECK (current_user = 'app_plataforma');--> statement-breakpoint

-- `nota_interna` es «solo consola, nunca sale a la app»: fuera del SELECT de la doctora.
-- Un grant por columna lo cumple en la base; un `select *` descuidado no lo rompe.
GRANT SELECT (id, nombre, region, pais, zona_horaria, moneda, plan, limite_pacientes,
              plan_renueva_en, estado, direccion, ciudad, telefono, logo_url,
              primer_dia_datos_consulta, primer_dia_horarios,
              primer_dia_primer_tratamiento, primer_dia_cerrada, creado_en, actualizado_en)
  ON "practice" TO app_doctora;--> statement-breakpoint
-- Lo que la doctora puede cambiar: los datos de su consulta y su lista de primer día.
-- NO la región (§7.4: la decisión más cara de revertir), ni el plan, ni el límite, ni la
-- pausa, ni la nota interna.
GRANT UPDATE (nombre, direccion, ciudad, telefono, logo_url, zona_horaria,
              primer_dia_datos_consulta, primer_dia_horarios,
              primer_dia_primer_tratamiento, primer_dia_cerrada, actualizado_en)
  ON "practice" TO app_doctora;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "practice" TO app_plataforma;--> statement-breakpoint

-- =======================================================================================
-- licencia · política sobre `practice_id`. La doctora NO escribe `estado`: su UPDATE
-- cubre los campos del formulario y solo cuando el caso está `sin_enviar` o `rechazada`
-- (consultas.md · decision). El salto a `en_revision` y la decisión son de la plataforma
-- o de una función SECURITY DEFINER; por grant, desde aquí no se puede.
-- =======================================================================================
CREATE POLICY licencia_doctora_lee ON "licencia" FOR SELECT TO app_doctora
  USING (practice_id = medskin_practice_actual());--> statement-breakpoint
CREATE POLICY licencia_doctora_edita ON "licencia" FOR UPDATE TO app_doctora
  USING (practice_id = medskin_practice_actual() AND estado IN ('sin_enviar', 'rechazada'))
  WITH CHECK (practice_id = medskin_practice_actual());--> statement-breakpoint
CREATE POLICY licencia_plataforma ON "licencia" FOR ALL TO app_plataforma
  USING (current_user = 'app_plataforma')
  WITH CHECK (current_user = 'app_plataforma');--> statement-breakpoint

GRANT SELECT ON "licencia" TO app_doctora;--> statement-breakpoint
GRANT UPDATE (pais_ejercicio, especialidad, matricula, credencial_clave,
              declaracion_aceptada, terminos_aceptados, actualizado_en)
  ON "licencia" TO app_doctora;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "licencia" TO app_plataforma;--> statement-breakpoint

-- =======================================================================================
-- practitioner · política sobre `practice_id`. La paciente no tiene nada aquí.
-- =======================================================================================
CREATE POLICY practitioner_doctora ON "practitioner" FOR ALL TO app_doctora
  USING (practice_id = medskin_practice_actual())
  WITH CHECK (practice_id = medskin_practice_actual());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "practitioner" TO app_doctora;--> statement-breakpoint

-- =======================================================================================
-- cuenta · SIN practice_id. Aislamiento por FILA: `id = medskin_cuenta_actual()`.
--
-- La política vale para los dos roles de aplicación, y eso resuelve una contradicción de
-- los contratos: `cuentas.md` dice que `app_doctora` no tiene política de SELECT sobre
-- `cuenta`, pero `GET /v1/cuentas/mia` está abierto a «doctora, equipo y paciente». Lo
-- que esa frase protege se cumple igual: la única fila legible es la de quien pregunta,
-- así que la doctora no puede buscar en la tabla ni comprobar si un correo existe, que es
-- justo el oráculo del padrón de otra clínica que había que cerrar. Lo que ve de su
-- paciente lo ve en `patient_link` (tramo 2), que sí lleva `practice_id`.
-- Anotado como pregunta abierta para `producto`.
-- =======================================================================================
CREATE POLICY cuenta_propia ON "cuenta" FOR ALL TO app_doctora, app_paciente
  USING (id = medskin_cuenta_actual())
  WITH CHECK (id = medskin_cuenta_actual());--> statement-breakpoint
CREATE POLICY cuenta_plataforma ON "cuenta" FOR ALL TO app_plataforma
  USING (current_user = 'app_plataforma')
  WITH CHECK (current_user = 'app_plataforma');--> statement-breakpoint

GRANT SELECT (id, correo, rol, region, nombre, apellido, celular, estado, pausa_hasta,
              intentos_fallidos, borrado_en, creado_en)
  ON "cuenta" TO app_doctora, app_paciente;--> statement-breakpoint
GRANT UPDATE (correo, celular, nombre, apellido, estado, borrado_en, motivo_borrado,
              actualizado_en)
  ON "cuenta" TO app_doctora, app_paciente;--> statement-breakpoint
-- La consola ve «correo, rol, estado y pausa», literal (_convenciones.md). Ni nombre, ni
-- apellido, ni celular, ni región: no los necesita para reenviar un acceso ni para
-- levantar una pausa, y lo que no se puede leer no se filtra.
GRANT SELECT (id, correo, rol, estado, pausa_hasta) ON "cuenta" TO app_plataforma;--> statement-breakpoint
GRANT INSERT (id, correo, rol, region, nombre, apellido, celular, estado)
  ON "cuenta" TO app_plataforma;--> statement-breakpoint
-- Suspender, y «levantar la pausa por intentos · No cambia su contraseña»: eso es todo.
GRANT UPDATE (estado, pausa_hasta, intentos_fallidos, actualizado_en)
  ON "cuenta" TO app_plataforma;--> statement-breakpoint

-- =======================================================================================
-- credencial · política sobre `cuenta_id`. El hash se puede ESCRIBIR y no se puede LEER:
-- no hay `GRANT SELECT (hash)` para nadie. Así «el hash nunca sale de la base» deja de
-- ser una promesa del código y pasa a ser un permiso que no existe, y la comparación solo
-- puede ser la función SECURITY DEFINER que dicen `acceso.md` y `cuentas.md`.
-- La plataforma no tiene política: soporte no toca `credencial`, lo promete la pantalla.
-- =======================================================================================
CREATE POLICY credencial_propia ON "credencial" FOR ALL TO app_doctora, app_paciente
  USING (cuenta_id = medskin_cuenta_actual())
  WITH CHECK (cuenta_id = medskin_cuenta_actual());--> statement-breakpoint
GRANT SELECT (id, cuenta_id, es_temporal, temporal_caduca_en, temporal_usada_en,
              establecida_en, creado_en, actualizado_en)
  ON "credencial" TO app_doctora, app_paciente;--> statement-breakpoint
GRANT INSERT (id, cuenta_id, hash, es_temporal, temporal_caduca_en, establecida_en)
  ON "credencial" TO app_doctora, app_paciente;--> statement-breakpoint
GRANT UPDATE (hash, es_temporal, temporal_caduca_en, temporal_usada_en, establecida_en,
              actualizado_en)
  ON "credencial" TO app_doctora, app_paciente;--> statement-breakpoint
GRANT DELETE ON "credencial" TO app_doctora, app_paciente;--> statement-breakpoint

-- =======================================================================================
-- sesion · política sobre `cuenta_id`. Una doctora NO ve las sesiones de sus pacientes:
-- `sesion` no lleva consulta que la habilite y no hay política que se lo dé. Saber
-- cuándo y desde dónde entra su paciente no es parte de atenderla (acceso.md).
-- La plataforma tampoco: no hay política para `app_plataforma`.
-- =======================================================================================
CREATE POLICY sesion_propia ON "sesion" FOR ALL TO app_doctora, app_paciente
  USING (cuenta_id = medskin_cuenta_actual())
  WITH CHECK (cuenta_id = medskin_cuenta_actual());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "sesion" TO app_doctora, app_paciente;--> statement-breakpoint

-- =======================================================================================
-- codigo_recuperacion · «ningún rol de aplicación lee esta tabla nunca» (recuperacion.md).
-- La política sobre `cuenta_id` queda escrita porque el contrato la nombra, pero NO hay un
-- solo GRANT: ni para app_paciente, ni para app_doctora, ni para app_plataforma. La única
-- vía es la función SECURITY DEFINER que compara y devuelve un booleano más el contador.
-- Ni la doctora, ni la plataforma, ni soporte pueden leer un código: no por un filtro en
-- el código del endpoint, sino porque no hay permiso que lo permita.
-- =======================================================================================
CREATE POLICY codigo_recuperacion_propio ON "codigo_recuperacion" FOR ALL TO app_paciente
  USING (cuenta_id = medskin_cuenta_actual())
  WITH CHECK (cuenta_id = medskin_cuenta_actual());--> statement-breakpoint

-- =======================================================================================
-- clave_idempotencia · «la consulta de quien llama» (§3.3): `practice_id` para la
-- doctora, `cuenta_id` para la paciente y para la consola. La clave la pone el cliente y
-- la clave primaria la encierra por cuenta, así que dentro de una consulta el filtro por
-- consulta es suficiente y es el que usa el índice que empieza por `practice_id`.
-- La consola la necesita porque `POST /v1/plataforma/consultas` es idempotente; su
-- política es la misma regla por fila, no un permiso más ancho.
-- =======================================================================================
CREATE POLICY clave_idempotencia_doctora ON "clave_idempotencia" FOR ALL TO app_doctora
  USING (practice_id = medskin_practice_actual())
  WITH CHECK (practice_id = medskin_practice_actual());--> statement-breakpoint
CREATE POLICY clave_idempotencia_paciente ON "clave_idempotencia" FOR ALL TO app_paciente
  USING (practice_id IS NULL AND cuenta_id = medskin_cuenta_actual())
  WITH CHECK (practice_id IS NULL AND cuenta_id = medskin_cuenta_actual());--> statement-breakpoint
CREATE POLICY clave_idempotencia_plataforma ON "clave_idempotencia" FOR ALL TO app_plataforma
  USING (current_user = 'app_plataforma' AND cuenta_id = medskin_cuenta_actual())
  WITH CHECK (current_user = 'app_plataforma' AND cuenta_id = medskin_cuenta_actual());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "clave_idempotencia"
  TO app_doctora, app_paciente, app_plataforma;--> statement-breakpoint

-- =======================================================================================
-- service_failure · la consola lo lee todo; la doctora, solo lo que la afecta (§10.4).
-- La paciente, nada.
-- La política de INSERT no filtra: §10.3, regla 6 dice que el registro de fallos no puede
-- ser el punto único de falla, y una política que rechace la escritura convierte un fallo
-- en dos. Lo que se gana permitiéndola es registro; lo que se podría perder es nada: no
-- hay dato clínico aquí, y meter ruido en la bitácora de fallos no abre ninguna fila.
-- =======================================================================================
CREATE POLICY service_failure_escribe ON "service_failure" FOR INSERT
  TO app_doctora, app_paciente, app_plataforma
  WITH CHECK (true);--> statement-breakpoint
CREATE POLICY service_failure_doctora_lee ON "service_failure" FOR SELECT TO app_doctora
  USING (practice_id = medskin_practice_actual());--> statement-breakpoint
CREATE POLICY service_failure_plataforma ON "service_failure" FOR ALL TO app_plataforma
  USING (current_user = 'app_plataforma')
  WITH CHECK (current_user = 'app_plataforma');--> statement-breakpoint
GRANT INSERT ON "service_failure" TO app_doctora, app_paciente, app_plataforma;--> statement-breakpoint
GRANT SELECT ON "service_failure" TO app_doctora, app_plataforma;--> statement-breakpoint
-- Lo único que se reescribe es el ciclo de vida, y solo desde la consola.
GRANT UPDATE (resolved_at, resolution) ON "service_failure" TO app_plataforma;--> statement-breakpoint
GRANT USAGE ON SEQUENCE "service_failure_id_seq"
  TO app_doctora, app_paciente, app_plataforma;--> statement-breakpoint

-- =======================================================================================
-- acceso_auditoria · inmutable por dos vías a la vez: no hay política de UPDATE ni de
-- DELETE para ningún rol, y tampoco hay GRANT de UPDATE ni de DELETE para ninguno. Una
-- bitácora que se puede reescribir no es una bitácora.
-- =======================================================================================
CREATE POLICY acceso_auditoria_escribe ON "acceso_auditoria" FOR INSERT
  TO app_doctora, app_paciente, app_plataforma
  WITH CHECK (true);--> statement-breakpoint
CREATE POLICY acceso_auditoria_doctora_lee ON "acceso_auditoria" FOR SELECT TO app_doctora
  USING (practice_id = medskin_practice_actual());--> statement-breakpoint
CREATE POLICY acceso_auditoria_plataforma_lee ON "acceso_auditoria" FOR SELECT TO app_plataforma
  USING (current_user = 'app_plataforma');--> statement-breakpoint
GRANT INSERT ON "acceso_auditoria" TO app_doctora, app_paciente, app_plataforma;--> statement-breakpoint
GRANT SELECT ON "acceso_auditoria" TO app_doctora, app_plataforma;--> statement-breakpoint
GRANT USAGE ON SEQUENCE "acceso_auditoria_id_seq"
  TO app_doctora, app_paciente, app_plataforma;
