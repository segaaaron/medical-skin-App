-- =======================================================================================
-- LOS DOS PROGRAMADORES DE AVISOS NO PODÍAN LEER LA AGENDA · 29 de octubre de 2026 (noche)
--
-- `medskin_appointments_to_remind` y `medskin_patients_to_return` (0045) leen `appointment`,
-- `treatment`, `clinical_session` y `account`, y su dueño —`medskin_access`— **no tiene
-- `SELECT` sobre ninguna de las cuatro**. Así que el recordatorio de cita y el aviso de «toca
-- volver» fallaban con «permission denied for table treatment» **cada vez que la cola los
-- disparaba**.
--
-- CÓMO SE ENCONTRÓ, y es la parte que importa: no leyendo. Las pruebas de los avisos llamaban
-- a `send()`, al horario de silencio, a la higiene de tokens y a la deduplicación —y pasaban—,
-- pero **nunca llamaban a `remind()` ni a `callBack()`**. Dos de los ocho trabajos se
-- entregaron sin ejecutarlos una sola vez. Lo destapó dejar la API arrancada setenta y cinco
-- segundos y mirar `bull:avisos-higiene:failed` en Redis, que es lo que esa cola existe para
-- que alguien mire.
--
-- Esta migración da los cuatro `SELECT` y las dos políticas que faltaban. **Son de solo
-- lectura**: estos dos programadores no escriben nada en esas tablas —lo que escriben es la
-- bandeja de salida, con su propia política— y `medskin_access` sigue sin poder tocarlas.
--
-- Y el `GRANT` sin política no sirve de nada (la lección del napkin §1.6): con `FORCE ROW LEVEL
-- SECURITY`, una tabla sin política para este rol devuelve CERO FILAS en vez de fallar, que es
-- peor que el «permission denied» — un programador que no encuentra ninguna cita que recordar
-- parece estar trabajando.
-- =======================================================================================
GRANT SELECT ON "appointment" TO medskin_access;--> statement-breakpoint
GRANT SELECT ON "treatment" TO medskin_access;--> statement-breakpoint
GRANT SELECT ON "clinical_session" TO medskin_access;--> statement-breakpoint
GRANT SELECT ON "account" TO medskin_access;--> statement-breakpoint

-- `appointment` y `account` ya tienen su política de `medskin_access` desde los tramos 4 y 1;
-- `treatment` y `clinical_session` no la tenían porque hasta hoy ningún trabajo las leía.
CREATE POLICY treatment_access ON "treatment" FOR SELECT TO medskin_access
  USING (current_user = 'medskin_access');--> statement-breakpoint
CREATE POLICY clinical_session_access ON "clinical_session" FOR SELECT TO medskin_access
  USING (current_user = 'medskin_access');
