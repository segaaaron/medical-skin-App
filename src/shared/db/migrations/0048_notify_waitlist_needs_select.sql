-- =======================================================================================
-- `medskin_notify_waitlist` (0046) LEE `waitlist_entry` Y `medskin_access` NO PODÍA
--
-- Mismo caso que la 0044: una función `SECURITY DEFINER` corre como su dueño, y su dueño
-- necesita el privilegio sobre lo que lee. Sin esto, cancelar una cita con alguien en la lista
-- de espera respondía «permission denied for table waitlist_entry» —un 500— justo donde la
-- respuesta promete el aviso. Lo cazó la prueba del aviso de la lista de espera.
--
-- Y la política de `medskin_access`, por la misma razón que en `photo` (0037): `FORCE ROW LEVEL
-- SECURITY` se aplica también a quien tiene el `GRANT`, y el trabajo no tiene consulta que
-- fijar.
--
-- Las 0046 y 0047 ya están aplicadas y no se tocan (§3.4, regla 7 · napkin §1.5).
-- =======================================================================================
GRANT SELECT ON "waitlist_entry" TO medskin_access;--> statement-breakpoint
CREATE POLICY waitlist_access ON "waitlist_entry" FOR SELECT TO medskin_access
  USING (current_user = 'medskin_access');
