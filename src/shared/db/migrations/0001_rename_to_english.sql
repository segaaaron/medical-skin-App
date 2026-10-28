-- Tramo 1 · el renombrado a inglés de todo identificador de base.
-- Norma del dueño del 27 de octubre de 2026: los identificadores de base y de código van
-- en inglés; el formato de la API —campos JSON y códigos de error— sigue en español,
-- porque lo fija el contrato y la app de iOS ya lo consume. Los comentarios, en español.
--
-- EL MECANISMO ES `ALTER … RENAME` EN TODO, Y ES LO QUE IMPORTA: preserva los datos y los
-- OID, así que las claves foráneas, los índices, las expresiones de las políticas y los
-- `CHECK` siguen apuntando a lo mismo sin tocarlos. No se hace un solo `DROP` de nada que
-- tenga una fila dentro. PostgreSQL guarda esas expresiones como árbol de análisis con
-- referencias por número de columna, no como texto, así que una columna renombrada
-- arrastra sola todos sus predicados.
--
-- LA EXCEPCIÓN, Y ES UN HALLAZGO: las políticas de la consola comparan
-- `current_user = 'app_plataforma'`, y eso es una CADENA LITERAL dentro del árbol. Un
-- `ALTER ROLE … RENAME` no la toca, así que esas seis políticas quedarían comparando
-- contra un rol que ya no existe: dejarían de dar acceso para siempre y en silencio.
-- Esas seis se vuelven a crear con el literal nuevo (sección 5). Una política no tiene
-- datos, así que recrearla no contradice la regla de arriba.
--
-- §3.4, regla 7: versionada, y NUNCA editada después de aplicarse.

-- =======================================================================================
-- 1 · TABLAS
-- =======================================================================================
ALTER TABLE "cuenta" RENAME TO "account";--> statement-breakpoint
ALTER TABLE "credencial" RENAME TO "credential";--> statement-breakpoint
ALTER TABLE "sesion" RENAME TO "session";--> statement-breakpoint
ALTER TABLE "licencia" RENAME TO "license";--> statement-breakpoint
ALTER TABLE "codigo_recuperacion" RENAME TO "recovery_code";--> statement-breakpoint
ALTER TABLE "clave_idempotencia" RENAME TO "idempotency_key";--> statement-breakpoint
ALTER TABLE "acceso_auditoria" RENAME TO "access_audit";--> statement-breakpoint

-- =======================================================================================
-- 2 · COLUMNAS · se nombran con la tabla YA renombrada
-- `service_failure` no aparece: §10.2 del diseño publica su DDL en inglés y así se creó.
-- =======================================================================================
-- practice → practice
ALTER TABLE "practice" RENAME COLUMN "nombre" TO "name";--> statement-breakpoint
ALTER TABLE "practice" RENAME COLUMN "pais" TO "country";--> statement-breakpoint
ALTER TABLE "practice" RENAME COLUMN "zona_horaria" TO "time_zone";--> statement-breakpoint
ALTER TABLE "practice" RENAME COLUMN "moneda" TO "currency";--> statement-breakpoint
ALTER TABLE "practice" RENAME COLUMN "limite_pacientes" TO "patient_limit";--> statement-breakpoint
ALTER TABLE "practice" RENAME COLUMN "plan_renueva_en" TO "plan_renews_on";--> statement-breakpoint
ALTER TABLE "practice" RENAME COLUMN "estado" TO "status";--> statement-breakpoint
ALTER TABLE "practice" RENAME COLUMN "direccion" TO "address";--> statement-breakpoint
ALTER TABLE "practice" RENAME COLUMN "ciudad" TO "city";--> statement-breakpoint
ALTER TABLE "practice" RENAME COLUMN "telefono" TO "phone";--> statement-breakpoint
ALTER TABLE "practice" RENAME COLUMN "nota_interna" TO "internal_note";--> statement-breakpoint
ALTER TABLE "practice" RENAME COLUMN "primer_dia_datos_consulta" TO "first_day_practice_data";--> statement-breakpoint
ALTER TABLE "practice" RENAME COLUMN "primer_dia_horarios" TO "first_day_schedule";--> statement-breakpoint
ALTER TABLE "practice" RENAME COLUMN "primer_dia_primer_tratamiento" TO "first_day_first_treatment";--> statement-breakpoint
ALTER TABLE "practice" RENAME COLUMN "primer_dia_cerrada" TO "first_day_dismissed";--> statement-breakpoint
ALTER TABLE "practice" RENAME COLUMN "creado_en" TO "created_at";--> statement-breakpoint
ALTER TABLE "practice" RENAME COLUMN "actualizado_en" TO "updated_at";--> statement-breakpoint
-- licencia → license
ALTER TABLE "license" RENAME COLUMN "estado" TO "status";--> statement-breakpoint
ALTER TABLE "license" RENAME COLUMN "pais_ejercicio" TO "practice_country";--> statement-breakpoint
ALTER TABLE "license" RENAME COLUMN "especialidad" TO "specialty";--> statement-breakpoint
ALTER TABLE "license" RENAME COLUMN "matricula" TO "license_number";--> statement-breakpoint
ALTER TABLE "license" RENAME COLUMN "credencial_clave" TO "credential_key";--> statement-breakpoint
ALTER TABLE "license" RENAME COLUMN "declaracion_aceptada" TO "declaration_accepted";--> statement-breakpoint
ALTER TABLE "license" RENAME COLUMN "terminos_aceptados" TO "terms_accepted";--> statement-breakpoint
ALTER TABLE "license" RENAME COLUMN "enviada_en" TO "submitted_at";--> statement-breakpoint
ALTER TABLE "license" RENAME COLUMN "respuesta_estimada_en" TO "response_estimated_at";--> statement-breakpoint
ALTER TABLE "license" RENAME COLUMN "decidida_en" TO "decided_at";--> statement-breakpoint
ALTER TABLE "license" RENAME COLUMN "motivo_rechazo" TO "rejection_reason";--> statement-breakpoint
ALTER TABLE "license" RENAME COLUMN "revisada_por" TO "reviewed_by";--> statement-breakpoint
ALTER TABLE "license" RENAME COLUMN "creado_en" TO "created_at";--> statement-breakpoint
ALTER TABLE "license" RENAME COLUMN "actualizado_en" TO "updated_at";--> statement-breakpoint
-- practitioner → practitioner
ALTER TABLE "practitioner" RENAME COLUMN "cuenta_id" TO "account_id";--> statement-breakpoint
ALTER TABLE "practitioner" RENAME COLUMN "nombre" TO "first_name";--> statement-breakpoint
ALTER TABLE "practitioner" RENAME COLUMN "apellido" TO "last_name";--> statement-breakpoint
ALTER TABLE "practitioner" RENAME COLUMN "rol" TO "role";--> statement-breakpoint
ALTER TABLE "practitioner" RENAME COLUMN "estado" TO "status";--> statement-breakpoint
ALTER TABLE "practitioner" RENAME COLUMN "creado_en" TO "created_at";--> statement-breakpoint
ALTER TABLE "practitioner" RENAME COLUMN "actualizado_en" TO "updated_at";--> statement-breakpoint
-- cuenta → account
ALTER TABLE "account" RENAME COLUMN "correo" TO "email";--> statement-breakpoint
ALTER TABLE "account" RENAME COLUMN "rol" TO "role";--> statement-breakpoint
ALTER TABLE "account" RENAME COLUMN "nombre" TO "first_name";--> statement-breakpoint
ALTER TABLE "account" RENAME COLUMN "apellido" TO "last_name";--> statement-breakpoint
ALTER TABLE "account" RENAME COLUMN "celular" TO "phone";--> statement-breakpoint
ALTER TABLE "account" RENAME COLUMN "estado" TO "status";--> statement-breakpoint
ALTER TABLE "account" RENAME COLUMN "intentos_fallidos" TO "failed_attempts";--> statement-breakpoint
ALTER TABLE "account" RENAME COLUMN "pausa_hasta" TO "locked_until";--> statement-breakpoint
ALTER TABLE "account" RENAME COLUMN "borrado_en" TO "deleted_at";--> statement-breakpoint
ALTER TABLE "account" RENAME COLUMN "motivo_borrado" TO "deletion_reason";--> statement-breakpoint
ALTER TABLE "account" RENAME COLUMN "creado_en" TO "created_at";--> statement-breakpoint
ALTER TABLE "account" RENAME COLUMN "actualizado_en" TO "updated_at";--> statement-breakpoint
-- credencial → credential
ALTER TABLE "credential" RENAME COLUMN "cuenta_id" TO "account_id";--> statement-breakpoint
ALTER TABLE "credential" RENAME COLUMN "es_temporal" TO "is_temporary";--> statement-breakpoint
ALTER TABLE "credential" RENAME COLUMN "temporal_caduca_en" TO "temp_expires_at";--> statement-breakpoint
ALTER TABLE "credential" RENAME COLUMN "temporal_usada_en" TO "temp_used_at";--> statement-breakpoint
ALTER TABLE "credential" RENAME COLUMN "establecida_en" TO "set_at";--> statement-breakpoint
ALTER TABLE "credential" RENAME COLUMN "creado_en" TO "created_at";--> statement-breakpoint
ALTER TABLE "credential" RENAME COLUMN "actualizado_en" TO "updated_at";--> statement-breakpoint
-- sesion → session
ALTER TABLE "session" RENAME COLUMN "cuenta_id" TO "account_id";--> statement-breakpoint
ALTER TABLE "session" RENAME COLUMN "alcance" TO "scope";--> statement-breakpoint
ALTER TABLE "session" RENAME COLUMN "refresco_hash" TO "refresh_hash";--> statement-breakpoint
ALTER TABLE "session" RENAME COLUMN "refresco_caduca_en" TO "refresh_expires_at";--> statement-breakpoint
ALTER TABLE "session" RENAME COLUMN "refresco_rotado_en" TO "refresh_rotated_at";--> statement-breakpoint
ALTER TABLE "session" RENAME COLUMN "refresco_anterior_hash" TO "previous_refresh_hash";--> statement-breakpoint
ALTER TABLE "session" RENAME COLUMN "revocada_en" TO "revoked_at";--> statement-breakpoint
ALTER TABLE "session" RENAME COLUMN "revocada_motivo" TO "revoked_reason";--> statement-breakpoint
ALTER TABLE "session" RENAME COLUMN "dispositivo_id" TO "device_id";--> statement-breakpoint
ALTER TABLE "session" RENAME COLUMN "dispositivo" TO "device";--> statement-breakpoint
ALTER TABLE "session" RENAME COLUMN "sistema" TO "os";--> statement-breakpoint
ALTER TABLE "session" RENAME COLUMN "plataforma" TO "platform";--> statement-breakpoint
ALTER TABLE "session" RENAME COLUMN "ciudad" TO "city";--> statement-breakpoint
ALTER TABLE "session" RENAME COLUMN "entro_en" TO "signed_in_at";--> statement-breakpoint
ALTER TABLE "session" RENAME COLUMN "ultima_vez" TO "last_seen_at";--> statement-breakpoint
-- codigo_recuperacion → recovery_code
ALTER TABLE "recovery_code" RENAME COLUMN "cuenta_id" TO "account_id";--> statement-breakpoint
ALTER TABLE "recovery_code" RENAME COLUMN "codigo_hash" TO "code_hash";--> statement-breakpoint
ALTER TABLE "recovery_code" RENAME COLUMN "caduca_en" TO "expires_at";--> statement-breakpoint
ALTER TABLE "recovery_code" RENAME COLUMN "intentos" TO "attempts";--> statement-breakpoint
ALTER TABLE "recovery_code" RENAME COLUMN "usada_en" TO "used_at";--> statement-breakpoint
ALTER TABLE "recovery_code" RENAME COLUMN "anulada_en" TO "voided_at";--> statement-breakpoint
ALTER TABLE "recovery_code" RENAME COLUMN "anulada_motivo" TO "voided_reason";--> statement-breakpoint
ALTER TABLE "recovery_code" RENAME COLUMN "creado_en" TO "created_at";--> statement-breakpoint
-- clave_idempotencia → idempotency_key
ALTER TABLE "idempotency_key" RENAME COLUMN "clave" TO "key";--> statement-breakpoint
ALTER TABLE "idempotency_key" RENAME COLUMN "cuenta_id" TO "account_id";--> statement-breakpoint
ALTER TABLE "idempotency_key" RENAME COLUMN "cuerpo_hash" TO "body_hash";--> statement-breakpoint
ALTER TABLE "idempotency_key" RENAME COLUMN "estado_http" TO "http_status";--> statement-breakpoint
ALTER TABLE "idempotency_key" RENAME COLUMN "respuesta" TO "response";--> statement-breakpoint
ALTER TABLE "idempotency_key" RENAME COLUMN "creado_en" TO "created_at";--> statement-breakpoint
ALTER TABLE "idempotency_key" RENAME COLUMN "caduca_en" TO "expires_at";--> statement-breakpoint
-- acceso_auditoria → access_audit
ALTER TABLE "access_audit" RENAME COLUMN "ocurrio_en" TO "occurred_at";--> statement-breakpoint
ALTER TABLE "access_audit" RENAME COLUMN "actor_cuenta_id" TO "actor_account_id";--> statement-breakpoint
ALTER TABLE "access_audit" RENAME COLUMN "actor_etiqueta" TO "actor_label";--> statement-breakpoint
ALTER TABLE "access_audit" RENAME COLUMN "accion" TO "action";--> statement-breakpoint
ALTER TABLE "access_audit" RENAME COLUMN "sujeto_tipo" TO "subject_type";--> statement-breakpoint
ALTER TABLE "access_audit" RENAME COLUMN "sujeto_id" TO "subject_id";--> statement-breakpoint
ALTER TABLE "access_audit" RENAME COLUMN "datos" TO "data";--> statement-breakpoint

-- =======================================================================================
-- 3 · RESTRICCIONES · claves primarias, foráneas y `CHECK`
-- Las expresiones de los `CHECK` no se reescriben: ya apuntan a las columnas nuevas.
-- =======================================================================================
ALTER TABLE "access_audit" RENAME CONSTRAINT "acceso_auditoria_pkey" TO "access_audit_pkey";--> statement-breakpoint
ALTER TABLE "idempotency_key" RENAME CONSTRAINT "clave_idempotencia_cuenta_id_clave_pk" TO "idempotency_key_account_id_key_pk";--> statement-breakpoint
ALTER TABLE "recovery_code" RENAME CONSTRAINT "codigo_recuperacion_pkey" TO "recovery_code_pkey";--> statement-breakpoint
ALTER TABLE "recovery_code" RENAME CONSTRAINT "codigo_recuperacion_anulada_ck" TO "recovery_code_voided_ck";--> statement-breakpoint
ALTER TABLE "recovery_code" RENAME CONSTRAINT "codigo_recuperacion_intentos_ck" TO "recovery_code_attempts_ck";--> statement-breakpoint
ALTER TABLE "recovery_code" RENAME CONSTRAINT "codigo_recuperacion_cuenta_id_cuenta_id_fk" TO "recovery_code_account_id_account_id_fk";--> statement-breakpoint
ALTER TABLE "credential" RENAME CONSTRAINT "credencial_pkey" TO "credential_pkey";--> statement-breakpoint
ALTER TABLE "credential" RENAME CONSTRAINT "credencial_temporal_caduca_ck" TO "credential_temp_expires_ck";--> statement-breakpoint
ALTER TABLE "credential" RENAME CONSTRAINT "credencial_cuenta_id_cuenta_id_fk" TO "credential_account_id_account_id_fk";--> statement-breakpoint
ALTER TABLE "account" RENAME CONSTRAINT "cuenta_pkey" TO "account_pkey";--> statement-breakpoint
ALTER TABLE "account" RENAME CONSTRAINT "cuenta_estado_ck" TO "account_status_ck";--> statement-breakpoint
ALTER TABLE "account" RENAME CONSTRAINT "cuenta_region_ck" TO "account_region_ck";--> statement-breakpoint
ALTER TABLE "account" RENAME CONSTRAINT "cuenta_rol_ck" TO "account_role_ck";--> statement-breakpoint
ALTER TABLE "license" RENAME CONSTRAINT "licencia_pkey" TO "license_pkey";--> statement-breakpoint
ALTER TABLE "license" RENAME CONSTRAINT "licencia_estado_ck" TO "license_status_ck";--> statement-breakpoint
ALTER TABLE "license" RENAME CONSTRAINT "licencia_matricula_ck" TO "license_number_ck";--> statement-breakpoint
ALTER TABLE "license" RENAME CONSTRAINT "licencia_motivo_rechazo_ck" TO "license_rejection_reason_ck";--> statement-breakpoint
ALTER TABLE "license" RENAME CONSTRAINT "licencia_practice_id_practice_id_fk" TO "license_practice_id_practice_id_fk";--> statement-breakpoint
ALTER TABLE "practice" RENAME CONSTRAINT "practice_estado_ck" TO "practice_status_ck";--> statement-breakpoint
ALTER TABLE "practice" RENAME CONSTRAINT "practice_nombre_ck" TO "practice_name_ck";--> statement-breakpoint
ALTER TABLE "practice" RENAME CONSTRAINT "practice_pais_ck" TO "practice_country_ck";--> statement-breakpoint
ALTER TABLE "practitioner" RENAME CONSTRAINT "practitioner_estado_ck" TO "practitioner_status_ck";--> statement-breakpoint
ALTER TABLE "practitioner" RENAME CONSTRAINT "practitioner_rol_ck" TO "practitioner_role_ck";--> statement-breakpoint
ALTER TABLE "practitioner" RENAME CONSTRAINT "practitioner_cuenta_id_cuenta_id_fk" TO "practitioner_account_id_account_id_fk";--> statement-breakpoint
ALTER TABLE "session" RENAME CONSTRAINT "sesion_pkey" TO "session_pkey";--> statement-breakpoint
ALTER TABLE "session" RENAME CONSTRAINT "sesion_alcance_ck" TO "session_scope_ck";--> statement-breakpoint
ALTER TABLE "session" RENAME CONSTRAINT "sesion_alcance_sin_refresco_ck" TO "session_scope_without_refresh_ck";--> statement-breakpoint
ALTER TABLE "session" RENAME CONSTRAINT "sesion_plataforma_ck" TO "session_platform_ck";--> statement-breakpoint
ALTER TABLE "session" RENAME CONSTRAINT "sesion_cuenta_id_cuenta_id_fk" TO "session_account_id_account_id_fk";--> statement-breakpoint
ALTER TABLE "session" RENAME CONSTRAINT "sesion_practice_id_practice_id_fk" TO "session_practice_id_practice_id_fk";--> statement-breakpoint

-- =======================================================================================
-- 4 · ÍNDICES Y SECUENCIAS
-- Renombrar una tabla no renombra su secuencia ni sus índices: van uno a uno.
-- =======================================================================================
ALTER INDEX "acceso_auditoria_accion_idx" RENAME TO "access_audit_action_idx";--> statement-breakpoint
ALTER INDEX "acceso_auditoria_actor_idx" RENAME TO "access_audit_actor_idx";--> statement-breakpoint
ALTER INDEX "acceso_auditoria_practice_idx" RENAME TO "access_audit_practice_idx";--> statement-breakpoint
ALTER INDEX "clave_idempotencia_practice_idx" RENAME TO "idempotency_key_practice_idx";--> statement-breakpoint
ALTER INDEX "clave_idempotencia_purga_idx" RENAME TO "idempotency_key_purge_idx";--> statement-breakpoint
ALTER INDEX "codigo_recuperacion_cuenta_idx" RENAME TO "recovery_code_account_idx";--> statement-breakpoint
ALTER INDEX "codigo_recuperacion_vivo_uq" RENAME TO "recovery_code_live_uq";--> statement-breakpoint
ALTER INDEX "credencial_cuenta_uq" RENAME TO "credential_account_uq";--> statement-breakpoint
ALTER INDEX "cuenta_correo_uq" RENAME TO "account_email_uq";--> statement-breakpoint
ALTER INDEX "licencia_cola_revision_idx" RENAME TO "license_review_queue_idx";--> statement-breakpoint
ALTER INDEX "licencia_practice_uq" RENAME TO "license_practice_uq";--> statement-breakpoint
ALTER INDEX "practitioner_cuenta_idx" RENAME TO "practitioner_account_idx";--> statement-breakpoint
ALTER INDEX "practitioner_practice_cuenta_uq" RENAME TO "practitioner_practice_account_uq";--> statement-breakpoint
ALTER INDEX "practitioner_practice_estado_idx" RENAME TO "practitioner_practice_status_idx";--> statement-breakpoint
ALTER INDEX "service_failure_codigo_idx" RENAME TO "service_failure_code_idx";--> statement-breakpoint
ALTER INDEX "service_failure_operacion_idx" RENAME TO "service_failure_operation_idx";--> statement-breakpoint
ALTER INDEX "sesion_cuenta_activas_idx" RENAME TO "session_account_active_idx";--> statement-breakpoint
ALTER INDEX "sesion_practice_idx" RENAME TO "session_practice_idx";--> statement-breakpoint
ALTER INDEX "sesion_refresco_anterior_idx" RENAME TO "session_previous_refresh_idx";--> statement-breakpoint
ALTER INDEX "sesion_refresco_uq" RENAME TO "session_refresh_uq";--> statement-breakpoint
ALTER SEQUENCE "acceso_auditoria_id_seq" RENAME TO "access_audit_id_seq";--> statement-breakpoint

-- =======================================================================================
-- 5 · LOS ROLES DE BASE, Y LAS SEIS POLÍTICAS QUE EL RENOMBRADO HABRÍA DEJADO MUERTAS
--
-- `ALTER ROLE … RENAME` conserva el OID, así que los `GRANT` y la lista `TO` de cada
-- política siguen apuntando al mismo rol sin tocarlos. Lo que NO sigue es el literal
-- `'app_plataforma'` del cuerpo de las políticas de la consola: ahí el nombre viaja como
-- texto. Se renombra primero y se recrean esas seis después, en la misma migración, para
-- que no exista ni un instante con el rol nuevo y el literal viejo.
--
-- El guardado del `DO` es por el caso del napkin: quien tira la base y vuelve a migrar
-- hace que la 0000 cree otra vez los nombres en español sobre tablas nuevas, mientras los
-- nombres en inglés siguen en el clúster con privilegios de objetos que ya no existen. En
-- ese caso el que vale es el que acaba de recibir los `GRANT`: se descarta el vacío y se
-- renombra el que los tiene.
-- =======================================================================================
DO $$
DECLARE
  pares text[][] := ARRAY[
    ARRAY['app_doctora',    'app_practitioner'],
    ARRAY['app_paciente',   'app_patient'],
    ARRAY['app_plataforma', 'app_platform']
  ];
  par text[];
  viejo text;
  nuevo text;
BEGIN
  FOREACH par SLICE 1 IN ARRAY pares LOOP
    viejo := par[1];
    nuevo := par[2];
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = viejo)
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = nuevo) THEN
      EXECUTE format('DROP OWNED BY %I', nuevo);
      EXECUTE format('DROP ROLE %I', nuevo);
      EXECUTE format('ALTER ROLE %I RENAME TO %I', viejo, nuevo);
    ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = viejo) THEN
      EXECUTE format('ALTER ROLE %I RENAME TO %I', viejo, nuevo);
    END IF;
  END LOOP;
END
$$;--> statement-breakpoint
ALTER POLICY "acceso_auditoria_doctora_lee" ON "access_audit" RENAME TO "access_audit_practitioner_select";--> statement-breakpoint
ALTER POLICY "acceso_auditoria_escribe" ON "access_audit" RENAME TO "access_audit_insert";--> statement-breakpoint
ALTER POLICY "clave_idempotencia_doctora" ON "idempotency_key" RENAME TO "idempotency_key_practitioner";--> statement-breakpoint
ALTER POLICY "clave_idempotencia_paciente" ON "idempotency_key" RENAME TO "idempotency_key_patient";--> statement-breakpoint
ALTER POLICY "codigo_recuperacion_propio" ON "recovery_code" RENAME TO "recovery_code_own";--> statement-breakpoint
ALTER POLICY "credencial_propia" ON "credential" RENAME TO "credential_own";--> statement-breakpoint
ALTER POLICY "cuenta_propia" ON "account" RENAME TO "account_own";--> statement-breakpoint
ALTER POLICY "licencia_doctora_edita" ON "license" RENAME TO "license_practitioner_update";--> statement-breakpoint
ALTER POLICY "licencia_doctora_lee" ON "license" RENAME TO "license_practitioner_select";--> statement-breakpoint
ALTER POLICY "practice_doctora_edita" ON "practice" RENAME TO "practice_practitioner_update";--> statement-breakpoint
ALTER POLICY "practice_doctora_lee" ON "practice" RENAME TO "practice_practitioner_select";--> statement-breakpoint
ALTER POLICY "practitioner_doctora" ON "practitioner" RENAME TO "practitioner_team";--> statement-breakpoint
ALTER POLICY "service_failure_doctora_lee" ON "service_failure" RENAME TO "service_failure_practitioner_select";--> statement-breakpoint
ALTER POLICY "service_failure_escribe" ON "service_failure" RENAME TO "service_failure_insert";--> statement-breakpoint
ALTER POLICY "sesion_propia" ON "session" RENAME TO "session_own";--> statement-breakpoint

-- =======================================================================================
-- 5 bis · LAS DOS FUNCIONES DE CONTEXTO, Y LA VARIABLE DE SESIÓN
--
-- `medskin.practice_id` ya estaba en inglés. `medskin.cuenta_id` pasa a
-- `medskin.account_id`, y eso sí es texto dentro del cuerpo de la función: se renombra la
-- función y se reemplaza su cuerpo con el mismo `CREATE OR REPLACE`, que conserva el OID
-- —y por tanto todas las políticas que la llaman— y conserva su ACL.
--
-- Siguen `STABLE` (§7.3, regla 3: una VOLATILE en una política pasó de 0,3 ms a cerca de
-- 1 900 ms en PostgreSQL 17) y siguen sin `LEAKPROOF`, por el motivo que explica la 0000.
-- `EXECUTE` sigue abierto a PUBLIC a propósito: las llama la política, así que la tiene
-- que poder ejecutar el rol que consulta. No leen filas: leen un parámetro de la
-- transacción.
-- =======================================================================================
ALTER FUNCTION medskin_practice_actual() RENAME TO medskin_current_practice;--> statement-breakpoint
ALTER FUNCTION medskin_cuenta_actual() RENAME TO medskin_current_account;--> statement-breakpoint
CREATE OR REPLACE FUNCTION medskin_current_account() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('medskin.account_id', true), '')::uuid $$;--> statement-breakpoint

-- =======================================================================================
-- 6 · LAS SEIS POLÍTICAS DE LA CONSOLA, RECREADAS CON EL LITERAL NUEVO
-- Van al final porque una de ellas llama a `medskin_current_account()`, que hasta la
-- sección anterior se llamaba de otra manera.
-- =======================================================================================
-- Y las seis de la consola, recreadas con el literal nuevo. Mismo alcance, mismas
-- columnas, misma regla: lo único que cambia es cómo se escribe el nombre del rol.
DROP POLICY "practice_plataforma" ON "practice";--> statement-breakpoint
CREATE POLICY practice_platform ON "practice" FOR ALL TO app_platform
  USING (current_user = 'app_platform')
  WITH CHECK (current_user = 'app_platform');--> statement-breakpoint
DROP POLICY "licencia_plataforma" ON "license";--> statement-breakpoint
CREATE POLICY license_platform ON "license" FOR ALL TO app_platform
  USING (current_user = 'app_platform')
  WITH CHECK (current_user = 'app_platform');--> statement-breakpoint
DROP POLICY "cuenta_plataforma" ON "account";--> statement-breakpoint
CREATE POLICY account_platform ON "account" FOR ALL TO app_platform
  USING (current_user = 'app_platform')
  WITH CHECK (current_user = 'app_platform');--> statement-breakpoint
DROP POLICY "clave_idempotencia_plataforma" ON "idempotency_key";--> statement-breakpoint
CREATE POLICY idempotency_key_platform ON "idempotency_key" FOR ALL TO app_platform
  USING (current_user = 'app_platform' AND account_id = medskin_current_account())
  WITH CHECK (current_user = 'app_platform' AND account_id = medskin_current_account());--> statement-breakpoint
DROP POLICY "service_failure_plataforma" ON "service_failure";--> statement-breakpoint
CREATE POLICY service_failure_platform ON "service_failure" FOR ALL TO app_platform
  USING (current_user = 'app_platform')
  WITH CHECK (current_user = 'app_platform');--> statement-breakpoint
DROP POLICY "acceso_auditoria_plataforma_lee" ON "access_audit";--> statement-breakpoint
CREATE POLICY access_audit_platform_select ON "access_audit" FOR SELECT TO app_platform
  USING (current_user = 'app_platform');--> statement-breakpoint

