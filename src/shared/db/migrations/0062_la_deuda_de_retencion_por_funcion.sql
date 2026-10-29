-- =======================================================================================
-- EL AVISO DEL PLAZO LEÍA `patient_link` A PELO, Y TUMBÓ EL ARRANQUE
--
-- El alambre que cuenta los plazos cumplidos sin barrer se escribió consultando `patient_link`
-- directamente con el rol de los trabajos, y `app_anonymous` **no tiene `SELECT` sobre esa
-- tabla** —ni debe tenerlo: es el rol de las peticiones SIN SESIÓN—. Resultado: «permission
-- denied for table patient_link» y **la API no arrancaba**.
--
-- Lo encontró arrancarla, no la suite: la prueba del alambre probaba la frase —la función pura—
-- y no la consulta. Es la tercera vez en el día que un camino de trabajo pasa las pruebas y se
-- cae al ejecutarse de verdad, y las tres veces el patrón fue el mismo: **un rol de trabajo
-- leyendo una tabla a pelo en vez de por función**.
--
-- Así que por función, como todo lo que lee un trabajo en este esquema. Devuelve DOS NÚMEROS y
-- nada más: ni un identificador, ni un correo, ni una fecha de nadie.
-- =======================================================================================
CREATE FUNCTION medskin_retention_debt()
RETURNS TABLE (expired integer, pending integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT count(*) filter (WHERE l.retention_until <= current_date)::integer AS expired,
         count(*)::integer AS pending
    FROM patient_link l
   WHERE l.account_id IS NULL AND l.retention_until IS NOT NULL;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_retention_debt() OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_retention_debt() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_retention_debt() TO app_anonymous;
