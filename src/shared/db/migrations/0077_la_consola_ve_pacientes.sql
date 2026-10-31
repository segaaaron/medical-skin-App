-- =======================================================================================
-- LA CONSOLA VE PACIENTES, Y ESTO REVIERTE UNA PROMESA DEL DISEÑO · 31 de octubre de 2026
--
-- **DECIDIDO POR EL DUEÑO el 31 de octubre de 2026**, y queda escrito aquí porque el
-- repositorio es donde vive la autoría de una decisión de esta clase. La consola interna de
-- soporte pasa a poder dar de alta pacientes, administrarlas y LEER su historia clínica.
--
-- Hasta hoy `app_platform` tenía **cero políticas** sobre `patient`, `patient_link` y
-- `medical_history`: no era un filtro del código, era que la consulta devolvía «permission
-- denied» aunque alguien la escribiera a mano. Dos pruebas contra la base lo fijaban a
-- propósito, y se actualizan con esta migración en vez de borrarse en silencio.
--
-- LA FRASE QUE DEJA DE SER VERDAD, y hay que decirlo aquí: «soporte ve metadatos y estados,
-- nunca contenido de pacientes» (`consultas.md`). Se corrige en el mismo commit. Una promesa
-- que el sistema ya no cumple es peor que no haberla hecho.
--
-- LA FRASE QUE SIGUE SIENDO VERDAD, Y ES LA CONDICIÓN DE TODO ESTO · `medskin-design.md` §4:
-- «No existe un rol que pueda mirar historiales sin que el doctor lo sepa.» Sobrevive, y no
-- por buena voluntad: la lectura de historia pasa por `medskin_platform_history_read()`, que
-- deja la fila de auditoría CON el `practice_id` de la paciente — que es lo que hace que el
-- doctor la vea, porque su política es `practice_id = medskin_current_practice()`.
--
-- Esa columna admite nulo, así que una fila mal escrita quedaría invisible para él. Por eso la
-- función resuelve el `practice_id` DESDE `patient` y no lo recibe: no hay nada que falsear.
-- =======================================================================================

-- ---------------------------------------------------------------------------------------
-- 1 · `patient` · LEER, CREAR, Y ARCHIVAR. Nada más.
--
-- El `UPDATE` va por COLUMNA y son tres: archivar y reactivar mueven `status` y
-- `archived_at`. Soporte **no corrige el nombre ni el correo de una paciente** — eso es la
-- ficha clínica de alguien y lo edita quien la atiende. Un `UPDATE` de tabla entera habría
-- dado las diecisiete columnas por el precio de dos.
--
-- Sin `DELETE`: el expediente se conserva su plazo legal y lo borra el barrido de retención,
-- no una persona con prisa.
-- ---------------------------------------------------------------------------------------
CREATE POLICY patient_platform ON "patient" FOR ALL TO app_platform
  USING (current_user = 'app_platform')
  WITH CHECK (current_user = 'app_platform');--> statement-breakpoint

GRANT SELECT, INSERT ON "patient" TO app_platform;--> statement-breakpoint
GRANT UPDATE ("status", "archived_at", "updated_at") ON "patient" TO app_platform;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 2 · `patient_link` · SOLO LEER
--
-- La consola necesita saber si la paciente tiene cuenta y en qué estado está su vínculo, que
-- es lo que su pantalla pinta. No lo escribe: el vínculo lo crea el alta a través de la
-- función que ya existe, y aceptarlo o rechazarlo es un acto de la paciente.
-- ---------------------------------------------------------------------------------------
CREATE POLICY patient_link_platform ON "patient_link" FOR SELECT TO app_platform
  USING (current_user = 'app_platform');--> statement-breakpoint

GRANT SELECT ON "patient_link" TO app_platform;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 3 · `medical_history` · SOLO `SELECT`, Y ESTA ES LA LÍNEA
--
-- `FOR SELECT` en la política y `GRANT SELECT` a secas: ni INSERT, ni UPDATE, ni DELETE, ni
-- ahora ni detrás de una bandera. **La consola no escribe expedientes**, y el motivo no es de
-- permisos sino de verdad del dato: cada campo guarda su `fuente`, así que una alergia
-- tecleada por soporte diría `fuente: 'doctor'` cuando el doctor nunca lo dijo. Eso no es un
-- permiso de más, es un dato falso en un expediente clínico — y el valor de ayer es lo que
-- explica una reacción de mañana.
--
-- Que la política sea `FOR SELECT` y no `FOR ALL` es deliberado: así ni un `GRANT` añadido por
-- error en el futuro abre la escritura, porque no habría política que la admitiera.
-- ---------------------------------------------------------------------------------------
CREATE POLICY medical_history_platform ON "medical_history" FOR SELECT TO app_platform
  USING (current_user = 'app_platform');--> statement-breakpoint

GRANT SELECT ON "medical_history" TO app_platform;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 4 · LA LECTURA DE HISTORIA DEJA SU FILA, Y SIN ELLA NO HAY LECTURA
--
-- `SECURITY DEFINER` porque tiene que escribir en `access_audit` con un `practice_id` que
-- quien llama no puede elegir: lo resuelve desde `patient`. Devuelve ese `practice_id` —o
-- NULL si esa paciente no existe—, y el llamador usa eso como su `404`: así la auditoría y la
-- comprobación de existencia son la MISMA operación y no se pueden separar por accidente.
--
-- El motivo lo escribe quien mira y es obligatorio, de 10 a 300. No es decoración: el día que
-- alguien pregunte quién leyó qué, «soporte, el martes» no es una respuesta.
--
-- Va en la MISMA transacción que la lectura, y es responsabilidad del repositorio: si la
-- auditoría falla, la lectura falla. Auditar después del `COMMIT` es no auditar.
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION medskin_platform_history_read(p_patient_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_practice uuid;
  v_region text;
  v_actor uuid := medskin_current_account();
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'medskin_platform_history_read: sin contexto de cuenta'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- El motivo se valida ANTES de resolver nada: una petición sin motivo no llega a tocar la
  -- fila de ninguna paciente, ni para comprobar que existe.
  IF length(v_reason) < 10 OR length(v_reason) > 300 THEN
    RAISE EXCEPTION 'medskin_platform_history_read: el motivo tiene que medir entre 10 y 300'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT p.practice_id, pr.region INTO v_practice, v_region
    FROM patient p JOIN practice pr ON pr.id = p.practice_id
   WHERE p.id = p_patient_id;

  -- Sin paciente no hay nada que auditar y no hay nada que leer: el llamador lo convierte en
  -- su 404. NO se deja fila: auditar una lectura que no ocurrió ensucia el registro que el
  -- doctor va a leer.
  IF v_practice IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO access_audit (practice_id, actor_account_id, actor_label, action,
                            subject_type, subject_id, data, region)
  VALUES (v_practice, v_actor, 'Consola MedSkin', 'platform.history.read', 'patient',
          p_patient_id, jsonb_build_object('motivo', v_reason), v_region);

  RETURN v_practice;
END
$fn$;--> statement-breakpoint

ALTER FUNCTION medskin_platform_history_read(uuid, text) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_platform_history_read(uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_platform_history_read(uuid, text) TO app_platform;
