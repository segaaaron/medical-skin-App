-- =======================================================================================
-- EL TOPE DE LOS TEXTOS LIBRES · hallazgo H-08 · 29 de octubre de 2026
--
-- Ochenta y tantas columnas `text` del esquema no tenían ninguna restricción de longitud, y
-- entre ellas las que escribe UN CLIENTE: `appointment.patient_note`, `clinical_session.
-- observations`, `medical_history.notes`, `device.token`, `patient.first_name`… El único tope
-- era el megabyte del cuerpo de Fastify, así que una nota de cita podía ser un megabyte menos
-- las comillas, y cien de esas son cien megabytes de disco en una VPS de dos gigas.
--
-- QUÉ SE ACOTA Y QUÉ NO, porque no todas son iguales:
--
-- · LO QUE ESCRIBE UN CLIENTE se acota aquí, con el mismo número que el lector del dominio ya
--   recorta. Son dos murallas de lo mismo y es a propósito: «si la paciente llega con una app
--   desactualizada, el muro tiene que estar en los dos sitios».
-- · LO QUE ESCRIBE EL SERVIDOR —`search_text`, los hashes, `service_failure.stack`, los
--   nombres copiados en `patient_link`— NO se acota: su longitud la decide el propio servidor,
--   y un `CHECK` ahí solo puede convertir un dato correcto en un 500. El `stack` de un fallo,
--   además, es más útil completo.
-- · LOS ENUMERADOS ya tienen su `CHECK … in (…)`, que es un tope más fuerte que cualquier
--   longitud.
--
-- Los números no son redondos por gusto: son los que ya usa el lector de cada endpoint (120
-- para un nombre, 500 para un paso de protocolo, 2000 para una nota), así que esta migración
-- no cambia ningún comportamiento que hoy pase por la aplicación. Lo que cierra es el camino
-- que NO pasa por ella.
-- =======================================================================================
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_note_len_ck"
	CHECK ("patient_note" IS NULL OR length("patient_note") <= 2000);--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_zone_len_ck"
	CHECK ("zone" IS NULL OR length("zone") <= 64);--> statement-breakpoint
ALTER TABLE "clinical_session" ADD CONSTRAINT "clinical_session_observations_len_ck"
	CHECK ("observations" IS NULL OR length("observations") <= 4000);--> statement-breakpoint
ALTER TABLE "medical_history" ADD CONSTRAINT "medical_history_notes_len_ck"
	CHECK ("notes" IS NULL OR length("notes") <= 4000);--> statement-breakpoint
ALTER TABLE "care_step" ADD CONSTRAINT "care_step_text_len_ck"
	CHECK (length("text") between 1 and 500);--> statement-breakpoint
ALTER TABLE "treatment" ADD CONSTRAINT "treatment_description_len_ck"
	CHECK ("description" IS NULL OR length("description") <= 2000);--> statement-breakpoint
ALTER TABLE "treatment_traffic_light" ADD CONSTRAINT "traffic_light_normal_len_ck"
	CHECK (length("normal") between 1 and 500);--> statement-breakpoint
ALTER TABLE "treatment_traffic_light" ADD CONSTRAINT "traffic_light_call_if_len_ck"
	CHECK (length("call_if") between 1 and 500);--> statement-breakpoint
ALTER TABLE "holiday" ADD CONSTRAINT "holiday_reason_len_ck"
	CHECK ("reason" IS NULL OR length("reason") <= 120);--> statement-breakpoint
ALTER TABLE "adverse_event" ADD CONSTRAINT "adverse_event_management_len_ck"
	CHECK ("management" IS NULL OR length("management") <= 2000);--> statement-breakpoint
ALTER TABLE "adverse_event" ADD CONSTRAINT "adverse_event_outcome_len_ck"
	CHECK ("outcome" IS NULL OR length("outcome") <= 2000);--> statement-breakpoint
ALTER TABLE "session_application" ADD CONSTRAINT "session_application_technique_len_ck"
	CHECK ("technique" IS NULL OR length("technique") <= 64);--> statement-breakpoint
ALTER TABLE "session_application" ADD CONSTRAINT "session_application_depth_len_ck"
	CHECK ("depth" IS NULL OR length("depth") <= 64);--> statement-breakpoint
ALTER TABLE "application_point" ADD CONSTRAINT "application_point_zone_len_ck"
	CHECK (length("zone") between 1 and 64);--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_reference_len_ck"
	CHECK ("reference" IS NULL OR length("reference") <= 120);--> statement-breakpoint
ALTER TABLE "deposit_payment" ADD CONSTRAINT "deposit_receipt_len_ck"
	CHECK ("receipt_key" IS NULL OR length("receipt_key") <= 256);--> statement-breakpoint
ALTER TABLE "plan_request" ADD CONSTRAINT "plan_request_note_len_ck"
	CHECK ("note" IS NULL OR length("note") <= 1000);--> statement-breakpoint
ALTER TABLE "plan_request" ADD CONSTRAINT "plan_request_wanted_len_ck"
	CHECK (length("wanted_plan") between 1 and 40);--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_unit_len_ck"
	CHECK (length("unit") between 1 and 40);--> statement-breakpoint
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_code_len_ck"
	CHECK ("code" IS NULL OR length("code") between 1 and 40);--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_first_name_len_ck"
	CHECK (length(btrim("first_name")) between 1 and 120);--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_last_name_len_ck"
	CHECK (length(btrim("last_name")) between 1 and 120);--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_phone_len_ck"
	CHECK ("phone" IS NULL OR length("phone") <= 40);--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_how_arrived_len_ck"
	CHECK (length("how_arrived") <= 64);--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_first_name_len_ck"
	CHECK (length(btrim("first_name")) between 1 and 120);--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_last_name_len_ck"
	CHECK (length(btrim("last_name")) between 1 and 120);--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_phone_len_ck"
	CHECK ("phone" IS NULL OR length("phone") <= 40);--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_deletion_reason_len_ck"
	CHECK ("deletion_reason" IS NULL OR length("deletion_reason") <= 120);--> statement-breakpoint
ALTER TABLE "practitioner" ADD CONSTRAINT "practitioner_first_name_len_ck"
	CHECK (length(btrim("first_name")) between 1 and 120);--> statement-breakpoint
ALTER TABLE "practitioner" ADD CONSTRAINT "practitioner_last_name_len_ck"
	CHECK (length(btrim("last_name")) between 1 and 120);--> statement-breakpoint
-- El token de un dispositivo: APNs son 64 hex, FCM pasa de 150 caracteres y crece con las
-- versiones del SDK. 512 deja sitio de sobra y cierra el «un megabyte por token».
ALTER TABLE "device" ADD CONSTRAINT "device_token_len_ck"
	CHECK (length("token") between 1 and 512);--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_id_len_ck"
	CHECK (length("device_id") between 1 and 128);--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_app_version_len_ck"
	CHECK ("app_version" IS NULL OR length("app_version") <= 40);--> statement-breakpoint
-- El texto del consentimiento es largo por naturaleza —son párrafos—, pero no es infinito.
ALTER TABLE "consent_text" ADD CONSTRAINT "consent_text_body_len_ck"
	CHECK (length("body") between 1 and 100000);--> statement-breakpoint
ALTER TABLE "consent_text" ADD CONSTRAINT "consent_text_version_len_ck"
	CHECK (length("version") between 1 and 40);--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_version_len_ck"
	CHECK (length("version") between 1 and 40);--> statement-breakpoint
ALTER TABLE "note_correction" ADD CONSTRAINT "note_correction_reason_len_ck"
	CHECK (length("reason") <= 120);--> statement-breakpoint
ALTER TABLE "practice" ADD CONSTRAINT "practice_address_len_ck"
	CHECK ("address" IS NULL OR length("address") <= 240);--> statement-breakpoint
ALTER TABLE "practice" ADD CONSTRAINT "practice_city_len_ck"
	CHECK ("city" IS NULL OR length("city") <= 120);--> statement-breakpoint
ALTER TABLE "practice" ADD CONSTRAINT "practice_phone_len_ck"
	CHECK ("phone" IS NULL OR length("phone") <= 40);--> statement-breakpoint
ALTER TABLE "practice" ADD CONSTRAINT "practice_internal_note_len_ck"
	CHECK ("internal_note" IS NULL OR length("internal_note") <= 2000);--> statement-breakpoint
ALTER TABLE "practice" ADD CONSTRAINT "practice_logo_url_len_ck"
	CHECK ("logo_url" IS NULL OR length("logo_url") <= 512);--> statement-breakpoint
ALTER TABLE "license" ADD CONSTRAINT "license_specialty_len_ck"
	CHECK ("specialty" IS NULL OR length("specialty") <= 120);--> statement-breakpoint
ALTER TABLE "license" ADD CONSTRAINT "license_country_len_ck"
	CHECK ("practice_country" IS NULL OR length("practice_country") <= 80);--> statement-breakpoint
ALTER TABLE "photo" ADD CONSTRAINT "photo_deleted_reason_len_ck"
	CHECK ("deleted_reason" IS NULL OR length("deleted_reason") <= 240);--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_what_len_ck"
	CHECK (length(btrim("what")) between 1 and 2000);
