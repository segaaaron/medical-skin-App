-- =======================================================================================
-- SUSPENDER Y BORRAR UNA CONSULTA · 3 de noviembre de 2026 · pedido por el dueño
--
-- Dos acciones DISTINTAS sobre una consulta, y una no sustituye a la otra:
--
--   · SUSPENDER  · la doctora deja de poder entrar. Se deshace. No toca un solo dato.
--   · BORRAR     · desaparece la consulta y todo lo ligado a ella. No se deshace.
--
-- =======================================================================================
-- 1 · EL ESTADO YA EXISTÍA Y NO LO MIRABA NADIE
-- =======================================================================================
--
-- `practice.status in ('activa','pausada')` está desde la migración 0000 y en tres años de
-- código NADIE lo escribe y NADIE lo lee: medido el 3 de noviembre con un `grep` sobre todo
-- `src/` —una sola aparición, la definición de la restricción— y sobre las políticas de la
-- base. Era un valor huérfano que alguien puso al crear la tabla.
--
-- Eso importa para esta migración: añadir la ruta de suspender SIN la comprobación del acceso
-- habría dado un interruptor que no apaga nada. La ruta y la guarda entran juntas o no entran.
--
-- Y se renombra el valor: `pausada` -> `suspendida`. «Pausa» ya nombra otra cosa en este
-- producto —los 15 minutos tras cinco contraseñas mal— y dos cosas con el mismo nombre ya
-- causaron una confusión real: la consola pidió «pausar una consulta» creyendo que existía.
-- Ninguna fila tiene `pausada` (nadie la escribió nunca), así que el renombrado no migra datos.
--
-- =======================================================================================
-- 2 · A QUIÉN AFECTA SUSPENDER, Y A QUIÉN NO
-- =======================================================================================
--
-- Afecta a QUIEN TRABAJA EN LA CONSULTA, y a nadie más. Las pacientes NO se ven afectadas, y
-- no por una decisión de esta migración sino porque sus políticas ya dependían de otra cosa:
-- `treatment_patient_select` y sus cinco hermanas cuelgan de `patient_link.status`, nunca de
-- `practice.status`. Comprobado leyendo las políticas, no suponiéndolo.
--
-- Esto es lo que el dueño pidió: «que solo suspenda al doctor».
--
-- =======================================================================================
-- 3 · LA FUNCIÓN DEL ACCESO DEVUELVE EL ESTADO DE LA CONSULTA
-- =======================================================================================
--
-- `DROP` + `CREATE` y no `CREATE OR REPLACE`: cambia el tipo de la tabla que devuelve, y
-- PostgreSQL no deja reemplazar una función cambiando su salida. El cuerpo es el de la función
-- aplicada, COPIADO y con una sola línea añadida — no reescrito de memoria.
-- =======================================================================================

ALTER TABLE "practice" DROP CONSTRAINT "practice_status_ck";--> statement-breakpoint
ALTER TABLE "practice" ADD CONSTRAINT "practice_status_ck"
  CHECK ("practice"."status" in ('activa', 'suspendida'));--> statement-breakpoint

DROP FUNCTION IF EXISTS medskin_access_credential(citext);--> statement-breakpoint

CREATE FUNCTION medskin_access_credential(p_email citext)
RETURNS TABLE(account_id uuid, role text, status text, region text, hash text,
              is_temporary boolean, temp_expires_at timestamptz,
              temp_first_used_at timestamptz, temp_used_at timestamptz,
              locked_until timestamptz, attempts_left integer, practice_id uuid,
              practitioner_role text, permissions text[], practice_status text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_decoy text;
BEGIN
  IF p_email IS NULL OR btrim(p_email::text) = '' THEN
    RAISE EXCEPTION 'medskin_access_credential: correo vacio'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT d.hash INTO v_decoy FROM access_decoy d WHERE d.only_row;
  IF v_decoy IS NULL THEN
    -- Sin señuelo no hay «mismo tiempo», y sin «mismo tiempo» el 401 miente. Antes
    -- fallar el acceso entero que servirlo con el oráculo abierto.
    RAISE EXCEPTION 'medskin_access_credential: falta el hash senuelo'
      USING ERRCODE = 'internal_error';
  END IF;

  RETURN QUERY
    SELECT a.id, a.role, a.status, a.region,
           coalesce(c.hash, v_decoy),
           coalesce(c.is_temporary, false),
           c.temp_expires_at, c.temp_first_used_at, c.temp_used_at, a.locked_until,
           greatest(5 - a.failed_attempts, 0),
           pr.practice_id, pr.role, pr.permissions,
           -- LA LÍNEA NUEVA. Nula para una paciente —no tiene consulta— y nula para un correo
           -- que no existe: quien la lee trata el nulo como «no aplica», nunca como suspendida.
           pr.practice_status
      FROM account a
      LEFT JOIN credential c ON c.account_id = a.id
      -- LATERAL con LIMIT 1: una cuenta en dos consultas no puede devolver dos filas,
      -- porque entonces el llamador tendría que elegir y el token lleva un solo
      -- `practice`. La más antigua, de forma determinista.
      LEFT JOIN LATERAL (
        SELECT p.practice_id, p.role, p.permissions, pc.status AS practice_status
          FROM practitioner p
          JOIN practice pc ON pc.id = p.practice_id
         WHERE p.account_id = a.id AND p.status = 'activa'
         ORDER BY p.created_at, p.id LIMIT 1
      ) pr ON true
     WHERE a.email = p_email AND a.deleted_at IS NULL AND a.status <> 'borrada';

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, NULL::text, NULL::text, v_decoy,
                        false, NULL::timestamptz, NULL::timestamptz, NULL::timestamptz,
                        NULL::timestamptz, 5, NULL::uuid, NULL::text, NULL::text[],
                        NULL::text;
  END IF;
END
$function$;--> statement-breakpoint

REVOKE ALL ON FUNCTION medskin_access_credential(citext) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_access_credential(citext) TO app_anonymous;--> statement-breakpoint

-- =======================================================================================
-- 4 · LOS DOS PERMISOS NUEVOS, Y POR QUÉ NO VAN AL MISMO SITIO
-- =======================================================================================
--
-- Misma forma que la 0076 y la 0078: en una migración y no en un `platform:seed` a mano, para
-- que se apliquen solos al desplegar sin entrar a ninguna máquina y sin volver a pedir una
-- contraseña en producción.
--
--   · `plataforma:consultas:suspender` · a quien YA PUEDE ACTUAR sobre una cuenta
--     (`acceso:reenviar` o `pausa:levantar`). Es reversible y es trabajo de soporte.
--
--   · `plataforma:consultas:borrar` · SOLO a la cuenta que ya tiene `plataforma:historia:leer`,
--     que es la de acceso total. Borrar una consulta se lleva por delante los expedientes de
--     todas sus pacientes y NO SE DESHACE: no puede caer en una cuenta de soporte acotada por
--     el efecto secundario de una migración. El día que haga falta dárselo a alguien más, se le
--     da a mano y alguien lo decide.
-- =======================================================================================

UPDATE platform_account
   SET permissions = permissions || ARRAY['plataforma:consultas:suspender']::text[],
       updated_at = now()
 WHERE NOT ('plataforma:consultas:suspender' = ANY (permissions))
   AND ('plataforma:acceso:reenviar' = ANY (permissions)
        OR 'plataforma:pausa:levantar' = ANY (permissions));--> statement-breakpoint

UPDATE platform_account
   SET permissions = permissions || ARRAY['plataforma:consultas:borrar']::text[],
       updated_at = now()
 WHERE NOT ('plataforma:consultas:borrar' = ANY (permissions))
   AND ('plataforma:historia:leer' = ANY (permissions));--> statement-breakpoint
