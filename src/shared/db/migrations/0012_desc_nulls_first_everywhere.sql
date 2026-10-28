-- Tramo 1 · los diez índices descendentes, en el orden que el `ORDER BY` pide.
-- Es el mismo defecto que la 0011 arregló en `patient` y en `medical_history_audit`,
-- buscado esta vez en todo lo aplicado: `select indexdef from pg_indexes where indexdef
-- like '%DESC%'` devolvía doce, y diez seguían con `DESC NULLS LAST`.
--
-- EL DEFECTO: `.desc()` de drizzle emite `DESC NULLS LAST`. `order by x desc` significa
-- `DESC NULLS FIRST`. Para el planificador son dos ordenaciones distintas, así que el
-- índice **no sirve para el `ORDER BY`**: la consulta lee todo lo que el predicado de la
-- política deje pasar y lo ordena para devolver 50 filas. No se ve leyendo el SQL y no se
-- ve con cuatro filas de prueba.
--
-- MEDIDO CON EL ROL DE LA APLICACIÓN Y SU CONTEXTO —nunca con `medskin_owner`, que es
-- superusuario y no tiene RLS, que es la trampa que costó tres migraciones— sobre 20 000
-- líneas de bitácora y 10 000 fallos de una consulta:
--
--   access_audit, «lo último primero» de la doctora
--     antes:   Seq Scan de 20 001 filas + top-N heapsort · 421 bloques · 9,80 ms
--     después: Index Scan por access_audit_practice_idx, 50 filas ·   4 bloques · 0,06 ms
--   service_failure, los fallos de su consulta (§10.4)
--     antes:   Seq Scan de 10 001 filas + top-N heapsort · 320 bloques · 5,29 ms
--     después: Index Scan por service_failure_practice_idx ·  4 bloques · 0,05 ms
--
-- Los dos recorridos eran completos: sin orden utilizable, el motor ni siquiera entraba por
-- el índice del inquilino. Así que esto no era «una ordenación de más», era la regla 5 de
-- §7.3 incumplida de hecho en las dos bitácoras.
--
-- `session_account_active_idx` NO mejora hoy y se arregla igual: la igualdad por cuenta
-- deja tres o cuatro filas, así que ordenarlas no cuesta nada y el plan es bueno de las dos
-- formas. Se cambia porque es gratis, porque es la consulta de `GET /v1/acceso/sesiones` y
-- porque dejar nueve arreglados y uno roto garantiza que alguien lo encuentre de nuevo
-- dentro de un año.
--
-- Las cuatro columnas implicadas (`occurred_at`, `created_at`, `last_seen_at`) son
-- `not null`: no hay un solo nulo que cambie de sitio. Lo único que cambia es que el plan
-- encaja. Y los dos índices parciales conservan su `WHERE` tal cual.
--
-- Nota de despliegue: son `DROP` + `CREATE` dentro de la transacción de la migración, que
-- con estas tablas tarda milisegundos. El día que una de ellas tenga millones de filas,
-- esto se hace con `CREATE INDEX CONCURRENTLY` y `DROP ... CONCURRENTLY` **fuera** de una
-- transacción, y entonces no es una migración de drizzle sino una maniobra con su ventana.
--
-- §3.4, regla 7: versionada, y NUNCA editada después de aplicarse.

DROP INDEX "access_audit_practice_idx";--> statement-breakpoint
DROP INDEX "access_audit_actor_idx";--> statement-breakpoint
DROP INDEX "access_audit_action_idx";--> statement-breakpoint
DROP INDEX "recovery_code_account_idx";--> statement-breakpoint
DROP INDEX "service_failure_occurred_idx";--> statement-breakpoint
DROP INDEX "service_failure_operation_idx";--> statement-breakpoint
DROP INDEX "service_failure_code_idx";--> statement-breakpoint
DROP INDEX "service_failure_practice_idx";--> statement-breakpoint
DROP INDEX "session_account_active_idx";--> statement-breakpoint
DROP INDEX "session_practice_idx";--> statement-breakpoint
CREATE INDEX "access_audit_practice_idx" ON "access_audit" USING btree ("practice_id","occurred_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "access_audit_actor_idx" ON "access_audit" USING btree ("actor_account_id","occurred_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "access_audit_action_idx" ON "access_audit" USING btree ("action","occurred_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "recovery_code_account_idx" ON "recovery_code" USING btree ("account_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "service_failure_occurred_idx" ON "service_failure" USING btree ("occurred_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "service_failure_operation_idx" ON "service_failure" USING btree ("service","operation","occurred_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "service_failure_code_idx" ON "service_failure" USING btree ("error_code","occurred_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "service_failure_practice_idx" ON "service_failure" USING btree ("practice_id","occurred_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "session_account_active_idx" ON "session" USING btree ("account_id","last_seen_at" DESC NULLS FIRST) WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "session_practice_idx" ON "session" USING btree ("practice_id","last_seen_at" DESC NULLS FIRST) WHERE practice_id is not null;