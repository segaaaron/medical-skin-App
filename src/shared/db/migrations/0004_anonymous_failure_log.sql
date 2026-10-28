-- Tramo 1 · el 500 de una petición SIN SESIÓN, registrado en `service_failure`.
-- Cierra la pregunta 18 de docs/contratos/preguntas-abiertas.md.
--
-- EL PROBLEMA: `POST /v1/acceso` y los dos de recuperación los sirve `app_anonymous`, que
-- no tiene un solo privilegio de tabla, y `withTenantContext()` exige `accountId` para los
-- otros tres roles. Así que su 500 iba a `stderr` y no a la tabla, que es donde §10.3 dice
-- que tiene que estar.
--
-- POR QUÉ UNA FUNCIÓN `SECURITY DEFINER` Y NO UN `GRANT INSERT` CON SU POLÍTICA
--
-- 1. El grant contradice el contrato. `_convenciones.md` · «Cuatro roles de base» dice de
--    `app_anonymous`, literal: «Ni un `SELECT`, ni un `INSERT`, ni un `GRANT` de tabla».
--    Y no es solo prosa: `access-functions.spec.ts` le pregunta al catálogo
--    (`information_schema.table_privileges` y `column_privileges`) y exige CERO para ese
--    rol, sin enumerar tablas. Un `GRANT INSERT`, aunque fuera por columnas, rompe esa
--    prueba el día que se escriba, que es justo lo que esa prueba existe para hacer.
-- 2. El grant no puede acotar QUÉ se escribe, solo DÓNDE. Un `GRANT INSERT (…)` por
--    columnas deja fuera `practice_id`, `actor_id`, `subject_id` e `input_digest` —bien—,
--    pero el que escribe sigue eligiendo el valor de cada columna que sí tiene. Con una
--    función, las columnas que identifican a alguien NO SON ARGUMENTO: no hay forma de
--    nombrarlas desde fuera, ni por error de programación.
-- 3. `input_digest` es el caso que decide. Es un resumen de la entrada, y la entrada de un
--    acceso es un correo: la columna existe y para una petición sin sesión sería el hash
--    del correo, que es exactamente lo que no puede entrar. No es argumento de esta
--    función y por eso no entra nunca.
--
-- LO QUE LA FILA PUEDE LLEVAR, Y NADA MÁS: la causa real del motor (§10.3, reglas 2 y 3:
-- completa, textual, con su cadena de causas), el identificador de la petición y de la
-- traza, la operación a la que iba, y dos etiquetas de despliegue —`platform` y `region`—
-- validadas contra lista cerrada para que no sean texto libre del cliente.
--
-- NO lleva: inquilino (no se sabe), cuenta (no hay), sujeto, resumen de la entrada, ni la
-- IP, que no es columna de esta tabla y no se añade. `service_failure` sigue sin inquilino
-- y sin clave foránea (§12.2.8), así que esto no le añade un `account_id` a nada.
--
-- EL ÚNICO HUECO QUE QUEDABA, Y SU TAPÓN: `error_message`, `stack` y `cause_chain` son
-- texto del motor, y un error del motor PUEDE llevar el correo dentro («Key (email)=(…)
-- already exists»). Como el correo es el único dato personal que una petición sin sesión
-- tiene en la mano, la función enmascara las direcciones de correo de esos tres campos
-- antes de insertar. Es una tensión con la regla 2 de §10.3 («sin recortar y sin
-- reemplazar») y se resuelve a favor de la regla 1 («nada de dato personal en esta
-- tabla»), que es la que manda: lo que se tapa es una dirección, el resto del texto del
-- motor queda intacto. Ceiling: enmascara direcciones con forma de correo, no un correo
-- partido en pedazos por el propio mensaje; si aparece ese caso, se añade su patrón aquí.
--
-- Y la prueba que de verdad importa va en `access-functions.spec.ts`: con esto,
-- `app_anonymous` escribe y SIGUE SIN LEER una sola fila de `service_failure` ni de
-- ninguna otra tabla. Un rol que escribe no es un rol que lee: no hay `GRANT SELECT`, no
-- hay política de `SELECT` que lo nombre, y el catálogo sigue diciendo cero.
--
-- §3.4, regla 7: versionada, y NUNCA editada después de aplicarse.

-- ---------------------------------------------------------------------------------------
-- `medskin_access` escribe la fila (es el dueño de la función). RLS sí se le aplica: no es
-- dueño de la tabla y no tiene BYPASSRLS, así que sin esta política no insertaría nada.
-- Solo INSERT, y por columnas: el registro de fallos no se lee ni se reescribe desde aquí.
-- ---------------------------------------------------------------------------------------
CREATE POLICY service_failure_access_insert ON "service_failure" FOR INSERT TO medskin_access
  WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint
GRANT INSERT (service, operation, severity, error_code, error_message, cause_chain, stack,
              trace_id, request_id, platform, region, will_retry)
  ON "service_failure" TO medskin_access;--> statement-breakpoint
GRANT USAGE ON SEQUENCE "service_failure_id_seq" TO medskin_access;--> statement-breakpoint

CREATE FUNCTION medskin_record_anonymous_failure(p_operation text, p_error_code text,
                                                 p_error_message text, p_trace_id text,
                                                 p_cause_chain jsonb DEFAULT NULL,
                                                 p_stack text DEFAULT NULL,
                                                 p_request_id text DEFAULT NULL,
                                                 p_platform text DEFAULT NULL,
                                                 p_region text DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  -- Una dirección de correo con la forma habitual. No pretende validar correos: pretende
  -- reconocer el que se colaría dentro del mensaje de un error del motor.
  c_email constant text := '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}';
  c_masked constant text := '[correo]';
  v_id bigint;
BEGIN
  IF p_operation IS NULL OR btrim(p_operation) = ''
     OR p_error_code IS NULL OR btrim(p_error_code) = ''
     OR p_error_message IS NULL OR btrim(p_error_message) = ''
     OR p_trace_id IS NULL OR btrim(p_trace_id) = '' THEN
    RAISE EXCEPTION 'medskin_record_anonymous_failure: operacion, codigo, causa y traza son obligatorios'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Lista cerrada las dos: son etiquetas de despliegue, no texto que el cliente dicte.
  IF p_platform IS NOT NULL AND p_platform NOT IN ('ios', 'android', 'server') THEN
    RAISE EXCEPTION 'medskin_record_anonymous_failure: plataforma desconocida'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_region IS NOT NULL AND p_region NOT IN ('eu', 'us', 'latam') THEN
    RAISE EXCEPTION 'medskin_record_anonymous_failure: region desconocida'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO service_failure (service, operation, severity, error_code, error_message,
                               cause_chain, stack, trace_id, request_id, platform, region,
                               will_retry)
  VALUES ('api', btrim(p_operation), 'error', btrim(p_error_code),
          regexp_replace(p_error_message, c_email, c_masked, 'g'),
          regexp_replace(p_cause_chain::text, c_email, c_masked, 'g')::jsonb,
          regexp_replace(p_stack, c_email, c_masked, 'g'),
          p_trace_id, p_request_id, p_platform, p_region,
          -- Una petición HTTP sin sesión no se reintenta desde el servidor: quien
          -- reintenta es la app, con su propio botón, y eso es otra petición.
          false)
  RETURNING service_failure.id INTO v_id;

  RETURN v_id;
END
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_record_anonymous_failure(text, text, text, text, jsonb, text, text,
                                                text, text) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_record_anonymous_failure(text, text, text, text, jsonb, text,
                                                        text, text, text) FROM PUBLIC;--> statement-breakpoint
-- Solo el rol sin sesión. Los otros tres ya tienen su `GRANT INSERT` de la 0000 y escriben
-- la fila COMPLETA, con su inquilino y su actor, que es lo que su panel necesita: esta
-- función es la del caso en que no hay ni inquilino ni actor que escribir.
GRANT EXECUTE ON FUNCTION medskin_record_anonymous_failure(text, text, text, text, jsonb,
                                                           text, text, text, text)
  TO app_anonymous;--> statement-breakpoint
