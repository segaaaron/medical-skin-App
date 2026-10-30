-- =======================================================================================
-- TRAMO 8 · COBROS, MÁRGENES, INVENTARIO E INFORMES · `negocio.md`
--
-- LAS DOS DECISIONES DEL CONTRATO, HECHAS ESQUEMA:
--
-- 1 · MEDSKIN REGISTRA COBROS; NO COBRA. Por eso `payment` guarda `method` y `reference` —el
--     medio con el que la doctora cobró y su comprobante— y NO hay estado de pasarela, ni
--     comisión, ni dinero de terceros en tránsito. «El día que exista una pasarela, es un medio
--     de pago más en este mismo endpoint», y entra como un valor más del `CHECK`.
--
-- 2 · EL MARGEN SE CALCULA CON LO QUE DE VERDAD SE CONSUMIÓ. El costo sale del LOTE aplicado
--     (`session_application` → `product_lot.cost_cents`), nunca de un promedio ni del último
--     precio del proveedor: «los números de un mes cerrado no se mueven».
--
-- Y UN COBRO NO SE BORRA: se anula con su motivo, y la anulación es OTRA FILA. Es contabilidad,
-- y por eso `payment` no tiene `DELETE` para ningún rol.
-- =======================================================================================
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"session_id" uuid,
	"appointment_id" uuid,
	"concept" text NOT NULL,
	"cents" integer NOT NULL,
	"method" text NOT NULL,
	"credit_used_cents" integer DEFAULT 0 NOT NULL,
	-- El comprobante de la doctora. La paciente NO lo ve: «ni la referencia bancaria de la
	-- consulta, ni el medio con el que la doctora lo registró».
	"reference" text,
	"charged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_reason" text,
	"voids_payment_id" uuid,
	"actor_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_concept_ck" CHECK ("payment"."concept" in
		('sesion', 'sena', 'producto', 'otro')),
	CONSTRAINT "payment_method_ck" CHECK ("payment"."method" in
		('efectivo', 'transferencia', 'qr', 'tarjeta', 'credito_de_sena')),
	-- «El importe tiene que ser un número entero mayor que cero.»
	CONSTRAINT "payment_cents_ck" CHECK ("payment"."cents" > 0),
	CONSTRAINT "payment_credit_ck" CHECK ("payment"."credit_used_cents" >= 0),
	CONSTRAINT "payment_voided_ck" CHECK ("payment"."voided_at" is null
		or length(btrim(coalesce("payment"."voided_reason", ''))) > 0)
);
--> statement-breakpoint
-- El movimiento de inventario que NO viene de una sesión: entrada, ajuste, merma, devolución.
-- Las salidas por sesión las escribe `stock_movement` desde el tramo 5 y **no se registran a
-- mano**: «dos caminos para descontar el mismo stock es un inventario que nunca cuadra».
CREATE TABLE "inventory_movement" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"practice_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"units" integer NOT NULL,
	"reason" text,
	"corrects_movement_id" bigint,
	"actor_account_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movement_kind_ck" CHECK ("inventory_movement"."kind" in
		('entrada', 'ajuste', 'merma', 'devolucion')),
	CONSTRAINT "inventory_movement_units_ck" CHECK ("inventory_movement"."units" <> 0),
	-- «Una merma se registra con motivo, obligatorio. Es producto tirado y es dinero.»
	CONSTRAINT "inventory_movement_reason_ck" CHECK ("inventory_movement"."kind" <> 'merma'
		or length(btrim(coalesce("inventory_movement"."reason", ''))) > 0)
);
--> statement-breakpoint
-- Ampliar el plan NO cobra: crea una solicitud y la consola la resuelve.
CREATE TABLE "plan_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"wanted_plan" text NOT NULL,
	"status" text DEFAULT 'pedida' NOT NULL,
	"note" text,
	"requested_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_request_status_ck" CHECK ("plan_request"."status" in
		('pedida', 'aprobada', 'rechazada'))
);
--> statement-breakpoint
-- «Es trámite formal y por eso es asíncrono»: se encola, se arma, y el enlace llega por correo
-- con vida de 24 h y un solo uso.
CREATE TABLE "data_export" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"practice_id" uuid,
	"status" text DEFAULT 'pedida' NOT NULL,
	"object_key" text,
	"expires_at" timestamp with time zone,
	"downloaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_export_status_ck" CHECK ("data_export"."status" in
		('pedida', 'armando', 'lista', 'vencida', 'fallida'))
);
--> statement-breakpoint

ALTER TABLE "payment" ADD CONSTRAINT "payment_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."clinical_session"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_appointment_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_voids_fk" FOREIGN KEY ("voids_payment_id") REFERENCES "public"."payment"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_lot_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."product_lot"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_corrects_fk" FOREIGN KEY ("corrects_movement_id") REFERENCES "public"."inventory_movement"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "plan_request" ADD CONSTRAINT "plan_request_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "data_export" ADD CONSTRAINT "data_export_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "data_export" ADD CONSTRAINT "data_export_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE set null;--> statement-breakpoint

-- El informe de ingresos y el margen leen por mes: la consulta delante y la fecha después.
CREATE INDEX "payment_practice_idx" ON "payment" USING btree ("practice_id", "charged_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "payment_patient_idx" ON "payment" USING btree ("practice_id", "patient_id");--> statement-breakpoint
-- «Esa sesión ya está cobrada»: uno por sesión y concepto, entre los NO anulados.
CREATE UNIQUE INDEX "payment_session_concept_uq" ON "payment" USING btree ("practice_id", "session_id", "concept") WHERE "session_id" is not null and "voided_at" is null;--> statement-breakpoint
CREATE INDEX "inventory_movement_lot_idx" ON "inventory_movement" USING btree ("practice_id", "lot_id", "occurred_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "plan_request_practice_idx" ON "plan_request" USING btree ("practice_id", "status");--> statement-breakpoint
-- «Una solicitud por día y por cuenta»: lo garantiza el único sobre el día.
CREATE UNIQUE INDEX "data_export_daily_uq" ON "data_export" USING btree ("account_id", (("created_at" at time zone 'UTC')::date));--> statement-breakpoint

ALTER TABLE "payment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inventory_movement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inventory_movement" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plan_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plan_request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "data_export" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "data_export" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY payment_practitioner ON "payment" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY inventory_movement_practitioner ON "inventory_movement" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY plan_request_practitioner ON "plan_request" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
-- La consola resuelve las solicitudes de plan: es lo único de este tramo que soporte ve.
CREATE POLICY plan_request_platform ON "plan_request" FOR ALL TO app_platform
  USING (current_user = 'app_platform') WITH CHECK (current_user = 'app_platform');--> statement-breakpoint

-- La paciente ve SUS cobros, y de cada uno SOLO el importe, el concepto y la fecha. El `GRANT`
-- por columna es lo que lo garantiza: `method` y `reference` no están, así que su rol no puede
-- leerlos ni con una consulta hecha a mano.
CREATE POLICY payment_patient_select ON "payment" FOR SELECT TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.patient_id = payment.patient_id
                    AND l.account_id = medskin_current_account() AND l.status = 'vinculada'));--> statement-breakpoint
CREATE POLICY data_export_own ON "data_export" FOR ALL TO app_practitioner, app_patient, app_account
  USING (account_id = medskin_current_account())
  WITH CHECK (account_id = medskin_current_account());--> statement-breakpoint

-- Sin `DELETE` en ninguna: un cobro se anula, un movimiento se corrige con otro de signo
-- contrario, y los dos quedan. Es contabilidad e inventario, no datos de trabajo.
GRANT SELECT, INSERT, UPDATE ON "payment" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT ON "inventory_movement" TO app_practitioner;--> statement-breakpoint
GRANT USAGE ON SEQUENCE "inventory_movement_id_seq" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT ON "plan_request" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, UPDATE ON "plan_request" TO app_platform;--> statement-breakpoint
GRANT SELECT (id, practice_id, patient_id, session_id, concept, cents, charged_at, voided_at)
  ON "payment" TO app_patient;--> statement-breakpoint
GRANT SELECT, INSERT ON "data_export" TO app_practitioner, app_patient, app_account;
