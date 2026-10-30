-- =======================================================================================
-- TRAMO 7 · CUIDADOS, MENSAJES Y AVISOS · `cuidados.md`
--
-- LAS TRES DECISIONES DEL CONTRATO, HECHAS ESQUEMA:
--
-- 1 · UN PUSH NUNCA LLEVA CONTENIDO CLÍNICO (§11.1). Por eso `message` guarda el texto y
--     `device` solo el token: el push lleva un identificador y un texto neutro, y la app —ya
--     autenticada y desbloqueada— pide el contenido a la API. «Un push con el nombre de un
--     tratamiento es un motivo de rechazo de la tienda, no un descuido de redacción.»
--
-- 2 · UN TOKEN POR DISPOSITIVO, NO UNO POR CUENTA (§11.2). Una doctora con teléfono y tableta
--     recibe en los dos, y la higiene de tokens no es opcional: con un 30 % de tokens muertos
--     la tasa de error dispara el estrangulamiento del proveedor y se lleva por delante los
--     avisos importantes. De ahí `last_seen_at` y `failures`.
--
-- 3 · EL PLAN DE CUIDADOS SE COPIA AL FIRMAR, no se enlaza al protocolo. `care_step.text` es
--     una copia y `appears_at` un instante ya calculado: «cambiar el protocolo no mueve lo que
--     ya se le mandó, y una paciente no ve cambiar instrucciones que ya cumplió».
--
-- Y UN CUIDADO CUMPLIDO NO SE DESMARCA: no hay `DELETE` sobre `care_step.done_at` para nadie.
-- «Un botón de deshacer convierte el dato en una opinión.»
-- =======================================================================================
CREATE TABLE "care_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	-- Copias, como en `patient_link`: la paciente no lee `practice` ni `treatment`.
	"practice_name" text NOT NULL,
	"treatment_name" text NOT NULL,
	"session_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "care_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	-- El instante YA CALCULADO con el desfase del protocolo copiado al firmar.
	"appears_at" timestamp with time zone NOT NULL,
	"text" text NOT NULL,
	"done_at" timestamp with time zone,
	-- El instante que vale es el que la app registró, no el de la llegada al servidor: se puede
	-- marcar sin conexión y la bandeja de salida lo manda después.
	"done_reported_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "incident" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"what" text NOT NULL,
	"since" date,
	"perceived" text NOT NULL,
	"status" text DEFAULT 'recibida' NOT NULL,
	-- La incidencia NO es un evento adverso hasta que la doctora lo decida: lo que la paciente
	-- reporta es un síntoma, y convertirlo en diagnóstico sería inventar una valoración clínica.
	"adverse_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_perceived_ck" CHECK ("incident"."perceived" in
		('leve', 'me_preocupa', 'urgente')),
	CONSTRAINT "incident_status_ck" CHECK ("incident"."status" in
		('recibida', 'vista', 'resuelta')),
	CONSTRAINT "incident_what_ck" CHECK (length(btrim("incident"."what")) > 0)
);
--> statement-breakpoint
CREATE TABLE "incident_photo" (
	"incident_id" uuid NOT NULL,
	"photo_id" uuid NOT NULL,
	"practice_id" uuid NOT NULL,
	CONSTRAINT "incident_photo_pk" PRIMARY KEY ("incident_id", "photo_id")
);
--> statement-breakpoint
-- «Un hilo es `patient_link` ↔ consulta.» No hay mensajes entre pacientes y no va a haberlos.
CREATE TABLE "message_thread" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"closed_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"author" text NOT NULL,
	"author_account_id" uuid,
	"body" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_author_ck" CHECK ("message"."author" in ('paciente', 'consulta')),
	CONSTRAINT "message_body_ck" CHECK (length(btrim("message"."body")) between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"app_version" text,
	"permission" text DEFAULT 'concedido' NOT NULL,
	-- La higiene: un token que falla se cuenta, y a los tres se deja de usar. Con 30 % de
	-- tokens muertos la tasa de error pasa del 1 % al 30 % y el proveedor estrangula al
	-- remitente, lo que se lleva por delante también los avisos importantes.
	"failures" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_platform_ck" CHECK ("device"."platform" in ('ios', 'android')),
	CONSTRAINT "device_permission_ck" CHECK ("device"."permission" in
		('concedido', 'denegado', 'no_preguntado'))
);
--> statement-breakpoint
CREATE TABLE "alert_preference" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	-- Por TIPO de aviso, y los que no se pueden apagar no están aquí: un recordatorio de cita y
	-- una respuesta de la doctora no son marketing.
	"appointment_reminders" boolean DEFAULT true NOT NULL,
	"care_reminders" boolean DEFAULT true NOT NULL,
	"promotions" boolean DEFAULT true NOT NULL,
	"quiet_from" time,
	"quiet_to" time,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "care_plan" ADD CONSTRAINT "care_plan_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "care_plan" ADD CONSTRAINT "care_plan_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "care_plan" ADD CONSTRAINT "care_plan_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."clinical_session"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "care_step" ADD CONSTRAINT "care_step_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "care_step" ADD CONSTRAINT "care_step_plan_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."care_plan"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."clinical_session"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_adverse_fk" FOREIGN KEY ("adverse_event_id") REFERENCES "public"."adverse_event"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "incident_photo" ADD CONSTRAINT "incident_photo_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "incident_photo" ADD CONSTRAINT "incident_photo_incident_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incident"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "incident_photo" ADD CONSTRAINT "incident_photo_photo_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photo"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "message_thread" ADD CONSTRAINT "message_thread_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "message_thread" ADD CONSTRAINT "message_thread_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_thread_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."message_thread"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "alert_preference" ADD CONSTRAINT "alert_preference_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade;--> statement-breakpoint

CREATE INDEX "care_plan_patient_idx" ON "care_plan" USING btree ("practice_id", "patient_id", "session_at" DESC NULLS FIRST);--> statement-breakpoint
-- Los pasos en orden de reloj: es como se leen y como se agendan los avisos locales.
CREATE INDEX "care_step_plan_idx" ON "care_step" USING btree ("practice_id", "plan_id", "appears_at");--> statement-breakpoint
CREATE INDEX "incident_practice_idx" ON "incident" USING btree ("practice_id", "status", "created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "message_thread_uq" ON "message_thread" USING btree ("practice_id", "patient_id");--> statement-breakpoint
CREATE INDEX "message_thread_cursor_idx" ON "message" USING btree ("practice_id", "thread_id", "created_at" DESC NULLS FIRST);--> statement-breakpoint
-- Un token por dispositivo y por cuenta: volver a registrar el mismo lo refresca, no lo duplica.
CREATE UNIQUE INDEX "device_account_uq" ON "device" USING btree ("account_id", "device_id");--> statement-breakpoint
CREATE INDEX "device_token_idx" ON "device" USING btree ("token");--> statement-breakpoint

ALTER TABLE "care_plan" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "care_plan" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "care_step" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "care_step" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incident" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incident" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incident_photo" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incident_photo" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_thread" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_thread" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "device" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "device" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alert_preference" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alert_preference" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY care_plan_practitioner ON "care_plan" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY care_step_practitioner ON "care_step" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY incident_practitioner ON "incident" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY incident_photo_practitioner ON "incident_photo" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY message_thread_practitioner ON "message_thread" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY message_practitioner ON "message" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint

-- La paciente: SU plan, SUS pasos, SUS incidencias y SU hilo. Dos doctoras que la atienden
-- tienen dos planes y dos hilos QUE NO SE VEN ENTRE SÍ: es §12.2.1, y en un chat importa más.
CREATE POLICY care_plan_patient ON "care_plan" FOR SELECT TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.patient_id = care_plan.patient_id
                    AND l.account_id = medskin_current_account() AND l.status = 'vinculada'));--> statement-breakpoint
CREATE POLICY care_step_patient_select ON "care_step" FOR SELECT TO app_patient
  USING (EXISTS (SELECT 1 FROM care_plan p JOIN patient_link l ON l.patient_id = p.patient_id
                  WHERE p.id = care_step.plan_id
                    AND l.account_id = medskin_current_account() AND l.status = 'vinculada'));--> statement-breakpoint
CREATE POLICY care_step_patient_update ON "care_step" FOR UPDATE TO app_patient
  USING (EXISTS (SELECT 1 FROM care_plan p JOIN patient_link l ON l.patient_id = p.patient_id
                  WHERE p.id = care_step.plan_id
                    AND l.account_id = medskin_current_account() AND l.status = 'vinculada'))
  WITH CHECK (true);--> statement-breakpoint
CREATE POLICY incident_patient ON "incident" FOR ALL TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.patient_id = incident.patient_id
                    AND l.account_id = medskin_current_account() AND l.status = 'vinculada'))
  WITH CHECK (EXISTS (SELECT 1 FROM patient_link l
                       WHERE l.patient_id = incident.patient_id
                         AND l.account_id = medskin_current_account()
                         AND l.status = 'vinculada'));--> statement-breakpoint
CREATE POLICY incident_photo_patient ON "incident_photo" FOR ALL TO app_patient
  USING (EXISTS (SELECT 1 FROM incident i JOIN patient_link l ON l.patient_id = i.patient_id
                  WHERE i.id = incident_photo.incident_id
                    AND l.account_id = medskin_current_account() AND l.status = 'vinculada'))
  WITH CHECK (true);--> statement-breakpoint
CREATE POLICY message_thread_patient ON "message_thread" FOR ALL TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.patient_id = message_thread.patient_id
                    AND l.account_id = medskin_current_account() AND l.status = 'vinculada'))
  WITH CHECK (EXISTS (SELECT 1 FROM patient_link l
                       WHERE l.patient_id = message_thread.patient_id
                         AND l.account_id = medskin_current_account()
                         AND l.status = 'vinculada'));--> statement-breakpoint
CREATE POLICY message_patient ON "message" FOR ALL TO app_patient
  USING (EXISTS (SELECT 1 FROM message_thread t JOIN patient_link l ON l.patient_id = t.patient_id
                  WHERE t.id = message.thread_id
                    AND l.account_id = medskin_current_account() AND l.status = 'vinculada'))
  WITH CHECK (EXISTS (SELECT 1 FROM message_thread t JOIN patient_link l ON l.patient_id = t.patient_id
                       WHERE t.id = message.thread_id
                         AND l.account_id = medskin_current_account()
                         AND l.status = 'vinculada'));--> statement-breakpoint

-- El dispositivo y las preferencias son de LA CUENTA, no de la consulta: las usan los cuatro
-- roles con sesión y por eso su política es por `medskin.account_id`.
CREATE POLICY device_own ON "device" FOR ALL TO app_practitioner, app_patient, app_account
  USING (account_id = medskin_current_account())
  WITH CHECK (account_id = medskin_current_account());--> statement-breakpoint
CREATE POLICY alert_preference_own ON "alert_preference" FOR ALL TO app_practitioner, app_patient, app_account
  USING (account_id = medskin_current_account())
  WITH CHECK (account_id = medskin_current_account());--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "care_plan" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "care_step" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "incident" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT ON "incident_photo" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "message_thread" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "message" TO app_practitioner;--> statement-breakpoint
GRANT SELECT ON "care_plan" TO app_patient;--> statement-breakpoint
GRANT SELECT ON "care_step" TO app_patient;--> statement-breakpoint
-- Marcar un cuidado: SOLO esas dos columnas. No se desmarca, y no puede cambiar el texto ni la
-- hora en que aparece — eso sería reescribir la indicación de su doctora.
GRANT UPDATE (done_at, done_reported_at) ON "care_step" TO app_patient;--> statement-breakpoint
GRANT SELECT, INSERT ON "incident" TO app_patient;--> statement-breakpoint
GRANT SELECT, INSERT ON "incident_photo" TO app_patient;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "message_thread" TO app_patient;--> statement-breakpoint
GRANT SELECT, INSERT ON "message" TO app_patient;--> statement-breakpoint
GRANT UPDATE (read_at) ON "message" TO app_patient;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "device" TO app_practitioner, app_patient, app_account;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "alert_preference" TO app_practitioner, app_patient, app_account;
