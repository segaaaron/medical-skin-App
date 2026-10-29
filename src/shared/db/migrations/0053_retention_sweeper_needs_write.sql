-- =======================================================================================
-- EL BARRENDERO DECÍA QUE BARRÍA Y NO BARRÍA NADA · y esto es la lección del día
--
-- `medskin_purge_retained` (0051) devolvía «2 fichas barridas» y las dos fichas seguían con
-- su nombre, su correo y su historia. El motivo: `patient_access` y `medical_history_access`
-- son políticas **`FOR SELECT`** —las creó el tramo 1 para que la consola y los trabajos
-- pudieran LEER—, y una política de `SELECT` no autoriza un `UPDATE`. RLS no se queja: filtra.
-- Así que el `SELECT` del bucle veía las filas, los `UPDATE` y `DELETE` afectaban CERO, y la
-- función contaba las vueltas del bucle.
--
-- LA LECCIÓN, que va al napkin: **una función `SECURITY DEFINER` que escribe necesita que su
-- dueño tenga política de ESCRITURA, no solo el `GRANT`**. Un `GRANT UPDATE` sin política es
-- un `UPDATE` que afecta cero filas y no falla, y eso no se nota en ninguna prueba que solo
-- mire el valor devuelto. Lo cazó la prueba que comprueba la FICHA después de barrer, no la
-- que comprueba el número.
--
-- Las dos políticas de la 0051 que ya eran `FOR ALL` —`consent`, `message`, `message_thread`,
-- `medical_history_audit`, `patient_link`— se quedan como están.
-- =======================================================================================
CREATE POLICY patient_access_write ON "patient" FOR UPDATE TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint
CREATE POLICY medical_history_access_write ON "medical_history" FOR DELETE TO medskin_access
  USING (current_user = 'medskin_access');
