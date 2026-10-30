-- =======================================================================================
-- LOS PERMISOS DE CONSOLA DICEN «CONSULTA» · el lado de datos del renombrado
--
-- El commit anterior cambió `plataforma:inquilinos:*` por `plataforma:consultas:*` en el
-- código. Pero esos permisos NO viven solo en el código: viven en `platform_account.permissions`
-- de cada despliegue, escritos ahí por la semilla.
--
-- Sin esta migración, el despliegue del renombrado deja las filas con cadenas que la lista
-- cerrada ya no reconoce, y `POST /v1/platform/access` responde 500 a quien tenía acceso —
-- «un permiso de la fila que no esté en la lista cerrada no se firma». O sea: el renombrado
-- cerraría la consola a quien ya estaba dentro, y haría falta un `UPDATE` a mano contra la
-- base de producción justo después de desplegar. Eso es exactamente lo que las migraciones
-- automáticas del arranque existen para evitar.
--
-- ES IDEMPOTENTE. El `WHERE` solo alcanza filas que todavía tengan algún nombre viejo, así
-- que correrla dos veces no hace nada la segunda, y un despliegue nuevo —cuya semilla ya
-- escribe los nombres nuevos— la ve y no toca ninguna fila.
--
-- Y CONSERVA EL ORDEN de la lista: `WITH ORDINALITY` más `ORDER BY`. Sin eso `array_agg`
-- puede devolver los permisos barajados, y aunque el guardia no mire el orden, una lista que
-- cambia de orden sola hace ilegible cualquier comparación futura entre dos filas.
-- =======================================================================================
UPDATE platform_account
   SET permissions = (
         SELECT array_agg(
                  CASE viejo
                    WHEN 'plataforma:inquilinos:crear'  THEN 'plataforma:consultas:crear'
                    WHEN 'plataforma:inquilinos:leer'   THEN 'plataforma:consultas:leer'
                    WHEN 'plataforma:inquilinos:pausar' THEN 'plataforma:consultas:pausar'
                    ELSE viejo
                  END
                  ORDER BY orden)
           FROM unnest(permissions) WITH ORDINALITY AS t(viejo, orden)
       ),
       updated_at = now()
 WHERE permissions && ARRAY['plataforma:inquilinos:crear',
                            'plataforma:inquilinos:leer',
                            'plataforma:inquilinos:pausar'];
