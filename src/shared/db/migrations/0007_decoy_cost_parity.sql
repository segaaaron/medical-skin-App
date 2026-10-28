-- Tramo 1 · EL SEÑUELO, RESEMBRADO CON LOS PARÁMETROS REALES DE LA APLICACIÓN.
-- Cierra el bloqueante que midió `revisor-senior`, y es un agujero de verdad.
--
-- QUÉ ESTABA MAL: la sección 6 de la 0002 sembró `access_decoy.hash` con
-- `m=65536,p=4,t=3` —los valores por defecto de la librería— y la aplicación hashea las
-- contraseñas reales con `m=19456,p=1,t=2` (perfil OWASP 2024,
-- `src/shared/security/passwords.ts`). Los parámetros de Argon2 viajan DENTRO del hash
-- codificado, así que `argon2.verify()` cuesta lo que diga EL HASH QUE RECIBE y no lo que
-- diga la configuración del proceso.
--
-- Medido en esta máquina con la librería instalada, el mismo `verify` contra los dos
-- hashes: 15,4 ms contra el real y 28,2 ms contra el señuelo. El doble. Eso es un oráculo
-- de enumeración de cuentas con un cronómetro y UNA petición por correo —ni hay que acertar
-- una contraseña, ni molesta la pausa, porque cada correo tiene su contador—, y es
-- exactamente lo que `acceso.md` prohíbe con «Mismo tiempo» en negrita. En una app de
-- clínicas de estética, el padrón de correos ES dato de salud por la propia regla del
-- diseño.
--
-- POR QUÉ NO SE VIO: `seed.ts` re-hashea el señuelo con los parámetros correctos y hace
-- `on conflict do update`, pero se niega a correr si `NODE_ENV` no es `development`. En
-- local el oráculo no existe; en producción nadie reescribe esa fila nunca. Un arreglo que
-- vive solo en la semilla de desarrollo no es un arreglo.
--
-- Y LA 0002 NO SE EDITA (§3.4, regla 7), así que la fila se corrige aquí. El literal de
-- abajo se generó con `argon2.hash()` y `ARGON2_COST` tal cual están hoy en el código, de
-- 32 bytes aleatorios que no se guardaron: no hay contraseña que lo abra y no hace falta
-- que la haya. Lo único que importa de él es cuánto cuesta verificarlo.
--
-- CÓMO SE EVITA QUE SE VUELVA A DESINCRONIZAR EN SILENCIO, QUE ES LA MITAD DEL ARREGLO
--
-- 1. `access_decoy_hash_ck`: la fila solo acepta un Argon2id codificado y completo, con sus
--    tres parámetros presentes. Una cadena inventada a mano —como la de la 0002, que además
--    llevaba los parámetros en un orden que la librería no emite— ya no entra.
-- 2. `medskin_access_decoy_params()`: devuelve el algoritmo y los tres costes PARSEADOS DEL
--    PROPIO HASH, y nunca el hash. Es lo que la comprobación de arranque de
--    `backend-senior` tiene que leer para negarse a servir si no coinciden con su
--    `ARGON2_COST`. Se parsean del hash y NO se guardan en columnas aparte a propósito: dos
--    copias del mismo dato son dos copias que se pueden desincronizar, y entonces harían
--    falta tres comprobaciones en vez de una.
-- 3. El `EXECUTE` es solo de `app_anonymous`, que es el rol de `POST /v1/acceso` y el único
--    cuyo reloj está en juego. El `hash` sigue sin tener un solo `GRANT SELECT` para los
--    cuatro roles de aplicación: lo que no se puede leer no se compara.
--
-- §3.4, regla 7: versionada, y NUNCA editada después de aplicarse.

INSERT INTO "access_decoy" (only_row, hash)
VALUES (true, '$argon2id$v=19$m=19456,p=1,t=2$Cxn/d+APEzTsm6Ckc3Xf1A$4+9Luamu4CrTRSqz7rWxCJY49vSQUkKTBlaiJPvmXcs')
ON CONFLICT (only_row) DO UPDATE
  SET hash = excluded.hash, updated_at = now();--> statement-breakpoint

-- El orden de los parámetros es el que EMITE la librería (`m`, `p`, `t`), no el del RFC:
-- comprobado contra `argon2.hash()`. La función de abajo los busca por nombre y no por
-- posición, así que un cambio de orden en una versión futura no la rompe; esta restricción
-- solo exige que los tres estén y que la cadena sea un hash codificado de verdad.
ALTER TABLE "access_decoy" ADD CONSTRAINT "access_decoy_hash_ck"
  CHECK ("hash" ~ '^\$argon2id\$v=19\$m=[0-9]+,p=[0-9]+,t=[0-9]+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$');--> statement-breakpoint

CREATE FUNCTION medskin_access_decoy_params()
RETURNS TABLE (algorithm text, memory_cost integer, time_cost integer, parallelism integer,
               seeded_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT substring(d.hash from '^\$([a-z0-9]+)\$'),
         (substring(d.hash from 'm=([0-9]+)'))::integer,
         (substring(d.hash from 't=([0-9]+)'))::integer,
         (substring(d.hash from 'p=([0-9]+)'))::integer,
         d.updated_at
    FROM access_decoy d WHERE d.only_row;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_access_decoy_params() OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_access_decoy_params() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_access_decoy_params() TO app_anonymous;--> statement-breakpoint
