-- Las funciones SECURITY DEFINER dejan `pg_temp` al final de su `search_path`.
--
-- Sin `pg_temp` en la lista, PostgreSQL lo busca PRIMERO para tablas y tipos: quien pueda crear
-- una tabla temporal con el nombre de una tabla de `public` cambia lo que lee la función, que
-- corre con los privilegios de su dueño. Con `pg_temp` al final, `public` gana siempre.
-- Fuente: PostgreSQL 17, CREATE FUNCTION · «Writing SECURITY DEFINER Functions Safely».
--
-- Se recorre el catálogo en vez de listar las funciones una a una, para que ninguna se quede
-- fuera. Solo se tocan las que hoy llevan exactamente `pg_catalog, public`.
DO $do$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS firma
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', fn.firma);
  END LOOP;
END
$do$;
