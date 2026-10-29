-- =======================================================================================
-- `REVOKE SELECT ON account` BORRÓ TAMBIÉN LOS GRANTS POR COLUMNA · y tumbó 71 pruebas
--
-- La 0059 quiso cambiar el `GRANT SELECT` de tabla entera que puso la 0058 por uno de tres
-- columnas, y lo hizo así:
--
--     REVOKE SELECT ON "account" FROM medskin_access;
--     GRANT SELECT ("id", "email", "status") ON "account" TO medskin_access;
--
-- **En PostgreSQL, revocar un privilegio a nivel de TABLA revoca también los privilegios de
-- ese mismo tipo a nivel de COLUMNA.** Y la 0002 le había concedido `SELECT` sobre DOCE
-- columnas de `account`, que es lo que leen las funciones del acceso, de la recuperación y del
-- refresco. O sea que la 0059 no acotó un privilegio: borró el de la capa de acceso entera. Lo
-- cazó la suite en el acto —71 pruebas, `access-functions.spec.ts` la primera—.
--
-- Esta migración devuelve **la lista exacta de la 0002**, copiada del archivo. Las tres que los
-- dos programadores de avisos necesitan —`id`, `email`, `status`— ya están dentro, así que no
-- hace falta nada más y el `GRANT` de tabla entera de la 0058 queda deshecho de verdad.
--
-- LA LECCIÓN, y va al napkin: **no se revoca a nivel de tabla para re-conceder por columna.**
-- Si lo que se quiere es acotar, se revoca y se vuelve a conceder LA LISTA COMPLETA que la
-- tabla tenía, no solo la parte nueva. Y la lista completa se lee del archivo donde se
-- concedió, no de memoria — exactamente igual que un `CREATE OR REPLACE` (napkin §1.7).
-- =======================================================================================
GRANT SELECT (id, email, role, region, first_name, last_name, phone, status, locked_until,
              failed_attempts, deleted_at, created_at)
  ON "account" TO medskin_access;
