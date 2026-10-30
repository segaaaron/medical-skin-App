-- =======================================================================================
-- TRAMO 3 · EL CATÁLOGO DE LA CONSULTA · `tratamientos.md`
--
-- Nueve tablas, todas de consulta, todas con `FORCE ROW LEVEL SECURITY` y política sobre
-- `practice_id`, y `practice_id` primera columna de todo índice compuesto (§7.3, regla 5).
--
-- LAS DOS DECISIONES DEL CONTRATO, HECHAS ESQUEMA:
--
-- 1 · EL DINERO SON ENTEROS. Todo importe es `integer` en centavos, y la moneda NO se guarda
--     por fila: sale de `practice.currency`. Una consulta tiene una moneda, y un precio en
--     otra moneda es un error de programación, no una opción. Por eso no hay columna
--     `currency` en `price` ni en `promotion`: no se puede escribir la equivocada.
--
-- 2 · LA REGLA CLÍNICA MANDA SOBRE LA COMERCIAL. `treatment.min_interval_days` y
--     `treatment_contraindication` existen para que el servidor pueda negar un tratamiento a
--     una paciente concreta, y la clave de la contraindicación es CERRADA (`CHECK`) porque es
--     lo que se cruza contra `medical_history`: texto libre sería una contraindicación que
--     nadie puede comprobar.
--
-- LO QUE NO SE BORRA, PORQUE LO REFERENCIAN LAS SESIONES Y LOS COBROS: un tratamiento se
-- archiva (`status`) y una promoción se despublica (`published`). Borrarlos dejaría sesiones
-- registradas sin decir de qué fueron y un informe de noviembre sin poder decir cuánto costó
-- la campaña.
--
-- `product` ENTRA AQUÍ EN MÍNIMO, y su CRUD es del tramo 8: `treatment_supply` necesita la
-- clave foránea para que el margen del tramo 8 salga sin que nadie escriba un costo a mano.
-- Tres columnas y su política; el stock, los lotes y el costo vienen después.
--
-- LA PACIENTE LEE EL CATÁLOGO, Y SU POLÍTICA NO ES POR INQUILINO. `app_patient` no tiene
-- contexto de consulta: su política en estas tablas es «existe un vínculo MÍO y ACEPTADO con
-- esa consulta», que es autoverificable. Así el `practice_id` del parámetro solo elige cuál de
-- sus vínculos, y uno que no sea suyo no devuelve ninguna fila.
-- =======================================================================================

CREATE TABLE "product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"name" text NOT NULL,
	"unit" text DEFAULT 'unidad' NOT NULL,
	"status" text DEFAULT 'activo' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_status_ck" CHECK ("product"."status" in ('activo', 'archivado')),
	CONSTRAINT "product_name_ck" CHECK (length(btrim("product"."name")) between 2 and 120)
);
--> statement-breakpoint
CREATE TABLE "treatment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"description" text,
	"duration_minutes" integer NOT NULL,
	"planned_sessions" integer DEFAULT 1 NOT NULL,
	"min_interval_days" integer,
	"requires_consent" boolean DEFAULT false NOT NULL,
	"visible_to_patients" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'activo' NOT NULL,
	"applied_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treatment_name_ck" CHECK (length(btrim("treatment"."name")) between 2 and 120),
	CONSTRAINT "treatment_category_ck" CHECK ("treatment"."category" in
		('toxina', 'relleno', 'peeling', 'laser', 'aparatologia', 'hilos',
		 'mesoterapia', 'limpieza', 'valoracion', 'otro')),
	CONSTRAINT "treatment_duration_ck" CHECK ("treatment"."duration_minutes" between 5 and 480),
	CONSTRAINT "treatment_sessions_ck" CHECK ("treatment"."planned_sessions" between 1 and 20),
	CONSTRAINT "treatment_status_ck" CHECK ("treatment"."status" in ('activo', 'archivado')),
	-- `intervalo_minimo_dias` «no es un adorno comercial: es la regla clínica». Obligatorio en
	-- todo tratamiento que se repita, y no admite 0 con más de una sesión prevista.
	CONSTRAINT "treatment_interval_ck" CHECK (
		"treatment"."planned_sessions" = 1
		or ("treatment"."min_interval_days" is not null and "treatment"."min_interval_days" > 0))
);
--> statement-breakpoint
CREATE TABLE "treatment_supply" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"treatment_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"units" integer NOT NULL,
	CONSTRAINT "treatment_supply_units_ck" CHECK ("treatment_supply"."units" > 0)
);
--> statement-breakpoint
CREATE TABLE "treatment_protocol_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"treatment_id" uuid NOT NULL,
	"moment" text NOT NULL,
	"offset_hours" integer NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "protocol_step_moment_ck" CHECK ("treatment_protocol_step"."moment" in ('antes', 'despues')),
	CONSTRAINT "protocol_step_text_ck" CHECK (length(btrim("treatment_protocol_step"."text")) > 0),
	-- «Un paso de antes va con horas negativas y uno de después con positivas.» El `CHECK` es
	-- lo que lo hace verdad aunque alguien escriba por otra puerta.
	CONSTRAINT "protocol_step_offset_ck" CHECK (
		("treatment_protocol_step"."moment" = 'antes' and "treatment_protocol_step"."offset_hours" < 0)
		or ("treatment_protocol_step"."moment" = 'despues' and "treatment_protocol_step"."offset_hours" >= 0))
);
--> statement-breakpoint
-- El semáforo: «qué es normal el día 1, el 3 y el 7, y cuándo sí hay que llamar». Es del
-- TRATAMIENTO y no de la paciente: se escribe una vez y sirve para todas.
CREATE TABLE "treatment_traffic_light" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"treatment_id" uuid NOT NULL,
	"day" integer NOT NULL,
	"normal" text NOT NULL,
	"call_if" text NOT NULL,
	CONSTRAINT "traffic_light_day_ck" CHECK ("treatment_traffic_light"."day" between 0 and 90)
);
--> statement-breakpoint
CREATE TABLE "treatment_contraindication" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"treatment_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text,
	"absolute" boolean DEFAULT true NOT NULL,
	-- Cerrada a propósito: es lo que el servidor cruza contra `medical_history`.
	CONSTRAINT "contraindication_key_ck" CHECK ("treatment_contraindication"."key" in
		('embarazo', 'lactancia', 'alergia', 'medicacion', 'antecedente',
		 'fototipo_mayor_que', 'fototipo_menor_que', 'edad_menor_que')),
	-- Las cinco que no se pueden comprobar sin un valor lo exigen; `embarazo` y `lactancia` no.
	CONSTRAINT "contraindication_value_ck" CHECK (
		"treatment_contraindication"."key" in ('embarazo', 'lactancia')
		or ("treatment_contraindication"."value" is not null
		    and length(btrim("treatment_contraindication"."value")) > 0))
);
--> statement-breakpoint
CREATE TABLE "price" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"treatment_id" uuid NOT NULL,
	-- `NULL` es el precio base, y es obligatorio: un tratamiento sin base no se ofrece. Lo
	-- garantiza el índice único parcial de abajo, no una regla del código.
	"zone" text,
	"cents" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_cents_ck" CHECK ("price"."cents" >= 0),
	-- El mismo catálogo anatómico que usará `application_point` en el tramo 5, para que el
	-- margen de una sesión se calcule sin traducir nombres.
	CONSTRAINT "price_zone_ck" CHECK ("price"."zone" is null or "price"."zone" in
		('frente', 'entrecejo', 'patas_de_gallo', 'tercio_superior', 'tercio_medio',
		 'tercio_inferior', 'surcos_nasogenianos', 'labios', 'menton', 'cuello',
		 'escote', 'manos', 'cara_completa', 'otra'))
);
--> statement-breakpoint
CREATE TABLE "promotion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"name" text NOT NULL,
	"discount_type" text NOT NULL,
	"discount_value" integer NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"quota" integer,
	"redeemed" integer DEFAULT 0 NOT NULL,
	"code" text,
	"segment_key" text DEFAULT 'todas' NOT NULL,
	"segment_value" integer,
	"stackable" boolean DEFAULT false NOT NULL,
	"published" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_name_ck" CHECK (length(btrim("promotion"."name")) between 2 and 120),
	CONSTRAINT "promotion_discount_type_ck" CHECK ("promotion"."discount_type" in ('porcentaje', 'monto')),
	-- «Un descuento va del 1 % al 90 %», y un monto es centavos positivos.
	CONSTRAINT "promotion_discount_value_ck" CHECK (
		("promotion"."discount_type" = 'porcentaje' and "promotion"."discount_value" between 1 and 90)
		or ("promotion"."discount_type" = 'monto' and "promotion"."discount_value" > 0)),
	CONSTRAINT "promotion_window_ck" CHECK ("promotion"."ends_on" >= "promotion"."starts_on"),
	CONSTRAINT "promotion_quota_ck" CHECK ("promotion"."quota" is null or "promotion"."quota" > 0),
	-- El cupo se descuenta al canjear: nunca se pasa de lo que hay.
	CONSTRAINT "promotion_redeemed_ck" CHECK (
		"promotion"."redeemed" >= 0
		and ("promotion"."quota" is null or "promotion"."redeemed" <= "promotion"."quota")),
	CONSTRAINT "promotion_segment_ck" CHECK ("promotion"."segment_key" in
		('nueva', 'inactiva_meses', 'cumpleanos', 'por_vencer', 'todas')),
	CONSTRAINT "promotion_segment_value_ck" CHECK (
		"promotion"."segment_key" <> 'inactiva_meses' or "promotion"."segment_value" is not null)
);
--> statement-breakpoint
-- Qué tratamientos cubre una promoción. Sin filas = todo el catálogo visible.
CREATE TABLE "promotion_treatment" (
	"promotion_id" uuid NOT NULL,
	"treatment_id" uuid NOT NULL,
	"practice_id" uuid NOT NULL,
	CONSTRAINT "promotion_treatment_pk" PRIMARY KEY ("promotion_id", "treatment_id")
);
--> statement-breakpoint

-- =======================================================================================
-- CLAVES FORÁNEAS · todo cuelga de la consulta y se va con ella
-- =======================================================================================
ALTER TABLE "product" ADD CONSTRAINT "product_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "treatment" ADD CONSTRAINT "treatment_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "treatment_supply" ADD CONSTRAINT "treatment_supply_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "treatment_supply" ADD CONSTRAINT "treatment_supply_treatment_fk" FOREIGN KEY ("treatment_id") REFERENCES "public"."treatment"("id") ON DELETE cascade;--> statement-breakpoint
-- `restrict` y no `cascade`: borrar un producto que un tratamiento consume tiene que doler.
ALTER TABLE "treatment_supply" ADD CONSTRAINT "treatment_supply_product_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "treatment_protocol_step" ADD CONSTRAINT "protocol_step_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "treatment_protocol_step" ADD CONSTRAINT "protocol_step_treatment_fk" FOREIGN KEY ("treatment_id") REFERENCES "public"."treatment"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "treatment_traffic_light" ADD CONSTRAINT "traffic_light_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "treatment_traffic_light" ADD CONSTRAINT "traffic_light_treatment_fk" FOREIGN KEY ("treatment_id") REFERENCES "public"."treatment"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "treatment_contraindication" ADD CONSTRAINT "contraindication_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "treatment_contraindication" ADD CONSTRAINT "contraindication_treatment_fk" FOREIGN KEY ("treatment_id") REFERENCES "public"."treatment"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "price" ADD CONSTRAINT "price_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "price" ADD CONSTRAINT "price_treatment_fk" FOREIGN KEY ("treatment_id") REFERENCES "public"."treatment"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "promotion_treatment" ADD CONSTRAINT "promotion_treatment_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "promotion_treatment" ADD CONSTRAINT "promotion_treatment_promotion_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotion"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "promotion_treatment" ADD CONSTRAINT "promotion_treatment_treatment_fk" FOREIGN KEY ("treatment_id") REFERENCES "public"."treatment"("id") ON DELETE cascade;--> statement-breakpoint

-- =======================================================================================
-- ÍNDICES · `practice_id` primero, y `DESC NULLS FIRST` LITERAL donde se ordena
--
-- `.desc()` de drizzle emite `DESC NULLS LAST` y `order by x desc` significa
-- `DESC NULLS FIRST`: para el planificador son dos ordenaciones distintas y el índice deja de
-- servir para el `ORDER BY`. Escrito a mano y comprobado (lección de la 0011).
-- =======================================================================================
CREATE INDEX "product_practice_idx" ON "product" USING btree ("practice_id", "status", "name");--> statement-breakpoint
CREATE INDEX "treatment_practice_idx" ON "treatment" USING btree ("practice_id", "status", "created_at" DESC NULLS FIRST);--> statement-breakpoint
-- «Ya tienes un tratamiento con ese nombre»: el `409` lo garantiza el índice, no una lectura
-- previa, y SOLO entre los activos —un archivado no reserva su nombre para siempre—.
CREATE UNIQUE INDEX "treatment_practice_name_uq" ON "treatment" USING btree ("practice_id", lower(btrim("name"))) WHERE "status" = 'activo';--> statement-breakpoint
CREATE INDEX "treatment_supply_treatment_idx" ON "treatment_supply" USING btree ("practice_id", "treatment_id");--> statement-breakpoint
CREATE INDEX "treatment_supply_product_idx" ON "treatment_supply" USING btree ("practice_id", "product_id");--> statement-breakpoint
CREATE INDEX "protocol_step_treatment_idx" ON "treatment_protocol_step" USING btree ("practice_id", "treatment_id", "moment", "offset_hours");--> statement-breakpoint
-- Un día repetido es el `400 semaforo_dia_repetido`, y lo garantiza el índice.
CREATE UNIQUE INDEX "traffic_light_day_uq" ON "treatment_traffic_light" USING btree ("practice_id", "treatment_id", "day");--> statement-breakpoint
CREATE INDEX "contraindication_treatment_idx" ON "treatment_contraindication" USING btree ("practice_id", "treatment_id");--> statement-breakpoint
-- Un precio por tratamiento y zona. Dos índices porque `NULL` no se compara en un único:
-- el parcial es el que hace que el precio BASE sea uno solo.
CREATE UNIQUE INDEX "price_zone_uq" ON "price" USING btree ("practice_id", "treatment_id", "zone") WHERE "zone" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "price_base_uq" ON "price" USING btree ("practice_id", "treatment_id") WHERE "zone" is null;--> statement-breakpoint
CREATE INDEX "promotion_practice_idx" ON "promotion" USING btree ("practice_id", "published", "ends_on" DESC NULLS FIRST);--> statement-breakpoint
-- «Ya tienes una promoción con ese código»: único entre las publicadas de la consulta.
CREATE UNIQUE INDEX "promotion_code_uq" ON "promotion" USING btree ("practice_id", upper(btrim("code"))) WHERE "code" is not null and "published";--> statement-breakpoint
CREATE INDEX "promotion_treatment_idx" ON "promotion_treatment" USING btree ("practice_id", "treatment_id");--> statement-breakpoint

-- =======================================================================================
-- RLS · FORZADA EN LAS NUEVE, Y LAS DOS CARAS DE CADA UNA
--
-- `app_practitioner`: por `practice_id` del contexto, que es el de su sesión.
-- `app_patient`: NO por consulta —no tiene contexto de consulta— sino por «existe un vínculo
-- mío y aceptado con esa consulta». Es autoverificable: el parámetro del catálogo solo elige
-- cuál de sus vínculos, y uno que no sea suyo no devuelve ninguna fila.
-- `app_platform`: NINGUNA política. Soporte no lee el catálogo ni los precios de nadie.
-- =======================================================================================
ALTER TABLE "product" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "treatment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "treatment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "treatment_supply" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "treatment_supply" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "treatment_protocol_step" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "treatment_protocol_step" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "treatment_traffic_light" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "treatment_traffic_light" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "treatment_contraindication" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "treatment_contraindication" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "price" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "price" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "promotion" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "promotion" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "promotion_treatment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "promotion_treatment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY product_practitioner ON "product" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY treatment_practitioner ON "treatment" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY treatment_supply_practitioner ON "treatment_supply" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY protocol_step_practitioner ON "treatment_protocol_step" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY traffic_light_practitioner ON "treatment_traffic_light" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY contraindication_practitioner ON "treatment_contraindication" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY price_practitioner ON "price" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY promotion_practitioner ON "promotion" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY promotion_treatment_practitioner ON "promotion_treatment" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint

-- La paciente: SOLO LECTURA, y solo de las consultas que ella aceptó. `product` y
-- `treatment_supply` quedan fuera a propósito: lo que lleva dentro un tratamiento es del
-- inventario de la doctora, no del catálogo de la paciente.
CREATE POLICY treatment_patient_select ON "treatment" FOR SELECT TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.practice_id = treatment.practice_id
                    AND l.account_id = medskin_current_account()
                    AND l.status = 'vinculada'));--> statement-breakpoint
CREATE POLICY price_patient_select ON "price" FOR SELECT TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.practice_id = price.practice_id
                    AND l.account_id = medskin_current_account()
                    AND l.status = 'vinculada'));--> statement-breakpoint
CREATE POLICY promotion_patient_select ON "promotion" FOR SELECT TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.practice_id = promotion.practice_id
                    AND l.account_id = medskin_current_account()
                    AND l.status = 'vinculada'));--> statement-breakpoint
CREATE POLICY promotion_treatment_patient_select ON "promotion_treatment" FOR SELECT TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.practice_id = promotion_treatment.practice_id
                    AND l.account_id = medskin_current_account()
                    AND l.status = 'vinculada'));--> statement-breakpoint
-- Las contraindicaciones las lee la paciente SOLO para que el servidor calcule `disponible`
-- en su propia transacción; su contenido NO viaja en ninguna respuesta suya (`tratamientos.md`:
-- «un tratamiento contraindicado se muestra sin motivo»).
CREATE POLICY contraindication_patient_select ON "treatment_contraindication" FOR SELECT TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.practice_id = treatment_contraindication.practice_id
                    AND l.account_id = medskin_current_account()
                    AND l.status = 'vinculada'));--> statement-breakpoint

-- =======================================================================================
-- PRIVILEGIOS · un `GRANT` por columna no hace falta aquí: ninguna de estas tablas guarda
-- dato clínico de una persona ni una credencial. Lo que confina es la política.
-- =======================================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON "treatment_supply" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "treatment_protocol_step" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "treatment_traffic_light" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "treatment_contraindication" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "price" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "promotion_treatment" TO app_practitioner;--> statement-breakpoint
-- Sin `DELETE` en las tres que la historia referencia: se archiva y se despublica.
GRANT SELECT, INSERT, UPDATE ON "treatment" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "promotion" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "product" TO app_practitioner;--> statement-breakpoint

GRANT SELECT ON "treatment" TO app_patient;--> statement-breakpoint
GRANT SELECT ON "price" TO app_patient;--> statement-breakpoint
GRANT SELECT ON "promotion" TO app_patient;--> statement-breakpoint
GRANT SELECT ON "promotion_treatment" TO app_patient;--> statement-breakpoint
GRANT SELECT ON "treatment_contraindication" TO app_patient;
