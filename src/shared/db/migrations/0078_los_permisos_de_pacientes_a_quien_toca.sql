-- =======================================================================================
-- LOS TRES PERMISOS DE PACIENTES, A QUIEN LE TOCA Y NO A TODOS · 31 de octubre de 2026
--
-- `plataforma:pacientes:leer`, `plataforma:pacientes:crear` y `plataforma:historia:leer`
-- nacieron con la 0077. Las cuentas de consola que ya existen no los tienen, así que las cinco
-- rutas nuevas responderían `403 sin_permiso` a quien ya es super admin.
--
-- Va en una migración y no en un `platform:seed` a mano, por lo mismo que la 0074 y la 0076:
-- si hay una migración se aplica sola al desplegar, sin entrar a ninguna máquina. Y la semilla
-- vuelve a pedir la contraseña, que en producción es un riesgo que esto no tiene.
--
-- =======================================================================================
-- DOS REGLAS DISTINTAS, Y LA SEGUNDA ES EL PUNTO ENTERO DE ESTA MIGRACIÓN
-- =======================================================================================
--
-- Los tres permisos se separaron precisamente para que pueda existir una cuenta de soporte que
-- **administra y NO lee expedientes**. Si esta migración se los diera los tres a todo el mundo,
-- esa separación moriría el mismo día que nació y nadie lo habría decidido — sería la versión
-- automática de «quien puede reenviar un acceso puede leer alergias».
--
-- Así que:
--
--   1 · `pacientes:leer` y `pacientes:crear` · a quien YA PUEDE ACTUAR SOBRE UNA CUENTA
--       (`acceso:reenviar` o `pausa:levantar`). Es la misma regla de la 0076 y por el mismo
--       motivo: quien atiende a una persona por teléfono es quien necesita su ficha.
--
--   2 · `historia:leer` · SOLO a la cuenta que ya tiene TODOS los demás permisos.
--       Una cuenta con el juego completo es, por definición, la de acceso total — hoy, la del
--       dueño. Una con un subconjunto es una cuenta de soporte acotada, y **no puede ganar en
--       silencio el permiso más caro del sistema**: el que abre la historia clínica.
--       El día que haga falta dárselo a alguien más, se le da a mano y alguien lo decide.
-- =======================================================================================
UPDATE platform_account
   SET permissions = permissions
         || ARRAY['plataforma:pacientes:leer', 'plataforma:pacientes:crear']::text[],
       updated_at = now()
 WHERE NOT ('plataforma:pacientes:leer' = ANY (permissions))
   AND ('plataforma:acceso:reenviar' = ANY (permissions)
        OR 'plataforma:pausa:levantar' = ANY (permissions));--> statement-breakpoint

UPDATE platform_account
   SET permissions = array_append(permissions, 'plataforma:historia:leer'),
       updated_at = now()
 WHERE NOT ('plataforma:historia:leer' = ANY (permissions))
   AND 'plataforma:consultas:crear'  = ANY (permissions)
   AND 'plataforma:consultas:leer'   = ANY (permissions)
   AND 'plataforma:cuentas:buscar'   = ANY (permissions)
   AND 'plataforma:acceso:reenviar'  = ANY (permissions)
   AND 'plataforma:pausa:levantar'   = ANY (permissions)
   AND 'plataforma:pacientes:leer'   = ANY (permissions)
   AND 'plataforma:pacientes:crear'  = ANY (permissions);--> statement-breakpoint

-- La misma guarda de la 0074 y la 0076, con la lista de hoy: si queda una fila con un permiso
-- que `PLATFORM_PERMISSIONS` no conoce, esto FALLA y el contenedor no arranca. Mejor que
-- arrancar con una consola que no puede firmar su token y descubrirlo por el primer 500.
DO $$
DECLARE
  v_malas text[];
BEGIN
  SELECT array_agg(DISTINCT p) INTO v_malas
    FROM platform_account a, unnest(a.permissions) AS p
   WHERE p <> ALL (ARRAY['plataforma:consultas:crear', 'plataforma:consultas:leer',
                         'plataforma:acceso:reenviar', 'plataforma:pausa:levantar',
                         'plataforma:cuentas:buscar', 'plataforma:pacientes:leer',
                         'plataforma:pacientes:crear', 'plataforma:historia:leer',
                         'plataforma:suplantar']);
  IF v_malas IS NOT NULL THEN
    RAISE EXCEPTION 'platform_account tiene permisos que la lista cerrada no conoce: %', v_malas;
  END IF;
END $$;
