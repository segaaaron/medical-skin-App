-- =======================================================================================
-- DOS PACIENTES NO PUEDEN QUEDARSE EL MISMO HUECO · y lo garantiza la base
--
-- «El hueco se toma dentro de la transacción, con la fila de la agenda bloqueada» (`agenda.md`).
-- El problema es que un hueco LIBRE no es una fila: no hay nada que bloquear, y dos
-- transacciones que miran la misma agenda vacía ven las dos el mismo hueco libre. Un `SELECT
-- ... FOR UPDATE` no sirve, un cerrojo de aviso se olvida de pedir, y «lo compruebo antes de
-- insertar» es la misma carrera que costó cuatro rondas de revisión en la idempotencia:
-- comprobar y escribir no es atómico si otro escribe en medio.
--
-- Lo que SÍ es atómico es una restricción. `EXCLUDE USING gist` es el `UNIQUE` de los rangos:
-- dos citas de la misma consulta cuyos intervalos se solapan no pueden coexistir, y la segunda
-- recibe `23P01` mientras la primera confirma. El `WHERE` deja fuera lo cancelado, que no ocupa.
--
-- `btree_gist` hace falta para meter `practice_id` —un `uuid`, que es tipo de btree— dentro de
-- un índice gist junto al rango. Y con `practice_id` delante (regla 5), el índice sirve además
-- para la lectura de la agenda de un inquilino.
-- =======================================================================================
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_no_overlap"
  EXCLUDE USING gist (
    "practice_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("status" in ('pendiente_de_sena', 'confirmada', 'atendida', 'no_asistio'));
