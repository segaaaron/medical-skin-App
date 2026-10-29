-- =======================================================================================
-- TRAMO 4 · LA AGENDA · `agenda.md`
--
-- LAS TRES DECISIONES DEL CONTRATO, HECHAS ESQUEMA:
--
-- 1 · EL SERVIDOR ES LA AUTORIDAD DEL HUECO. Por eso el hueco no es una fila que se marque
--     «libre» u «ocupada»: se CALCULA de `schedule_rule` menos `appointment`. Una tabla de
--     huecos obligaría a mantenerla al día en cada cambio de horario y a resolver dos verdades
--     cuando no coincidieran. Lo que sí hay es un índice que hace barata esa resta.
--
-- 2 · LA HORA VIAJA COMO INSTANTE. `appointment.starts_at` y `ends_at` son `timestamptz`: un
--     instante, no una hora de pared. Las FRANJAS, en cambio, son `time` —«de 9 a 13»— porque
--     son hora de pared de la consulta, y a las dos de la mañana de un cambio de horario una
--     franja no es un intervalo fijo de horas. La zona sale de `practice.time_zone`.
--
-- 3 · LA SEÑA SE REGISTRA; MEDSKIN NO LA COBRA. No hay pasarela y no hay saldo: hay un
--     ESTADO (`deposit_status`) y una fila de `deposit_payment` con lo que la paciente dice
--     que pagó y lo que la consulta confirma. «Se devuelve» significa que la consulta la
--     devuelve por donde la recibió.
--
-- LA CITA NO SE BORRA NUNCA. Cancelar es un estado con su hora y con quién canceló: es lo que
-- alimenta el informe de ausencias del tramo 8 y la conversación de «esta paciente cancela
-- siempre». Por eso `appointment` no tiene `DELETE` para ningún rol de aplicación.
-- =======================================================================================

-- Una fila por consulta: lo que gobierna el cálculo del hueco y la seña.
CREATE TABLE "schedule_settings" (
	"practice_id" uuid PRIMARY KEY NOT NULL,
	-- «No es hueco»: la disponibilidad lo descuenta sin mostrarlo.
	"gap_minutes" integer DEFAULT 15 NOT NULL,
	-- La rejilla: con 30, los huecos caen a y en punto y a y media.
	"slot_minutes" integer DEFAULT 30 NOT NULL,
	-- «Una cita a las 7 reservada a las 3 no la ve nadie.»
	"min_notice_hours" integer DEFAULT 12 NOT NULL,
	"max_booking_days" integer DEFAULT 90 NOT NULL,
	-- La seña: 20 % del precio por omisión, y solo si el precio pasa del mínimo.
	"deposit_percent" integer DEFAULT 20 NOT NULL,
	"deposit_min_cents" integer,
	"deposit_hours" integer DEFAULT 2 NOT NULL,
	-- Cómo pagarle A LA CONSULTA. Son datos de cobro de la doctora, no de la paciente.
	"pay_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_gap_ck" CHECK ("schedule_settings"."gap_minutes" between 0 and 240),
	CONSTRAINT "schedule_slot_ck" CHECK ("schedule_settings"."slot_minutes" in (5, 10, 15, 20, 30, 60)),
	CONSTRAINT "schedule_notice_ck" CHECK ("schedule_settings"."min_notice_hours" between 0 and 720),
	CONSTRAINT "schedule_booking_ck" CHECK ("schedule_settings"."max_booking_days" between 1 and 365),
	CONSTRAINT "schedule_deposit_percent_ck" CHECK ("schedule_settings"."deposit_percent" between 0 and 100),
	CONSTRAINT "schedule_deposit_hours_ck" CHECK ("schedule_settings"."deposit_hours" between 1 and 168)
);
--> statement-breakpoint
CREATE TABLE "schedule_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"starts_at" time NOT NULL,
	"ends_at" time NOT NULL,
	CONSTRAINT "schedule_rule_weekday_ck" CHECK ("schedule_rule"."weekday" between 0 and 6),
	-- «La hora de fin va después de la de inicio.»
	CONSTRAINT "schedule_rule_window_ck" CHECK ("schedule_rule"."ends_at" > "schedule_rule"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "holiday" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"reason" text,
	CONSTRAINT "holiday_window_ck" CHECK ("holiday"."to_date" >= "holiday"."from_date")
);
--> statement-breakpoint
CREATE TABLE "appointment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"treatment_id" uuid NOT NULL,
	"zone" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'confirmada' NOT NULL,
	-- COPIADO al agendar y nunca recalculado: subir la tarifa en diciembre no cambia lo que se
	-- le prometió a esta paciente en noviembre.
	"price_cents" integer NOT NULL,
	"promotion_id" uuid,
	"patient_note" text,
	-- «La agenda es de la doctora y ella sabe cuándo puede apretar.» Queda dibujado distinto.
	"forced" boolean DEFAULT false NOT NULL,
	"deposit_required" boolean DEFAULT false NOT NULL,
	"deposit_cents" integer,
	"deposit_status" text,
	"deposit_due_at" timestamp with time zone,
	"attended" boolean,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"created_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_window_ck" CHECK ("appointment"."ends_at" > "appointment"."starts_at"),
	CONSTRAINT "appointment_status_ck" CHECK ("appointment"."status" in
		('pendiente_de_sena', 'confirmada', 'atendida', 'no_asistio', 'cancelada')),
	CONSTRAINT "appointment_price_ck" CHECK ("appointment"."price_cents" >= 0),
	CONSTRAINT "appointment_deposit_status_ck" CHECK ("appointment"."deposit_status" is null
		or "appointment"."deposit_status" in
		('pendiente', 'dice_que_pago', 'confirmada', 'devuelta', 'credito', 'vencida')),
	-- Una cita con seña exigida tiene importe y plazo; sin ella, ninguno de los tres.
	CONSTRAINT "appointment_deposit_ck" CHECK (
		(not "appointment"."deposit_required" and "appointment"."deposit_cents" is null)
		or ("appointment"."deposit_required" and "appointment"."deposit_cents" is not null
		    and "appointment"."deposit_status" is not null)),
	CONSTRAINT "appointment_cancelled_ck" CHECK (
		"appointment"."status" <> 'cancelada' or "appointment"."cancelled_at" is not null),
	CONSTRAINT "appointment_cancelled_by_ck" CHECK ("appointment"."cancelled_by" is null
		or "appointment"."cancelled_by" in ('paciente', 'consulta', 'sistema'))
);
--> statement-breakpoint
-- Lo que la paciente dice que pagó y lo que la consulta confirma. Dos momentos, dos columnas:
-- «dice que pagó» no es «pagó», y mezclarlos sería afirmar un cobro que nadie vio.
CREATE TABLE "deposit_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	-- Clave de objeto, no un byte: ningún archivo pasa por la API (§7.1).
	"receipt_key" text,
	"claimed_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waitlist_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"treatment_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	-- El hueco se ofrece a UNA a la vez, 30 minutos: ofrecérselo a todas convierte una
	-- cortesía en una carrera y gana quien tenga mejor señal.
	"offered_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_window_ck" CHECK ("waitlist_entry"."to_date" >= "waitlist_entry"."from_date")
);
--> statement-breakpoint

ALTER TABLE "schedule_settings" ADD CONSTRAINT "schedule_settings_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "schedule_rule" ADD CONSTRAINT "schedule_rule_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "holiday" ADD CONSTRAINT "holiday_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade;--> statement-breakpoint
-- `restrict`: un tratamiento con citas no se borra, se archiva. La cita tiene que poder decir
-- de qué era, y para eso el tratamiento tiene que seguir existiendo.
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_treatment_fk" FOREIGN KEY ("treatment_id") REFERENCES "public"."treatment"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_promotion_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotion"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "deposit_payment" ADD CONSTRAINT "deposit_payment_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "deposit_payment" ADD CONSTRAINT "deposit_payment_appointment_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_treatment_fk" FOREIGN KEY ("treatment_id") REFERENCES "public"."treatment"("id") ON DELETE cascade;--> statement-breakpoint

-- =======================================================================================
-- ÍNDICES
--
-- EL DE LA AGENDA ES EL QUE PAGA ESTE TRAMO: `(practice_id, starts_at)` con el inquilino
-- delante (regla 5) es lo que convierte «calcular los huecos de una semana» en leer un rango.
-- `DESC NULLS FIRST` no va aquí a propósito: la agenda se lee hacia ADELANTE, de hoy en
-- adelante, así que el orden natural ascendente es el que sirve.
-- =======================================================================================
CREATE INDEX "appointment_practice_starts_idx" ON "appointment" USING btree ("practice_id", "starts_at");--> statement-breakpoint
-- La agenda de una paciente, que es su pantalla de inicio.
CREATE INDEX "appointment_patient_idx" ON "appointment" USING btree ("practice_id", "patient_id", "starts_at" DESC NULLS FIRST);--> statement-breakpoint
-- «Ya tienes una cita el 3 de noviembre para esto»: una sin atender por tratamiento y paciente.
CREATE INDEX "appointment_open_idx" ON "appointment" USING btree ("practice_id", "patient_id", "treatment_id") WHERE "status" in ('pendiente_de_sena', 'confirmada');--> statement-breakpoint
-- El barrido de señas vencidas, que corre cada pocos minutos y tiene que ser barato.
CREATE INDEX "appointment_deposit_due_idx" ON "appointment" USING btree ("deposit_due_at") WHERE "status" = 'pendiente_de_sena';--> statement-breakpoint
CREATE INDEX "schedule_rule_practice_idx" ON "schedule_rule" USING btree ("practice_id", "weekday", "starts_at");--> statement-breakpoint
CREATE INDEX "holiday_practice_idx" ON "holiday" USING btree ("practice_id", "from_date", "to_date");--> statement-breakpoint
CREATE INDEX "deposit_payment_appointment_idx" ON "deposit_payment" USING btree ("practice_id", "appointment_id");--> statement-breakpoint
-- La cola: orden de llegada, y por eso ascendente.
CREATE INDEX "waitlist_practice_idx" ON "waitlist_entry" USING btree ("practice_id", "treatment_id", "created_at");--> statement-breakpoint
CREATE INDEX "waitlist_patient_idx" ON "waitlist_entry" USING btree ("practice_id", "patient_id");--> statement-breakpoint

-- =======================================================================================
-- RLS · forzada en las seis
--
-- `app_practitioner`: por `practice_id` del contexto.
-- `app_patient`: por SU ficha —`EXISTS` sobre `patient_link` con su cuenta y `vinculada`—, que
-- es autoverificable y no necesita contexto de inquilino. Puede LEER su cita y su lista de
-- espera, y ESCRIBIR solo lo que el contrato le deja: crear su cita, cancelarla, decir que
-- pagó, y apuntarse o salirse de la lista de espera.
-- `app_platform`: NINGUNA política. Soporte no ve la agenda de nadie.
-- =======================================================================================
ALTER TABLE "schedule_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "schedule_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "schedule_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "schedule_rule" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "holiday" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "holiday" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appointment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appointment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deposit_payment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deposit_payment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "waitlist_entry" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY schedule_settings_practitioner ON "schedule_settings" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY schedule_rule_practitioner ON "schedule_rule" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY holiday_practitioner ON "holiday" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY appointment_practitioner ON "appointment" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY deposit_payment_practitioner ON "deposit_payment" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
CREATE POLICY waitlist_practitioner ON "waitlist_entry" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint

-- La paciente lee los horarios de las consultas que la atienden: sin eso no hay hueco que
-- calcular en su app. Son horas de atención, no dato de nadie.
CREATE POLICY schedule_settings_patient_select ON "schedule_settings" FOR SELECT TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.practice_id = schedule_settings.practice_id
                    AND l.account_id = medskin_current_account() AND l.status = 'vinculada'));--> statement-breakpoint
CREATE POLICY schedule_rule_patient_select ON "schedule_rule" FOR SELECT TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.practice_id = schedule_rule.practice_id
                    AND l.account_id = medskin_current_account() AND l.status = 'vinculada'));--> statement-breakpoint
CREATE POLICY holiday_patient_select ON "holiday" FOR SELECT TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.practice_id = holiday.practice_id
                    AND l.account_id = medskin_current_account() AND l.status = 'vinculada'));--> statement-breakpoint

-- SUS citas, y solo las suyas: por el `patient_id` de su propio vínculo. Una doctora no ve las
-- citas que su paciente tenga en otra consulta, y la paciente no ve las de nadie más.
--
-- OJO CON LO QUE ESTA POLÍTICA **NO** DICE: no dice qué huecos están ocupados. Para calcular
-- su disponibilidad la paciente necesitaría ver las citas de las demás, y eso no se le da: el
-- cálculo lo hace el servidor con una función `SECURITY DEFINER` que devuelve huecos, no filas.
CREATE POLICY appointment_patient_select ON "appointment" FOR SELECT TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.patient_id = appointment.patient_id
                    AND l.account_id = medskin_current_account() AND l.status = 'vinculada'));--> statement-breakpoint
CREATE POLICY appointment_patient_write ON "appointment" FOR INSERT TO app_patient
  WITH CHECK (EXISTS (SELECT 1 FROM patient_link l
                       WHERE l.patient_id = appointment.patient_id
                         AND l.account_id = medskin_current_account()
                         AND l.status = 'vinculada'));--> statement-breakpoint
CREATE POLICY appointment_patient_update ON "appointment" FOR UPDATE TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.patient_id = appointment.patient_id
                    AND l.account_id = medskin_current_account() AND l.status = 'vinculada'))
  WITH CHECK (EXISTS (SELECT 1 FROM patient_link l
                       WHERE l.patient_id = appointment.patient_id
                         AND l.account_id = medskin_current_account()
                         AND l.status = 'vinculada'));--> statement-breakpoint

CREATE POLICY deposit_payment_patient ON "deposit_payment" FOR ALL TO app_patient
  USING (EXISTS (SELECT 1 FROM appointment a
                   JOIN patient_link l ON l.patient_id = a.patient_id
                  WHERE a.id = deposit_payment.appointment_id
                    AND l.account_id = medskin_current_account() AND l.status = 'vinculada'))
  WITH CHECK (EXISTS (SELECT 1 FROM appointment a
                        JOIN patient_link l ON l.patient_id = a.patient_id
                       WHERE a.id = deposit_payment.appointment_id
                         AND l.account_id = medskin_current_account()
                         AND l.status = 'vinculada'));--> statement-breakpoint
CREATE POLICY waitlist_patient ON "waitlist_entry" FOR ALL TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.patient_id = waitlist_entry.patient_id
                    AND l.account_id = medskin_current_account() AND l.status = 'vinculada'))
  WITH CHECK (EXISTS (SELECT 1 FROM patient_link l
                       WHERE l.patient_id = waitlist_entry.patient_id
                         AND l.account_id = medskin_current_account()
                         AND l.status = 'vinculada'));--> statement-breakpoint

-- =======================================================================================
-- PRIVILEGIOS
--
-- NINGÚN `DELETE` SOBRE `appointment` PARA NADIE: una cita no se borra, se cancela. Y la
-- paciente tiene `UPDATE` solo sobre las columnas de SU parte —reagendar, su nota, cancelar y
-- decir que pagó—: ni el precio, ni el estado de la seña que confirma la consulta, ni
-- `forced`, ni la asistencia.
-- =======================================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON "schedule_rule" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "holiday" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "schedule_settings" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "appointment" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "deposit_payment" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "waitlist_entry" TO app_practitioner;--> statement-breakpoint

GRANT SELECT ON "schedule_settings" TO app_patient;--> statement-breakpoint
GRANT SELECT ON "schedule_rule" TO app_patient;--> statement-breakpoint
GRANT SELECT ON "holiday" TO app_patient;--> statement-breakpoint
GRANT SELECT, INSERT ON "appointment" TO app_patient;--> statement-breakpoint
GRANT UPDATE (starts_at, ends_at, zone, patient_note, status, deposit_status, cancelled_at,
              cancelled_by, updated_at) ON "appointment" TO app_patient;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "deposit_payment" TO app_patient;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "waitlist_entry" TO app_patient;
