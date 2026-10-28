-- Tramo 2 · los dos índices de `patient`, medidos CON RLS PUESTA.
-- Corrige la 0010 entera y hace lo que la 0009 dijo que hacía y no hizo. Las dos siguen
-- aplicadas y no se tocan (§3.4, regla 7); esta es la siguiente.
--
-- =======================================================================================
-- 1 · EL GIN DE LA BÚSQUEDA VUELVE A LLEVAR `practice_id` DELANTE, Y AHORA SE SABE POR QUÉ
-- =======================================================================================
--
-- La 0010 quitó el `practice_id` del GIN porque midió que el motor no lo elegía y que un
-- GIN de trigramas solo era 150 veces más rápido. La medición era real y la conclusión
-- estaba mal, porque LAS MEDICIONES SE HICIERON CON `medskin_owner`, que es superusuario y
-- por tanto **no tiene RLS**. Sin política no hay predicado de inquilino, y sin predicado
-- de inquilino el caso que se medía no era el de la aplicación. La prueba de planes, que sí
-- corre con el rol de la aplicación y su contexto, lo cantó en el acto: recorrido completo
-- de las 16 001 fichas de las dos consultas, 471 bloques, 5,4 ms.
--
-- EL MECANISMO, que es la regla 3 de §7.3 llevada hasta el final:
--
--   `textlike` (`~~`, el operador de `LIKE`) y `similarity_op` (`%`, el de los trigramas)
--   **no son LEAKPROOF**. Comprobado contra `pg_proc.proleakproof`: los dos `false`.
--
--   Cuando una tabla tiene RLS, PostgreSQL evalúa los predicados de la POLÍTICA primero y
--   no permite que ningún predicado no-leakproof se evalúe antes —si lo permitiera, el
--   mensaje de error de una función podría revelar el contenido de una fila que la política
--   no deja ver—. Un predicado que no puede evaluarse antes de la política **no puede ser
--   condición de índice**. Así que `search_text like $1` NUNCA va a ser una condición de
--   índice en esta tabla: como máximo es un filtro.
--
--   El único predicado que sí puede ser condición de índice es el de la propia política,
--   `practice_id = medskin_current_practice()`. De ahí la regla 5 del diseño, y de ahí que
--   aquí NO sea un formalismo: el inquilino delante del GIN es lo único que convierte «leer
--   la tabla entera» en «leer las fichas de esta consulta».
--
-- Y acotado es poco: el plan de un inquilino es de 300 fichas (`practice.patient_limit`),
-- así que filtrar sus trigramas es leer un puñado de bloques. Medido con el compuesto:
-- Bitmap Index Scan por `practice_id`, 38 bloques, 0,5 ms, y lo que el filtro descarta son
-- las fichas de ESA consulta y de ninguna otra.
--
-- Lección, escrita aquí porque es la que se repite: **un plan medido sin RLS no es el plan
-- de esta aplicación.** `EXPLAIN` va siempre por el rol de la aplicación y con su contexto,
-- que es lo que hace la prueba.
DROP INDEX "patient_search_idx";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gin;
--> statement-breakpoint
CREATE INDEX "patient_search_idx" ON "patient"
  USING gin ("practice_id", "search_text" gin_trgm_ops);--> statement-breakpoint

-- =======================================================================================
-- 2 · Y LOS DOS ÍNDICES ORDENADOS, QUE LA 0009 NO LLEGÓ A TOCAR
--
-- La 0009 se aplicó con su comentario y SIN SUS DOS SENTENCIAS: un error de quien la
-- escribió (yo) al añadir el encabezado, que truncó el archivo generado. Está registrada
-- como aplicada, así que editarla dejaría una base nueva distinta de una base viva, que es
-- exactamente lo que la regla 7 evita. Se rehace aquí.
--
-- Lo que decía, y sigue valiendo: `.desc()` de drizzle emite `DESC NULLS LAST`, y
-- `order by created_at desc` significa `DESC NULLS FIRST`. Para el planificador son dos
-- ordenaciones distintas, así que el índice no servía para el `ORDER BY` y
-- `GET /v1/pacientes` ordenaba las 8 000 fichas del inquilino para devolver 50. Las dos
-- columnas son `not null`: no hay un nulo que cambie de sitio, lo único que cambia es que
-- el plan encaja.
-- =======================================================================================
DROP INDEX "patient_practice_status_idx";--> statement-breakpoint
CREATE INDEX "patient_practice_status_idx" ON "patient"
  USING btree ("practice_id", "status", "created_at" DESC NULLS FIRST);--> statement-breakpoint
DROP INDEX "medical_history_audit_practice_idx";--> statement-breakpoint
CREATE INDEX "medical_history_audit_practice_idx" ON "medical_history_audit"
  USING btree ("practice_id", "patient_id", "occurred_at" DESC NULLS FIRST);
