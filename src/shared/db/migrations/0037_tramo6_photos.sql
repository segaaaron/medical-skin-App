-- =======================================================================================
-- TRAMO 6 · LAS FOTOS · `imagenes.md`
--
-- LAS CUATRO DECISIONES DEL CONTRATO, HECHAS ESQUEMA:
--
-- 1 · DOS NIVELES, Y LA MAESTRA NO SE DEGRADA NUNCA. `master_key` y las tres derivadas son
--     columnas distintas: la maestra es el registro clínico y la prueba legal, las derivadas
--     son caché regenerable. `master_format` dice en qué formato quedó de verdad, porque si
--     la compilación de libvips no trae JPEG XL **se guarda sin recomprimir y se anota**.
--
-- 2 · EL GPS SE BORRA DEL ARCHIVO, SIEMPRE. Por eso la metadata útil —fecha, cámara, ISO—
--     vive EN COLUMNAS de esta tabla y no dentro del archivo: «una foto reenviada por WhatsApp
--     no puede llevar el domicilio de la paciente dentro».
--
-- 3 · LA COMPARACIÓN NUNCA USA `thumb`. No es un `CHECK`: es que el endpoint de comparar no
--     acepta el tamaño del cliente. Lo que el esquema aporta es `view`, que es la vista por la
--     que se comparan dos fechas cualesquiera.
--
-- 4 · LA CLAVE NO DICE DE QUIÉN ES LA FOTO. `<photo_id>/<derivada>`, con un `photo_id` opaco:
--     ni el nombre, ni la paciente, ni la consulta. Una URL reenviada no revela a quién
--     pertenece. Por eso las claves no se guardan: se DERIVAN del id, y son deterministas.
--
-- Y LA FOTO NO SE EDITA: «una foto que se corrige es una foto nueva». Lo único que cambia es
-- su `view` —y queda en la auditoría— y su estado mientras se procesa.
-- =======================================================================================
CREATE TABLE "photo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"session_id" uuid,
	"view" text NOT NULL,
	"status" text DEFAULT 'esperando_subida' NOT NULL,
	-- Quién la subió decide quién puede borrarla: «la paciente borra las que subió ella y
	-- ninguna más. Las de la doctora son del expediente».
	"uploaded_by" text NOT NULL,
	"declared_type" text NOT NULL,
	"declared_bytes" integer NOT NULL,
	-- Lo que los BYTES REALES resultaron ser, leído por el trabajador. Si no coincide con lo
	-- declarado, la foto queda `fallida` y el objeto se borra del almacenamiento.
	"real_type" text,
	"width" integer,
	"height" integer,
	-- `jxl` cuando la compilación lo trae; `original` cuando no, que es el caso medido el 28 de
	-- octubre de 2026 en sharp 0.34.5 / libvips 8.17.3: NO trae libjxl.
	"master_format" text,
	"master_bytes" integer,
	"derivatives_ready" boolean DEFAULT false NOT NULL,
	"taken_at" timestamp with time zone,
	"camera" text,
	"iso" integer,
	"exposure" text,
	"failed_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photo_view_ck" CHECK ("photo"."view" in
		('frente', 'perfil_izq', 'perfil_der', 'oblicuo_izq', 'oblicuo_der', 'libre')),
	CONSTRAINT "photo_status_ck" CHECK ("photo"."status" in
		('esperando_subida', 'procesando', 'lista', 'fallida')),
	CONSTRAINT "photo_uploaded_by_ck" CHECK ("photo"."uploaded_by" in ('doctora', 'paciente')),
	CONSTRAINT "photo_declared_type_ck" CHECK ("photo"."declared_type" in
		('image/jpeg', 'image/heic', 'image/heif', 'image/png', 'image/x-adobe-dng')),
	CONSTRAINT "photo_bytes_ck" CHECK ("photo"."declared_bytes" > 0),
	-- Una foto `fallida` dice el motivo real: «un hueco sin explicación es peor que el hueco».
	CONSTRAINT "photo_failed_ck" CHECK ("photo"."status" <> 'fallida'
		or "photo"."failed_reason" is not null)
);
--> statement-breakpoint
ALTER TABLE "photo" ADD CONSTRAINT "photo_practice_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "photo" ADD CONSTRAINT "photo_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "photo" ADD CONSTRAINT "photo_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."clinical_session"("id") ON DELETE set null;--> statement-breakpoint

-- La cuadrícula de una ficha, y el par de una vista: las dos lecturas del tramo.
CREATE INDEX "photo_patient_idx" ON "photo" USING btree ("practice_id", "patient_id", "taken_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "photo_view_idx" ON "photo" USING btree ("practice_id", "patient_id", "view", "taken_at");--> statement-breakpoint
CREATE INDEX "photo_session_idx" ON "photo" USING btree ("practice_id", "session_id");--> statement-breakpoint
-- El trabajador reclama por aquí: lo que está esperando proceso y lo que falló menos de tres
-- veces. Parcial, porque lo que ya está `lista` no se vuelve a mirar nunca.
CREATE INDEX "photo_pending_idx" ON "photo" USING btree ("status", "attempts")
  WHERE "status" in ('procesando', 'fallida');--> statement-breakpoint

ALTER TABLE "photo" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "photo" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY photo_practitioner ON "photo" FOR ALL TO app_practitioner
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint
-- La paciente ve las de SU ficha —las suyas y las que le tomó su doctora, que es su progreso—
-- y escribe las suyas. Borrar solo las que subió ella lo decide el caso de uso con
-- `uploaded_by`, porque un `WITH CHECK` no puede mirar la fila que ya existe.
CREATE POLICY photo_patient_select ON "photo" FOR SELECT TO app_patient
  USING (EXISTS (SELECT 1 FROM patient_link l
                  WHERE l.patient_id = photo.patient_id
                    AND l.account_id = medskin_current_account() AND l.status = 'vinculada'));--> statement-breakpoint
CREATE POLICY photo_patient_insert ON "photo" FOR INSERT TO app_patient
  WITH CHECK (uploaded_by = 'paciente'
    AND EXISTS (SELECT 1 FROM patient_link l
                 WHERE l.patient_id = photo.patient_id
                   AND l.account_id = medskin_current_account() AND l.status = 'vinculada'));--> statement-breakpoint
CREATE POLICY photo_patient_update ON "photo" FOR UPDATE TO app_patient
  USING (uploaded_by = 'paciente'
    AND EXISTS (SELECT 1 FROM patient_link l
                 WHERE l.patient_id = photo.patient_id
                   AND l.account_id = medskin_current_account() AND l.status = 'vinculada'))
  WITH CHECK (uploaded_by = 'paciente');--> statement-breakpoint

-- `medskin_access` lee y escribe el estado del proceso: el trabajador corre fuera de la
-- petición y no tiene contexto de inquilino. Es el mismo patrón que el barrido de idempotencia.
CREATE POLICY photo_access ON "photo" FOR ALL TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "photo" TO app_practitioner;--> statement-breakpoint
GRANT SELECT, INSERT ON "photo" TO app_patient;--> statement-breakpoint
GRANT UPDATE (status, deleted_at, deleted_reason, updated_at) ON "photo" TO app_patient;--> statement-breakpoint
GRANT SELECT, UPDATE ON "photo" TO medskin_access;--> statement-breakpoint

-- =======================================================================================
-- LA CUOTA DE ALMACENAMIENTO · `409 cuota_de_la_consulta`
--
-- Se cuenta en bytes de MAESTRA, que es lo que de verdad ocupa: las derivadas son caché y se
-- regeneran. Una función y no una columna, porque un contador que se mantiene a mano se
-- desincroniza en cuanto una foto se borra por detrás.
-- =======================================================================================
CREATE FUNCTION medskin_practice_photo_bytes(p_practice_id uuid)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT coalesce(sum(coalesce(p.master_bytes, p.declared_bytes)), 0)::bigint
    FROM photo p
   WHERE p.practice_id = p_practice_id AND p.deleted_at IS NULL;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_practice_photo_bytes(uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_practice_photo_bytes(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_practice_photo_bytes(uuid) TO app_practitioner, app_patient;
