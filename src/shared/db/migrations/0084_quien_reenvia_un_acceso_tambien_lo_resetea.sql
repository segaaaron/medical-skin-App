-- El permiso del reseteo, a las cuentas de consola que ya existen.
--
-- §3.4, regla 7 · §1.5 del napkin: versionada, y NUNCA editada después de aplicarse.
--
-- EL AGUJERO, medido el 4 de noviembre de 2026 con el dueño delante de la ficha de una
-- doctora: `plataforma:acceso:resetear` nació esta misma tarde con la 0083, y los permisos de
-- consola NO los reparte el código — viven en `platform_account.permissions`, una fila por
-- persona, escritos al crear la cuenta (`pnpm platform:seed`). O sea que el endpoint estaba en
-- el aire y NADIE podía llamarlo: la cuenta del dueño trae diez permisos, y el nuevo es el
-- once. Una ruta que nadie puede firmar es una ruta que no existe.
--
-- A QUIÉN SE LE DA, y es la decisión del dueño de hoy: a quien ya tiene
-- `plataforma:acceso:reenviar`. Es soporte, que es quien atiende la llamada. En la 0083 quedó
-- escrito que el permiso es PROPIO y que no se concede con el de reenviar, y eso sigue siendo
-- verdad para las cuentas que vengan: `platform:seed` pide la lista explícita y no regala
-- nada. Lo que esta migración hace es concederlo UNA VEZ a las filas que ya estaban, porque la
-- alternativa era que la función no la pudiera usar nadie.
--
-- MISMO MECANISMO QUE LA 0076 («quien actúa sobre una cuenta puede buscarla»), que es el
-- precedente de esta casa para un permiso nuevo sobre filas viejas. Idempotente por el
-- `WHERE NOT (… = ANY (permissions))`: correrla dos veces no duplica nada.
--
-- Y LA GUARDA DE SIEMPRE, con la lista de HOY: si en `platform_account` queda un permiso que
-- `PLATFORM_PERMISSIONS` no conoce, esto FALLA y el contenedor no arranca. Es mejor que
-- arrancar con una consola que no puede firmar su token y enterarse por el primer 500.

UPDATE platform_account
   SET permissions = array_append(permissions, 'plataforma:acceso:resetear'),
       updated_at = now()
 WHERE NOT ('plataforma:acceso:resetear' = ANY (permissions))
   AND ('plataforma:acceso:reenviar' = ANY (permissions));--> statement-breakpoint

DO $$
DECLARE
  v_malas text[];
BEGIN
  SELECT array_agg(DISTINCT p) INTO v_malas
    FROM platform_account a, unnest(a.permissions) AS p
   WHERE p <> ALL (ARRAY['plataforma:consultas:crear', 'plataforma:consultas:leer',
                         'plataforma:consultas:suspender', 'plataforma:consultas:borrar',
                         'plataforma:acceso:reenviar', 'plataforma:acceso:resetear',
                         'plataforma:pausa:levantar', 'plataforma:cuentas:buscar',
                         'plataforma:pacientes:leer', 'plataforma:pacientes:crear',
                         'plataforma:historia:leer', 'plataforma:suplantar']);
  IF v_malas IS NOT NULL THEN
    RAISE EXCEPTION 'platform_account tiene permisos que la lista cerrada no conoce: %', v_malas;
  END IF;
END $$;
