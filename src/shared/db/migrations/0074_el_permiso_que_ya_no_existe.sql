-- =======================================================================================
-- FUERA `plataforma:licencias:decidir` DE LAS CUENTAS DE CONSOLA · 30 de octubre de 2026
--
-- La 0072 lo borró de `PLATFORM_PERMISSIONS`, que es la lista CERRADA contra la que
-- `PlatformTokens.sign()` valida antes de firmar. Lo que esa migración no podía tocar es el
-- DATO: las filas de `platform_account` que ya lo tienen concedido.
--
-- Y eso no es cosmético, es la consola entera: firmar un token con un permiso que el
-- verificador no conoce **lanza**, y un token que lo trajera **se rechazaría entero** —no se
-- ignora el permiso raro y se atienden los demás—. O sea que sin esto, la cuenta de super
-- admin de PROD deja de poder entrar en el momento en que suba el código nuevo.
--
-- POR QUÉ UNA MIGRACIÓN Y NO UN `UPDATE` A MANO EN LA VPS, que era la otra salida: el dueño
-- pidió el 30 de octubre que una migración se aplique sola al desplegar, sin entrar a la
-- máquina. El `CMD` de la imagen es `migrate && main`, así que esto corre ANTES de que el
-- proceso acepte una sola petición: ningún entorno pasa por el estado roto, ni este
-- despliegue ni el de la próxima región.
--
-- IDEMPOTENTE, como la 0069: `array_remove` sobre una fila que ya no lo tiene no cambia nada,
-- y el `WHERE` evita escribir filas que no hace falta tocar.
-- =======================================================================================
UPDATE platform_account
   SET permissions = array_remove(permissions, 'plataforma:licencias:decidir'),
       updated_at = now()
 WHERE 'plataforma:licencias:decidir' = ANY (permissions);--> statement-breakpoint

-- Y LA COMPROBACIÓN, que es lo que convierte esto en una garantía y no en un buen deseo: si
-- queda una sola fila con un permiso que la lista cerrada no conoce, la migración FALLA y el
-- contenedor no arranca. Es mejor que arrancar con una consola que no puede entrar y
-- descubrirlo por el primer `500`.
--
-- La lista va escrita aquí a propósito y no leída de ningún sitio: una migración es un hecho
-- de un momento, y si mañana se añade un permiso, esta comprobación tiene que seguir
-- describiendo lo que era verdad hoy.
DO $$
DECLARE
  v_malas text[];
BEGIN
  SELECT array_agg(DISTINCT p) INTO v_malas
    FROM platform_account a, unnest(a.permissions) AS p
   WHERE p <> ALL (ARRAY['plataforma:consultas:crear', 'plataforma:consultas:leer',
                         'plataforma:acceso:reenviar', 'plataforma:pausa:levantar',
                         'plataforma:suplantar']);
  IF v_malas IS NOT NULL THEN
    RAISE EXCEPTION 'platform_account tiene permisos que la lista cerrada no conoce: %', v_malas;
  END IF;
END $$;
