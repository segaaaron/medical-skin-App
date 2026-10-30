-- =======================================================================================
-- LO QUE EL QA MIDIÓ · dos índices, un trabajo que se apagaba solo y una fila que se cuelga
--
-- Los cuatro salen del informe de `datos-senior`, que los midió con volumen (40 000 citas y
-- 40 000 avisos) y con el rol real. Ninguna prueba de las que hay los habría cazado, porque
-- con cuatro filas por tabla el planificador no tiene que elegir y un `Seq Scan` se ve igual
-- que un `Index Scan`.
-- =======================================================================================

-- ---------------------------------------------------------------------------------------
-- 1 · `notification_due_idx` empezaba por la consulta, y su consulta NO lo nombra
-- ---------------------------------------------------------------------------------------
-- La 0045 lo creó «por consulta primero (lección 0011)», y esa lección no aplica aquí:
-- `medskin_notifications_due` **cruza consultas** —es un trabajo, no una petición—, así que no
-- hay ningún `practice_id = …` en su `WHERE`. Con la consulta delante, el índice no puede
-- acotar el rango de `send_after` ni servir el `ORDER BY`: recorre la rama parcial entera y
-- ordena a mano.
--
-- Medido con 40 000 filas en la bandeja, 1 600 pendientes y 800 vencidas:
--   antes:   Bitmap Index Scan (rows=1600) · Heap Blocks 1600 · Sort · 3 848 buffers · 4,125 ms
--   después: Index Scan        (rows=800)  ·                     sin Sort · 2 711 buffers · 2,209 ms
--
-- Lo que importa no es el 30 %: es la pendiente. El de antes lee **todas** las pendientes; el
-- nuevo solo las **vencidas**. Y el arrendamiento de la 0056 crea pendientes con `send_after` en
-- el futuro a propósito, así que el conjunto que el viejo leía de más es justo el que crece. Y
-- esto corre cada minuto.
--
-- Es la misma excepción medida que el napkin §1.4 ya documenta para la consola, al revés: no
-- lleva la consulta delante porque la consulta no lo nombra. La propia 0056 acertó con este
-- criterio en `notification_purge_idx`.
DROP INDEX "notification_due_idx";--> statement-breakpoint
CREATE INDEX "notification_due_idx" ON "notification_outbox" USING btree ("send_after")
	WHERE "status" = 'pendiente';--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 2 · `medskin_appointments_to_remind` no tenía ningún índice por el que entrar
-- ---------------------------------------------------------------------------------------
-- Filtra por estado y por una ventana estrecha de `starts_at`, **sin consulta**, y los tres
-- índices de `appointment` empiezan por `practice_id`. Medido con 40 000 citas:
--   antes:   Bitmap Index Scan por `appointment_open_idx` (45 761 entradas) · 1 549 bloques
--            · «Rows Removed by Filter: 22 880» · 1 636 buffers · 3,362 ms · **para devolver CERO filas**
--   después: Index Scan con las tres condiciones de `starts_at` como Index Cond
--            · 5 buffers · 0,058 ms
--
-- Un índice parcial de dos páginas, cada cinco minutos. El estado va en el `WHERE` del índice y
-- no en sus columnas: son los dos estados de una cita viva y no hace falta distinguirlos.
CREATE INDEX "appointment_remind_idx" ON "appointment" USING btree ("starts_at")
	WHERE "status" IN ('pendiente_de_sena', 'confirmada');--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 3 · «Toca volver» no pasaba nunca de las 200 primeras pacientes
-- ---------------------------------------------------------------------------------------
-- Las condiciones las cumple **para siempre** quien no vuelve: última sesión firmada más el
-- intervalo, y sin cita viva. El `due_on` solo cambia si firma otra sesión. La deduplicación
-- impedía el segundo aviso —correcto— pero la fila **seguía saliendo de la consulta cada día y
-- seguía ocupando uno de los 200 huecos del `LIMIT`**.
--
-- O sea que en cuanto hubiera más de 200 vencidas en toda la plataforma, el `ORDER BY due_on`
-- devolvía siempre las 200 más antiguas, todas ya avisadas, `queued = 0`, y **la 201 no recibía
-- el aviso jamás**. El trabajo informaba «0 encolados», indistinguible de «no había nada que
-- hacer». Para el aviso que §6.2 llama «el que genera la re-reserva», es el que más dinero
-- mueve y es el que se apagaba solo.
--
-- Se arregla donde está el defecto: la consulta **excluye a quien ya tiene su aviso**, así que
-- el `LIMIT` solo trae trabajo de verdad. Se cruza por lo que el aviso lleva dentro
-- —tratamiento y fecha— y no por la forma de la clave de deduplicación, que vive en el código y
-- puede cambiar.
CREATE OR REPLACE FUNCTION medskin_patients_to_return(p_limit integer)
RETURNS TABLE (practice_id uuid, account_id uuid, email text, treatment_id uuid, due_on date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  WITH ultima AS (
    SELECT s.patient_id, a.treatment_id, a.practice_id, max(s.started_at) AS last_at
      FROM clinical_session s
      JOIN appointment a ON a.id = s.appointment_id
     WHERE s.status = 'firmada'
     GROUP BY s.patient_id, a.treatment_id, a.practice_id
  )
  SELECT u.practice_id, l.account_id, ac.email::text, u.treatment_id,
         (u.last_at + make_interval(days => t.min_interval_days))::date AS due_on
    FROM ultima u
    JOIN treatment t ON t.id = u.treatment_id
    JOIN patient t2 ON t2.id = u.patient_id
    JOIN patient_link l ON l.patient_id = u.patient_id AND l.status = 'vinculada'
    JOIN account ac ON ac.id = l.account_id
   WHERE t.min_interval_days IS NOT NULL
     AND t.planned_sessions > 1
     AND t.status = 'activo'
     AND t2.status = 'activa'
     AND u.last_at + make_interval(days => t.min_interval_days) <= now()
     AND NOT EXISTS (SELECT 1 FROM appointment a2
                      WHERE a2.patient_id = u.patient_id
                        AND a2.treatment_id = u.treatment_id
                        AND a2.status IN ('pendiente_de_sena', 'confirmada')
                        AND a2.starts_at > now())
     -- LO NUEVO: quien ya tiene su aviso de ESTE tratamiento para ESTA fecha no vuelve a
     -- ocupar un hueco del `LIMIT`. Sin esto, el trabajo se apagaba solo a las 200 pacientes.
     AND NOT EXISTS (SELECT 1 FROM notification_outbox o
                      WHERE o.practice_id = u.practice_id
                        AND o.account_id = l.account_id
                        AND o.kind = 'toca_volver'
                        AND o.data->>'tratamiento_id' = u.treatment_id::text
                        AND o.data->>'desde'
                            = (u.last_at + make_interval(days => t.min_interval_days))::date::text)
   ORDER BY due_on
   LIMIT greatest(1, least(coalesce(p_limit, 200), 1000));
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 4 · Una exportación se quedaba en `armando` para siempre
-- ---------------------------------------------------------------------------------------
-- `medskin_exports_pending` reclama poniendo `armando`, y **nadie rescata una fila colgada**: si
-- el proceso muere entre el reclamo y el sello, la paciente se queda con un «te llega por
-- correo» que no llega, y sin reintento hasta el día siguiente por su propio límite de una al
-- día. La cabecera de la 0056 presume justo de evitar esto con un arrendamiento; `armando` es
-- esa parte, olvidada nueve migraciones antes.
--
-- Un arrendamiento, igual que la bandeja: se reclama también lo que lleva más de quince minutos
-- en `armando`. Armar una exportación son segundos; quince minutos es un proceso que murió.
CREATE OR REPLACE FUNCTION medskin_exports_pending(p_limit integer)
RETURNS TABLE (id uuid, account_id uuid, practice_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE data_export
     SET status = 'armando', created_at = created_at
   WHERE id IN (
     SELECT d.id FROM data_export d
      WHERE d.status = 'pedida'
         -- El rescate: lo que lleva quince minutos armándose es un trabajador que murió.
         OR (d.status = 'armando' AND d.created_at < now() - interval '15 minutes')
      ORDER BY d.created_at
      LIMIT greatest(1, least(coalesce(p_limit, 5), 20))
      FOR UPDATE SKIP LOCKED
   )
  RETURNING id, account_id, practice_id;
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 5 · Y el apagado del barrendero, hecho valer por la BASE y no solo por el código
-- ---------------------------------------------------------------------------------------
-- `RetentionSweep.run()` rechaza y su cola está desprogramada, pero el `EXECUTE` seguía
-- concedido: quien vuelva a encender la cola no necesitaría migración, y lo que hay detrás es un
-- borrado irreversible y a medias. Mientras la decisión de producto no esté escrita
-- (`preguntas-abiertas.md`), que no pueda ejecutarse ni por accidente.
--
-- La función se queda escrita: el día que se decida, lo que hace falta es completarla y volver a
-- concederla, no reescribirla de memoria.
REVOKE EXECUTE ON FUNCTION medskin_purge_retained(integer) FROM app_anonymous;
