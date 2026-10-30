-- =======================================================================================
-- EL TELÉFONO DE LA DOCTORA ENTRA EN EL ALTA · 30 de octubre de 2026
--
-- Pedido por el dueño. Es el ÚNICO dato de contacto que no depende del correo: si el correo
-- de bienvenida no sale —el caso que `service_failure` y «reenviar acceso» existen para
-- cubrir— hoy no hay forma de avisarle a la doctora de que su cuenta existe.
--
-- POR QUÉ ESTO ES UNA MIGRACIÓN Y NO UN `UPDATE` EN EL REPOSITORIO, que habría sido más
-- barato: `app_platform` tiene `INSERT (… , phone)` sobre `account` pero **no tiene UPDATE**.
-- Esa asimetría es deliberada —la consola crea cuentas y no las edita— así que el teléfono
-- tiene que entrar por la misma función `SECURITY DEFINER` que crea la fila, o no entra.
--
-- El parámetro va AL FINAL y con `DEFAULT NULL`, así que toda llamada de seis argumentos que
-- ya existe sigue valiendo: la semilla de desarrollo no se toca y las pruebas tampoco.
--
-- No es obligatorio y no se valida aquí: la forma E.164 la comprueba el borde, con el MISMO
-- lector que el alta de pacientes. Lo que hace esta función es no guardar una cadena vacía
-- como si fuera un número.
--
-- Y LA VIEJA SE BORRA ANTES, que es lo que `CREATE OR REPLACE` NO hace cuando la firma
-- cambia: Postgres crea una SOBRECARGA. Con las dos vivas, toda llamada de seis argumentos
-- queda ambigua —«function … is not unique»— porque el séptimo tiene `DEFAULT`. Lo encontró
-- la suite: dos pruebas de base que llaman con seis argumentos dejaron de compilar la
-- consulta. Un `DEFAULT` no evita este problema, lo esconde hasta que alguien llama.
-- =======================================================================================
DROP FUNCTION IF EXISTS medskin_create_practice_owner(uuid, citext, text, text, text, timestamptz);--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.medskin_create_practice_owner(p_practice_id uuid, p_email citext, p_first_name text, p_last_name text, p_hash text, p_expires_at timestamp with time zone, p_phone text DEFAULT NULL)
 RETURNS TABLE(verdict text, account_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_region text;
  v_owner uuid;
  v_account uuid;
BEGIN
  IF p_practice_id IS NULL OR p_email IS NULL OR btrim(p_email::text) = ''
     OR p_first_name IS NULL OR btrim(p_first_name) = ''
     OR p_last_name IS NULL OR btrim(p_last_name) = '' THEN
    RAISE EXCEPTION 'medskin_create_practice_owner: argumentos incompletos'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_hash IS NULL OR p_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'medskin_create_practice_owner: la temporal no viene hasheada con Argon2id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now()
     OR p_expires_at > now() + interval '73 hours' THEN
    RAISE EXCEPTION 'medskin_create_practice_owner: la temporal vive 72 h'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT p.region, p.owner_account_id INTO v_region, v_owner
    FROM practice p WHERE p.id = p_practice_id FOR UPDATE;
  IF v_region IS NULL THEN
    RETURN QUERY SELECT 'practice_not_found', NULL::uuid;
    RETURN;
  END IF;
  -- Refuerzo de la clave natural `(correo_doctora, region)`: un reintento no pone una
  -- segunda dueña.
  IF v_owner IS NOT NULL THEN
    RETURN QUERY SELECT 'practice_has_owner', v_owner;
    RETURN;
  END IF;

  SELECT a.id INTO v_account FROM account a WHERE a.email = p_email;
  IF v_account IS NOT NULL THEN
    RETURN QUERY SELECT 'email_taken', v_account;
    RETURN;
  END IF;

  INSERT INTO account (email, role, region, first_name, last_name, phone)
  VALUES (p_email, 'doctor', v_region, btrim(p_first_name), btrim(p_last_name),
          nullif(btrim(coalesce(p_phone, '')), ''))
  RETURNING account.id INTO v_account;

  INSERT INTO credential (account_id, hash, is_temporary, temp_expires_at)
  VALUES (v_account, p_hash, true, p_expires_at);

  -- `permissions` nulo: los de su rol (decisión 11).
  INSERT INTO practitioner (practice_id, account_id, first_name, last_name, role)
  VALUES (p_practice_id, v_account, btrim(p_first_name), btrim(p_last_name), 'doctor');

  UPDATE practice p SET owner_account_id = v_account, updated_at = now()
   WHERE p.id = p_practice_id;

  -- LO ÚNICO NUEVO DE LA 0015. `sin_enviar` sale del `DEFAULT`, que es lo que el 201 del
  -- contrato promete. `ON CONFLICT` y no un `IF NOT EXISTS` porque la siembra de las
  -- pruebas y de `seed.ts` crea su propia fila con `id` fijo: el que llegue primero gana y
  -- el segundo no revienta.
  INSERT INTO license (practice_id) VALUES (p_practice_id)
  ON CONFLICT (practice_id) DO NOTHING;

  RETURN QUERY SELECT 'created', v_account;
END
$function$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- Y SUS PERMISOS, QUE EL `DROP` SE LLEVÓ POR DELANTE.
--
-- Esto no es rutina: una función recién creada tiene `EXECUTE` para `PUBLIC` por omisión, así
-- que entre el `DROP` y estas tres líneas la del alta de consultas quedaba abierta a
-- cualquier rol — incluida `app_practitioner`. Una doctora podría haber creado consultas y
-- dueñas.
--
-- Lo cazó `access-functions.spec.ts`, que comprueba función por función quién puede llamarla
-- y quién no. Esa prueba existe exactamente para esto: los permisos de una función no se ven
-- leyendo su cuerpo.
-- ---------------------------------------------------------------------------------------
ALTER FUNCTION medskin_create_practice_owner(uuid, citext, text, text, text, timestamptz, text)
  OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_create_practice_owner(uuid, citext, text, text, text, timestamptz, text)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_create_practice_owner(uuid, citext, text, text, text, timestamptz, text)
  TO app_platform;
