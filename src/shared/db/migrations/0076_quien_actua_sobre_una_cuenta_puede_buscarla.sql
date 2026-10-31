-- =======================================================================================
-- EL PERMISO NUEVO LLEGA SOLO A QUIEN YA LO NECESITA · 31 de octubre de 2026
--
-- `plataforma:cuentas:buscar` nació con `GET /v1/platform/accounts?correo=` en este mismo
-- tramo. Las cuentas de consola que ya existen NO lo tienen —cuando se sembraron no existía—,
-- así que la pantalla de buscar cuentas respondería `403 sin_permiso` a quien ya es super
-- admin: correcto por el guardia, y sin sentido para quien mira.
--
-- POR QUÉ UNA MIGRACIÓN Y NO VOLVER A SEMBRAR, que es lo que estuve a punto de pedir: el dueño
-- lo dijo el 30 de octubre y vale para los DATOS igual que para el esquema — si hay una
-- migración, se aplica sola al desplegar, sin entrar a ninguna máquina. La 0074 ya hizo
-- exactamente esto en sentido contrario, quitando un permiso que el código había borrado.
-- Pedir un `platform:seed` a mano habría sido deshacer esa regla, y además con un riesgo que
-- la migración no tiene: la semilla pide la contraseña otra vez, así que un dedo torpe deja la
-- cuenta de producción con una credencial que nadie quería.
--
-- A QUIÉN SE LE DA, y no es «a todos»: solo a quien **ya puede actuar sobre una cuenta**, que
-- es tener `plataforma:acceso:reenviar` o `plataforma:pausa:levantar`. Esa es la regla y no una
-- lista de correos, porque el endpoint existe exactamente para eso: las dos acciones piden un
-- `account_id` y soporte solo tiene el correo. Quien puede reenviar un acceso ya podía actuar
-- sobre esa cuenta teniendo su uuid; esto no le concede un sujeto nuevo, le concede encontrarlo.
--
-- A quien solo lee el padrón de consultas NO se le da, y es la misma línea que hizo que el
-- permiso fuera propio en vez de reusar `plataforma:consultas:leer`: «esta persona tiene cuenta
-- en MedSkin» es otro oráculo, y una cuenta puede ser de una paciente.
--
-- IDEMPOTENTE: `array_append` solo sobre las filas que no lo tienen, por el `WHERE`.
-- =======================================================================================
UPDATE platform_account
   SET permissions = array_append(permissions, 'plataforma:cuentas:buscar'),
       updated_at = now()
 WHERE NOT ('plataforma:cuentas:buscar' = ANY (permissions))
   AND ('plataforma:acceso:reenviar' = ANY (permissions)
        OR 'plataforma:pausa:levantar' = ANY (permissions));--> statement-breakpoint

-- La misma guarda de la 0074, con la lista de hoy: si queda un permiso que la lista cerrada de
-- `PLATFORM_PERMISSIONS` no conoce, esto FALLA y el contenedor no arranca. Es mejor que
-- arrancar con una consola que no puede firmar su token y descubrirlo por el primer 500.
DO $$
DECLARE
  v_malas text[];
BEGIN
  SELECT array_agg(DISTINCT p) INTO v_malas
    FROM platform_account a, unnest(a.permissions) AS p
   WHERE p <> ALL (ARRAY['plataforma:consultas:crear', 'plataforma:consultas:leer',
                         'plataforma:acceso:reenviar', 'plataforma:pausa:levantar',
                         'plataforma:cuentas:buscar', 'plataforma:suplantar']);
  IF v_malas IS NOT NULL THEN
    RAISE EXCEPTION 'platform_account tiene permisos que la lista cerrada no conoce: %', v_malas;
  END IF;
END $$;
