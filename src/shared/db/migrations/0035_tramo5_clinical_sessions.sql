-- =======================================================================================
-- TRAMO 5 · SESIONES CLÍNICAS, LOTES Y CONSENTIMIENTOS · `sesiones.md`
--
-- LAS TRES DECISIONES DEL CONTRATO, HECHAS ESQUEMA, Y LAS TRES SE VEN EN LAS TABLAS:
--
-- 1 · LA NOTA FIRMADA ES INMUTABLE, Y UNA CORRECCIÓN ES UNA FILA NUEVA (§12.2.3). Por eso
--     `note_correction` apunta a la nota y la nota no tiene por dónde editarse después de
--     `signed_at`: ningún rol tiene `UPDATE` sobre sus campos una vez firmada —lo impide el
--     disparador de abajo, porque un `GRANT` por columna no sabe de estados—. «Un expediente
--     que se puede editar hacia atrás no prueba nada.»
--
-- 2 · LO APLICADO APUNTA AL LOTE, NUNCA AL PRODUCTO (§12.2.4). `session_application.lot_id` es
--     `NOT NULL` a propósito, aunque la doctora tenga que elegir de una lista de uno: es lo que
--     hace contestable «dado este lote, a qué pacientes se les puso» el día de un retiro, y con
--     `product_id` esa pregunta no tiene respuesta.
--
-- 3 · LOS PUNTOS SON FILAS, NO UN TEXTO (§12.2.5). Seis puntos con sus unidades son seis filas
--     con su zona, su coordenada RELATIVA (0-1, no píxeles: otra pantalla no mueve un
--     expediente) y sus unidades. Así se comparan entre sesiones y el margen del tramo 8 sale
--     de sumar, no de interpretar una frase.
--
-- Y LO QUE NO SE BORRA, QUE AQUÍ ES CASI TODO: una sesión se anula, un lote se agota o vence,
-- un consentimiento se revoca con fecha, y un evento adverso NO se borra ni se anula nunca.
-- =======================================================================================

CREATE TABLE "product_lot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"code" text NOT NULL,
	"expires_on" date NOT NULL,
	"units" integer NOT NULL,
	"units_left" integer NOT NULL,
	-- En centavos, para el margen del tramo 8: el costo real de lo aplicado sale de aquí.
	"cost_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_lot_code_ck" CHECK (length(btrim("product_lot"."code")) between 1 and 60),
	CONSTRAINT "product_lot_units_ck" CHECK ("product_lot"."units" > 0),
	-- Nunca por debajo de cero ni por encima de lo que entró: el stock es una cuenta, no una
	-- estimación.
	CONSTRAINT "product_lot_left_ck" CHECK ("product_lot"."units_left" between 0 and "product_lot"."units")
);
--> statement-breakpoint
CREATE TABLE "clinical_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	-- Una sesión cuelga de una cita atendida: «un expediente sin cita deja la agenda y el
	-- historial contando cosas distintas».
	"appointment_id" uuid NOT NULL,
	"practitioner_account_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'borrador' NOT NULL,
	"observations" text,
	"voided_at" timestamp with time zone,
	"voided_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinical_session_status_ck" CHECK ("clinical_session"."status" in
		('borrador', 'firmada', 'anulada')),
	CONSTRAINT "clinical_session_window_ck" CHECK ("clinical_session"."ended_at" >= "clinical_session"."started_at"),
	-- «Explica por qué se anula: va al expediente.»
	CONSTRAINT "clinical_session_voided_ck" CHECK (
		"clinical_session"."status" <> 'anulada'
		or (("clinical_session"."voided_at" is not null)
		    and length(btrim(coalesce("clinical_session"."voided_reason", ''))) >= 10))
);
--> statement-breakpoint
CREATE TABLE "session_application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	-- EL LOTE, SIEMPRE. Es la decisión 2 de este contrato, y es `NOT NULL` por eso.
	"lot_id" uuid NOT NULL,
	"zone" text NOT NULL,
	"technique" text,
	"depth" text,
	"total_units" integer NOT NULL,
	CONSTRAINT "session_application_units_ck" CHECK ("session_application"."total_units" > 0),
	CONSTRAINT "session_application_zone_ck" CHECK ("session_application"."zone" in
		('frente', 'entrecejo', 'patas_de_gallo', 'tercio_superior', 'tercio_medio',
		 'tercio_inferior', 'surcos_nasogenianos', 'labios', 'menton', 'cuello',
		 'escote', 'manos', 'cara_completa', 'otra'))
);
--> statement-breakpoint
CREATE TABLE "application_point" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"zone" text NOT NULL,
	-- RELATIVAS sobre la vista anatómica, no píxeles: una pantalla distinta no mueve los
	-- puntos de un expediente.
	"x" numeric(4, 3) NOT NULL,
	"y" numeric(4, 3) NOT NULL,
	"units" integer NOT NULL,
	CONSTRAINT "application_point_x_ck" CHECK ("application_point"."x" between 0 and 1),
	CONSTRAINT "application_point_y_ck" CHECK ("application_point"."y" between 0 and 1),
	CONSTRAINT "application_point_units_ck" CHECK ("application_point"."units" > 0)
);
--> statement-breakpoint
CREATE TABLE "session_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	-- Los campos van en `jsonb` y no en columnas: la plantilla de la nota es del tratamiento y
	-- va a crecer, y añadir un campo no puede ser una migración. Lo que sí es columna es lo que
	-- gobierna el estado, que es lo que el esquema tiene que garantizar.
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	-- Los campos que dos dispositivos escribieron a la vez, con los dos valores. «Perder una
	-- frase de una nota clínica porque dos personas escribieron a la vez es inaceptable, y
	-- elegir por ellas también.»
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signed_at" timestamp with time zone,
	"signed_by_practitioner_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_note_signed_ck" CHECK (
		("session_note"."signed_at" is null and "session_note"."signed_by_practitioner_id" is null)
		or ("session_note"."signed_at" is not null
		    and "session_note"."signed_by_practitioner_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "note_correction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	-- A quién corrige: la nota, o una corrección anterior. «Una corrección tampoco se edita: se
	-- corrige con otra», y así la cadena se lee en orden.
	"corrects_correction_id" uuid,
	"text" text NOT NULL,
	"reason" text NOT NULL,
	"author_practitioner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_correction_text_ck" CHECK (length(btrim("note_correction"."text")) > 0),
	-- Cerrado porque «es lo que un auditor lee primero, y "otro" no explica nada».
	CONSTRAINT "note_correction_reason_ck" CHECK ("note_correction"."reason" in
		('error_de_transcripcion', 'dato_omitido', 'dato_equivocado', 'aclaracion'))
);
--> statement-breakpoint
CREATE TABLE "adverse_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"appeared_at" timestamp with time zone NOT NULL,
	"description" text NOT NULL,
	"management" text,
	-- La otra mitad de la consulta de retiro: si se sospecha del producto, queda enlazado.
	"lot_id" uuid,
	"outcome" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adverse_event_kind_ck" CHECK ("adverse_event"."kind" in
		('hematoma', 'edema', 'asimetria', 'ptosis', 'infeccion', 'nodulo', 'necrosis',
		 'reaccion_alergica', 'dolor_persistente', 'otro')),
	CONSTRAINT "adverse_event_severity_ck" CHECK ("adverse_event"."severity" in
		('leve', 'moderada', 'grave')),
	CONSTRAINT "adverse_event_description_ck" CHECK (length(btrim("adverse_event"."description")) > 0)
);
--> statement-breakpoint
-- El texto vigente del consentimiento, por tratamiento y versión. Es DE LA CONSULTA y no
-- global: cada una responde por lo que hace firmar.
CREATE TABLE "consent_text" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"treatment_id" uuid NOT NULL,
	"version" text NOT NULL,
	"body" text NOT NULL,
	-- Las tres preguntas con sus opciones, SIN la respuesta correcta.
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	-- Y la correcta, en SU PROPIA COLUMNA. No es una separación estética: `app_patient` no
	-- tiene `GRANT` sobre esta columna, así que su rol no puede leerla ni por una consulta
	-- hecha a mano. Si viviera dentro de `questions`, lo único que la protegería sería que el
	-- servidor se acuerde de quitarla antes de responder — y «la app no sabe la respuesta y no
	-- puede saberla» es una promesa del contrato, no una buena intención.
	"answer_key" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"treatment_id" uuid,
	-- «El clínico y el de marketing son DOS FILAS DISTINTAS, y revocar uno no toca el otro.»
	"purpose" text NOT NULL,
	-- La versión del texto se guarda CON la firma: «un consentimiento que apunta a un texto que
	-- cambió después no prueba nada».
	"version" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_by" text DEFAULT 'paciente' NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	-- Se guarda y NO bloquea: «nadie demuestra comprensión con un cronómetro, pero el dato
	-- importa el día que haya que explicar cómo se obtuvo».
	"read_seconds" integer,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "consent_purpose_ck" CHECK ("consent"."purpose" in ('clinico', 'imagenes', 'marketing')),
	CONSTRAINT "consent_signed_by_ck" CHECK ("consent"."signed_by" in ('paciente', 'tutor'))
);
--> statement-breakpoint
-- Cada movimiento de stock, con su motivo. Un inventario sin movimientos es un número que
-- nadie puede explicar.
CREATE TABLE "stock_movement" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"practice_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"session_id" uuid,
	"units" integer NOT NULL,
	"reason" text NOT NULL,
	"actor_account_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movement_reason_ck" CHECK ("stock_movement"."reason" in
		('alta_de_lote', 'aplicacion', 'anulacion', 'ajuste', 'merma'))
);
--> statement-breakpoint

ALTER TABLE "product_lot" ADD CONSTRAINT "product_lot_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "product_lot" ADD CONSTRAINT "product_lot_product_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "clinical_session" ADD CONSTRAINT "clinical_session_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "clinical_session" ADD CONSTRAINT "clinical_session_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "clinical_session" ADD CONSTRAINT "clinical_session_appointment_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "session_application" ADD CONSTRAINT "session_application_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "session_application" ADD CONSTRAINT "session_application_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."clinical_session"("id") ON DELETE cascade;--> statement-breakpoint
-- `restrict`: el lote no se borra mientras una aplicación lo nombre. Es la trazabilidad.
ALTER TABLE "session_application" ADD CONSTRAINT "session_application_lot_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."product_lot"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "application_point" ADD CONSTRAINT "application_point_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "application_point" ADD CONSTRAINT "application_point_application_fk" FOREIGN KEY ("application_id") REFERENCES "public"."session_application"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "session_note" ADD CONSTRAINT "session_note_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "session_note" ADD CONSTRAINT "session_note_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."clinical_session"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "note_correction" ADD CONSTRAINT "note_correction_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "note_correction" ADD CONSTRAINT "note_correction_note_fk" FOREIGN KEY ("note_id") REFERENCES "public"."session_note"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "note_correction" ADD CONSTRAINT "note_correction_chain_fk" FOREIGN KEY ("corrects_correction_id") REFERENCES "public"."note_correction"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "adverse_event" ADD CONSTRAINT "adverse_event_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "adverse_event" ADD CONSTRAINT "adverse_event_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."clinical_session"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "adverse_event" ADD CONSTRAINT "adverse_event_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "adverse_event" ADD CONSTRAINT "adverse_event_lot_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."product_lot"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "consent_text" ADD CONSTRAINT "consent_text_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "consent_text" ADD CONSTRAINT "consent_text_treatment_fk" FOREIGN KEY ("treatment_id") REFERENCES "public"."treatment"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_treatment_fk" FOREIGN KEY ("treatment_id") REFERENCES "public"."treatment"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_lot_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."product_lot"("id") ON DELETE cascade;--> statement-breakpoint

-- =======================================================================================
-- ÍNDICES
--
-- EL QUE JUSTIFICA EL TRAMO: `session_application (practice_id, lot_id)`. Es la consulta de
-- retiro —«dado este lote, a qué pacientes se les puso»— y con él es una lectura por índice.
-- =======================================================================================
CREATE INDEX "session_application_lot_idx" ON "session_application" USING btree ("practice_id", "lot_id");--> statement-breakpoint
CREATE INDEX "session_application_session_idx" ON "session_application" USING btree ("practice_id", "session_id");--> statement-breakpoint
CREATE INDEX "application_point_idx" ON "application_point" USING btree ("practice_id", "application_id");--> statement-breakpoint
-- La línea de tiempo de una ficha: lo último primero.
CREATE INDEX "clinical_session_patient_idx" ON "clinical_session" USING btree ("practice_id", "patient_id", "started_at" DESC NULLS FIRST);--> statement-breakpoint
-- «Esa cita ya tiene su sesión registrada»: una por cita, y lo garantiza el único.
CREATE UNIQUE INDEX "clinical_session_appointment_uq" ON "clinical_session" USING btree ("appointment_id") WHERE "status" <> 'anulada';--> statement-breakpoint
CREATE UNIQUE INDEX "session_note_session_uq" ON "session_note" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "note_correction_note_idx" ON "note_correction" USING btree ("practice_id", "note_id", "created_at");--> statement-breakpoint
CREATE INDEX "adverse_event_practice_idx" ON "adverse_event" USING btree ("practice_id", "appeared_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "adverse_event_lot_idx" ON "adverse_event" USING btree ("practice_id", "lot_id");--> statement-breakpoint
-- «El código de lote es único por producto y consulta»: dos iguales hacen imposible la
-- consulta de retiro, que es la única razón de que esta tabla exista.
CREATE UNIQUE INDEX "product_lot_code_uq" ON "product_lot" USING btree ("practice_id", "product_id", upper(btrim("code")));--> statement-breakpoint
CREATE INDEX "product_lot_expiry_idx" ON "product_lot" USING btree ("practice_id", "expires_on");--> statement-breakpoint
CREATE INDEX "consent_patient_idx" ON "consent" USING btree ("practice_id", "patient_id", "purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_text_version_uq" ON "consent_text" USING btree ("practice_id", "treatment_id", "version");--> statement-breakpoint
CREATE INDEX "stock_movement_lot_idx" ON "stock_movement" USING btree ("practice_id", "lot_id", "occurred_at" DESC NULLS FIRST);--> statement-breakpoint

-- =======================================================================================
-- LA NOTA FIRMADA NO SE TOCA · y no basta con no escribir el `UPDATE`
--
-- Un `GRANT` por columna no sabe de estados: no hay forma de conceder «`UPDATE` de `fields`
-- solo mientras `signed_at` sea nulo». Así que lo garantiza un disparador, que es la única
-- herramienta que mira la fila antes y después. Sin esto, la decisión 1 del contrato sería una
-- promesa del código de aplicación, y el código de aplicación se reescribe.
-- =======================================================================================
CREATE FUNCTION medskin_signed_note_is_immutable()
RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF OLD.signed_at IS NOT NULL THEN
    -- Lo único que puede cambiar en una nota firmada: nada. Ni los campos, ni los conflictos,
    -- ni quién firmó. Una corrección es una fila de `note_correction`.
    IF NEW.fields IS DISTINCT FROM OLD.fields
       OR NEW.conflicts IS DISTINCT FROM OLD.conflicts
       OR NEW.signed_at IS DISTINCT FROM OLD.signed_at
       OR NEW.signed_by_practitioner_id IS DISTINCT FROM OLD.signed_by_practitioner_id THEN
      RAISE EXCEPTION 'una nota firmada no se modifica: agrega una corrección'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;--> statement-breakpoint
CREATE TRIGGER session_note_immutable BEFORE UPDATE ON "session_note"
  FOR EACH ROW EXECUTE FUNCTION medskin_signed_note_is_immutable();--> statement-breakpoint

-- =======================================================================================
-- RLS · forzada en las nueve
--
-- `app_practitioner` por `practice_id`. La PACIENTE lee lo suyo y firma su consentimiento: el
-- texto del consentimiento y sus propias firmas, y nada más — ni la nota, ni las aplicaciones,
-- ni los lotes, ni los eventos adversos. «Un evento grave no manda ninguna notificación a la
-- paciente»: tampoco se lo sirve una lectura.
-- `app_platform`: NINGUNA política en ninguna. Soporte no lee expedientes.
-- =======================================================================================
ALTER TABLE "product_lot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_lot" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clinical_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clinical_session" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_application" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_application" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "application_point" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "application_point" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_note" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_note" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "note_correction" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "note_correction" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "adverse_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "adverse_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consent_text" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consent_text" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consent" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_movement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_movement" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY product_lot_practitioner ON "product_lot" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY clinical_session_practitioner ON "clinical_session" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY session_application_practitioner ON "session_application" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY application_point_practitioner ON "application_point" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY session_note_practitioner ON "session_note" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY note_correction_practitioner ON "note_correction" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY adverse_event_practitioner ON "adverse_event" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY consent_text_practitioner ON "consent_text" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY consent_practitioner ON "consent" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY stock_movement_practitioner ON "stock_movement" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint

-- La paciente: el TEXTO del consentimiento de una consulta suya, y SUS firmas.
CREATE POLICY consent_text_patient_select ON "consent_text" FOR SELECT TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.practice_id = consent_text.practice_id
                    AND l.account_id = medskin_current_account() AND l.status = 'vinculada'));--> statement-breakpoint
CREATE POLICY consent_patient ON "consent" FOR ALL TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.patient_id = consent.patient_id
                    AND l.account_id = medskin_current_account() AND l.status = 'vinculada'))
  WITH CHECK (EXISTS (SELECT 1 FROM patient_link l
                       WHERE l.patient_id = consent.patient_id
                         AND l.account_id = medskin_current_account()
                         AND l.status = 'vinculada'));--> statement-breakpoint

-- =======================================================================================
-- PRIVILEGIOS
--
-- NINGÚN `DELETE` EN TODO EL TRAMO, Y ES EL PUNTO: una sesión se anula, un lote se agota, un
-- consentimiento se revoca con fecha, y un evento adverso no se borra nunca. Lo único que se
-- borra de verdad son los puntos y las aplicaciones de un BORRADOR que se está reescribiendo,
-- y por eso esas dos sí lo tienen.
-- =======================================================================================
GRANT SELECT, INSERT, UPDATE ON "product_lot" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "clinical_session" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "session_application" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "application_point" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "session_note" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT ON "note_correction" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "adverse_event" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "consent_text" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "consent" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT ON "stock_movement" TO app_practitioner;--> statement-breakpoint
GRANT USAGE ON SEQUENCE "stock_movement_id_seq" TO app_practitioner;--> statement-breakpoint

-- La paciente: el texto para leerlo, y su firma. `UPDATE` solo de `revoked_at`, que es lo
-- único suyo que puede cambiar después.
GRANT SELECT (id, practice_id, treatment_id, version, body, questions, published)
  ON "consent_text" TO app_patient;--> statement-breakpoint
GRANT SELECT, INSERT ON "consent" TO app_patient;--> statement-breakpoint
GRANT UPDATE (revoked_at) ON "consent" TO app_patient;
