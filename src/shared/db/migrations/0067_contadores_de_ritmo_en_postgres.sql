-- =======================================================================================
-- LOS CONTADORES DE RITMO SE MUDAN A POSTGRES · y con ellos se va Redis del proyecto
--
-- Era lo último que quedaba en Redis después de pasar las colas al backend de PostgreSQL de
-- BullMQ 6. Mantener un servicio entero —con su memoria, su despliegue y su modo de fallo— para
-- cinco operaciones sobre claves con caducidad no se sostiene.
--
-- LAS TRES REGLAS DEL CONTRATO NO CAMBIAN (`_convenciones.md` · «Los contadores»):
--   1. se incrementa exista o no la cuenta  → lo decide el llamante, aquí no cambia nada;
--   2. la clave lleva el HMAC del correo, NUNCA el correo → se sigue calculando en el código,
--      así que esta tabla tampoco es un padrón: `name` es un hexadecimal sin vuelta atrás;
--   3. un fallo NO abre la puerta → las funciones lanzan y el endpoint responde 500.
--
-- Y UNA SEMÁNTICA QUE HAY QUE COPIAR EXACTA, porque es una decisión de seguridad y no un
-- detalle: `increment` fija la ventana SOLO en el primer incremento (era `EXPIRE … NX`). Una
-- ventana que se renueva en cada intento no caduca nunca, y convierte una pausa de quince
-- minutos en una perpetua. `mark`, al revés, la reescribe siempre: marca «esto vale hasta tal
-- hora», y pedir otro código mueve esa hora.
--
-- Lo caducado se trata como AUSENTE en todas las lecturas —Redis lo borraba solo— y se barre
-- aparte: una fila vencida que nadie mira no puede cambiar ninguna decisión.
-- =======================================================================================
CREATE TABLE "rate_counter" (
  "name" text PRIMARY KEY,
  "hits" integer NOT NULL DEFAULT 0,
  "expires_at" timestamptz NOT NULL
);--> statement-breakpoint

-- Para el barrido. Sin él, borrar lo vencido recorre la tabla entera.
CREATE INDEX "rate_counter_expires_idx" ON "rate_counter" USING btree ("expires_at");--> statement-breakpoint

-- La regla de la casa: las 54 tablas van con RLS forzada y esta no es una excepción. No tiene
-- inquilino —un intento de acceso ocurre ANTES de saber de quién es— así que nadie la lee
-- directamente: se entra por las funciones de abajo, y la única política es la de su dueña.
ALTER TABLE "rate_counter" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rate_counter" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_counter" TO medskin_access;--> statement-breakpoint
CREATE POLICY rate_counter_access ON "rate_counter" FOR ALL TO medskin_access
  USING (current_user = 'medskin_access') WITH CHECK (current_user = 'medskin_access');--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- LEER SIN TOCAR
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION medskin_counter_peek(p_name text)
RETURNS TABLE (hits integer, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT c.hits, c.expires_at FROM rate_counter c
   WHERE c.name = p_name AND c.expires_at > now();
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- INCREMENTAR · la ventana se fija UNA sola vez
-- ---------------------------------------------------------------------------------------
-- Lo vencido se reinicia en vez de sumarse: `expires_at <= now()` es una fila que Redis ya
-- habría borrado, así que el contador vuelve a empezar en 1 con ventana nueva.
CREATE FUNCTION medskin_counter_increment(p_name text, p_window_seconds integer)
RETURNS TABLE (hits integer, expires_at timestamptz)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  INSERT INTO rate_counter AS c (name, hits, expires_at)
  VALUES (p_name, 1, now() + make_interval(secs => greatest(1, p_window_seconds)))
  ON CONFLICT (name) DO UPDATE
     SET hits = CASE WHEN c.expires_at > now() THEN c.hits + 1 ELSE 1 END,
         -- La ventana VIVA no se mueve. Solo se pone otra si la anterior ya venció.
         expires_at = CASE WHEN c.expires_at > now() THEN c.expires_at
                           ELSE now() + make_interval(secs => greatest(1, p_window_seconds)) END
  RETURNING c.hits, c.expires_at;
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- MARCAR · una bandera con caducidad, que SÍ se reescribe
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION medskin_counter_mark(p_name text, p_seconds integer)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  INSERT INTO rate_counter (name, hits, expires_at)
  VALUES (p_name, 1, now() + make_interval(secs => greatest(1, p_seconds)))
  ON CONFLICT (name) DO UPDATE
     SET hits = 1, expires_at = now() + make_interval(secs => greatest(1, p_seconds));
$fn$;--> statement-breakpoint

CREATE FUNCTION medskin_counter_has(p_name text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT EXISTS (SELECT 1 FROM rate_counter c WHERE c.name = p_name AND c.expires_at > now());
$fn$;--> statement-breakpoint

CREATE FUNCTION medskin_counter_forget(p_names text[])
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  DELETE FROM rate_counter WHERE name = ANY(coalesce(p_names, '{}'::text[]));
$fn$;--> statement-breakpoint

-- El barrido de lo vencido, que en Redis hacía el propio servidor.
CREATE FUNCTION medskin_counter_purge(p_limit integer)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  WITH viejas AS (
    SELECT name FROM rate_counter WHERE expires_at <= now()
     ORDER BY expires_at
     LIMIT greatest(1, least(coalesce(p_limit, 10000), 100000))
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM rate_counter c USING viejas v WHERE c.name = v.name
  RETURNING 1;
$fn$;--> statement-breakpoint

ALTER FUNCTION medskin_counter_peek(text) OWNER TO medskin_access;--> statement-breakpoint
ALTER FUNCTION medskin_counter_increment(text, integer) OWNER TO medskin_access;--> statement-breakpoint
ALTER FUNCTION medskin_counter_mark(text, integer) OWNER TO medskin_access;--> statement-breakpoint
ALTER FUNCTION medskin_counter_has(text) OWNER TO medskin_access;--> statement-breakpoint
ALTER FUNCTION medskin_counter_forget(text[]) OWNER TO medskin_access;--> statement-breakpoint
ALTER FUNCTION medskin_counter_purge(integer) OWNER TO medskin_access;--> statement-breakpoint

REVOKE ALL ON FUNCTION medskin_counter_peek(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_counter_increment(text, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_counter_mark(text, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_counter_has(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_counter_forget(text[]) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_counter_purge(integer) FROM PUBLIC;--> statement-breakpoint

-- `app_anonymous` porque el límite de intentos corre ANTES de que haya sesión; los otros tres
-- porque también se cuentan acciones de quien ya entró (reenvíos, códigos, mensajes).
GRANT EXECUTE ON FUNCTION medskin_counter_peek(text)
  TO app_anonymous, app_account, app_patient, app_practitioner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_counter_increment(text, integer)
  TO app_anonymous, app_account, app_patient, app_practitioner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_counter_mark(text, integer)
  TO app_anonymous, app_account, app_patient, app_practitioner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_counter_has(text)
  TO app_anonymous, app_account, app_patient, app_practitioner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_counter_forget(text[])
  TO app_anonymous, app_account, app_patient, app_practitioner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_counter_purge(integer) TO app_anonymous;
