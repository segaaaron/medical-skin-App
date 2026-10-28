-- Tramo 1 · la corrección de la 0004, que no podía funcionar.
--
-- QUÉ ESTABA MAL: la función terminaba con `RETURNING service_failure.id INTO v_id`, y
-- `RETURNING` exige `SELECT` sobre la columna devuelta. `medskin_access` tiene `INSERT` por
-- columnas sobre `service_failure` y NINGÚN `SELECT` —a propósito: el que escribe el
-- registro de fallos no lo lee—, así que toda llamada moría con
-- `ERROR: permission denied for table service_failure`. Medido en la primera llamada real:
-- la migración se aplica «bien» y revienta al usarse, igual que los cuatro `STABLE` de la
-- decisión 16.
--
-- POR QUÉ NO SE ARREGLA CONCEDIENDO `SELECT (id)`: sería abrir una lectura de
-- `service_failure` a un rol cuyo único trabajo es escribir en ella, para devolver un
-- número que nadie necesita. `currval` sobre la secuencia da el mismo valor con el `USAGE`
-- que la 0004 ya concedió, y `USAGE` sobre una secuencia no lee ni una fila de la tabla.
-- Es seguro en concurrencia: `currval` es el último valor de ESTA sesión, y la sesión es la
-- transacción que acaba de insertar.
--
-- `CREATE OR REPLACE` y no `DROP` + `CREATE`: conserva el OID, la propiedad de
-- `medskin_access` y el `GRANT EXECUTE` a `app_anonymous`. No cambia la firma ni el tipo de
-- retorno, así que no hay nada que volver a conceder.
--
-- §3.4, regla 7: la 0004 ya se aplicó, así que no se toca. Si está mal, se escribe la
-- siguiente, y esta es la siguiente.

CREATE OR REPLACE FUNCTION medskin_record_anonymous_failure(p_operation text, p_error_code text,
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
  -- reconocer el que se colaría dentro del mensaje de un error del motor («Key (email)=(…)
  -- already exists»), que es el único dato personal que una petición sin sesión tiene en la
  -- mano. Regla 1 de §10.3 por delante de la regla 2: se tapa la dirección, el resto del
  -- texto del motor queda intacto.
  c_email constant text := '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}';
  c_masked constant text := '[correo]';
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
          false);

  RETURN currval('service_failure_id_seq');
END
$fn$;
