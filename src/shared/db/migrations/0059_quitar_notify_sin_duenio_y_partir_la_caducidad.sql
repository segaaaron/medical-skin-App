-- =======================================================================================
-- `medskin_notify` SE VA · era un canal de suplantación, y no la llamaba nadie
--
-- La 0045 la escribió con una guarda que mira el INQUILINO y **no mira la cuenta**:
--
--     WHERE p_practice_id = medskin_current_practice() OR <vínculo de esta cuenta>
--
-- `p_account_id` entra sin comprobar. Reproducido contra la base de desarrollo, con
-- `app_practitioner` y contexto de la consulta Alfa: encolar en el inquilino de Beta queda
-- bloqueado —correcto—, pero encolar **en Alfa con el `account_id` de la dueña de Beta**
-- devuelve un identificador y la fila queda escrita. La política `notification_own` (0045) deja
-- leer por `account_id` sin mirar la consulta, así que la víctima lo ve en su pantalla de
-- avisos; y con `kind = 'seguridad'` el aviso está **exento del horario de silencio** (0056).
--
-- O sea: nuestro propio backend entregando «Movimiento en tu cuenta · Si no fuiste tú, cambia
-- tu contraseña» a la dueña de otra consulta, de noche. Eso no es un hueco de validación, es un
-- canal de phishing con nuestra firma.
--
-- Y SE QUITA EN VEZ DE PARCHEARSE porque **no hay un solo llamante en `src/`**. Los tres
-- caminos reales usan las funciones que resuelven el destinatario ELLAS MISMAS y por eso no
-- pueden recibirlo del cliente: `medskin_notify_practice` (la dueña de esa consulta),
-- `medskin_notify_patient` (la cuenta del vínculo de esa ficha) y `medskin_notify_waitlist` (la
-- cuenta de quien espera). Una función concedida a tres roles, sin llamante y con un agujero no
-- se arregla: se borra. El día que haga falta encolar a una cuenta concreta, se escribe con la
-- cuenta comprobada y con su prueba de que no cruza.
-- =======================================================================================
DROP FUNCTION medskin_notify(uuid, uuid, text, text, text, jsonb, text, timestamptz);--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- LA CADUCIDAD DE LA EXPORTACIÓN, PARTIDA EN DOS
-- ---------------------------------------------------------------------------------------
-- `medskin_exports_expired` marcaba `vencida` **y** devolvía la clave del objeto en la misma
-- sentencia, así que el trabajador marcaba primero y borraba después, con un
-- `fetch(...).catch(() => undefined)` encima: si el almacenamiento rechazaba el borrado, la
-- fila decía «vencida» y **el JSON con la copia completa de los datos de una paciente se
-- quedaba en el disco**. Es la misma trampa que el trabajador de fotos ya respeta, donde el
-- sello solo se escribe si el objeto se fue.
--
-- Ahora son dos: una LISTA que no escribe nada, y un SELLO que se llama después de que el
-- objeto se haya ido de verdad. Si el borrado falla, la fila se queda y la pasada siguiente lo
-- vuelve a intentar.
--
-- Y el `410 exportacion_vencida` del contrato NO depende de este sello: el caso de uso lo
-- decide comparando `expires_at` con la hora (`business.ts`), así que el enlace deja de valer a
-- las 24 h aunque el almacenamiento esté caído.
CREATE FUNCTION medskin_exports_to_expire(p_limit integer)
RETURNS TABLE (id uuid, object_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT d.id, d.object_key
    FROM data_export d
   WHERE d.status = 'lista' AND d.expires_at < now()
   ORDER BY d.expires_at
   LIMIT greatest(1, least(coalesce(p_limit, 50), 500));
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_exports_to_expire(integer) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_exports_to_expire(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_exports_to_expire(integer) TO app_anonymous;--> statement-breakpoint

CREATE FUNCTION medskin_export_expired(p_id uuid)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE data_export SET status = 'vencida' WHERE id = p_id AND status = 'lista';
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_export_expired(uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_export_expired(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_export_expired(uuid) TO app_anonymous;--> statement-breakpoint

-- La vieja se va con ella: marcaba y devolvía a la vez, que es justo lo que no se quiere.
DROP FUNCTION medskin_exports_expired(integer);--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- Y EL `GRANT` DE `account`, POR COLUMNA
-- ---------------------------------------------------------------------------------------
-- La 0058 dio `SELECT` sobre la tabla entera porque dos programadores necesitan el correo. La
-- regla del proyecto es por columna (napkin §1.5) y aquí se nota por qué: `account` lleva
-- `locked_until`, `failed_attempts` y `deletion_reason`, que no son asunto de un trabajo de
-- avisos. Las dos funciones solo leen `id`, `email` y `status`.
REVOKE SELECT ON "account" FROM medskin_access;--> statement-breakpoint
GRANT SELECT ("id", "email", "status") ON "account" TO medskin_access;
