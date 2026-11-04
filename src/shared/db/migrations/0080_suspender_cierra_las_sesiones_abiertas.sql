-- =======================================================================================
-- SUSPENDER CIERRA LAS SESIONES QUE YA ESTABAN ABIERTAS · 3 de noviembre de 2026
--
-- Va en una migración APARTE y no dentro de la 0079 porque la 0079 ya está aplicada, y una
-- aplicada no se edita: si falta algo, se escribe la siguiente. Se intentó editarla y el
-- migrador la saltó —ya estaba en `__drizzle_migrations`—, que es exactamente lo que esa regla
-- existe para que pase.
--
-- EL HUECO QUE CIERRA. La 0079 bloquea el ACCESO de una consulta suspendida, pero quien ya
-- tenía la app abierta seguiría trabajando mientras su refresco siguiera vivo —doce horas para
-- una doctora—. Una suspensión que no suspende.
--
-- Se cierra revocando la fila de `session`, que es la máquina que YA EXISTE: el refresco y la
-- lectura de sesión comprueban `revoked_at` y responden `401 sesion_revocada` desde el primer
-- tramo. No hace falta un camino nuevo, solo poder escribir esa columna.
--
-- EL GRANT ES DE UNA SOLA COLUMNA, y es la diferencia entre «cerrar la sesión de alguien» y
-- «poder tocar sus sesiones». `app_platform` ya tenía `SELECT` sobre cinco columnas de
-- `session` —para contar cuántas hay abiertas—; ahora puede además marcar `revoked_at`, y nada
-- más: no puede abrir una sesión, ni mover su refresco, ni leer su huella.
--
-- REACTIVAR NO DESHACE ESTO, a propósito: una sesión cerrada no se reabre. La doctora vuelve a
-- entrar con su contraseña, que es lo que cualquiera espera después de que le levanten una
-- suspensión.
-- =======================================================================================

GRANT UPDATE ("revoked_at") ON "session" TO app_platform;--> statement-breakpoint

CREATE POLICY "session_platform_revoke" ON "session"
  AS PERMISSIVE FOR UPDATE TO app_platform
  USING (CURRENT_USER = 'app_platform')
  WITH CHECK (CURRENT_USER = 'app_platform');--> statement-breakpoint
