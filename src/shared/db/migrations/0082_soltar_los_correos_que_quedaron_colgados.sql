-- Las cuentas que los borrados ANTERIORES a la 0081 dejaron colgadas.
--
-- La 0081 arregla el borrado de ahora en adelante, pero no vuelve atrás: una consulta borrada
-- antes dejó la cuenta de su doctora viva, con su correo ocupando el índice único y sin
-- ninguna consulta a la que pertenecer. Medido en producción el 3 de noviembre de 2026: el
-- padrón en «Doctores 0» y el alta de `dramedranoyasmin@gmail.com` contestando «Ese correo ya
-- tiene una cuenta en MedSkin». Sin esto, desplegar la 0081 no desbloquea ese alta.
--
-- Qué es exactamente una cuenta colgada, y por qué las tres condiciones son necesarias:
--   · `role = 'doctor'`  · las de paciente no se tocan: su cuenta es suya y vive sin consulta
--                          con todo derecho.
--   · `deleted_at IS NULL` · lo ya borrado se queda como está; esto no reescribe muñones.
--   · los tres `NOT EXISTS` · ni equipo de ninguna consulta, ni dueña de ninguna, ni paciente
--                          en ningún sitio. Una cuenta con cualquiera de esos lazos NO está
--                          colgada, está en uso.
--
-- No hay carrera con un alta a medias: `medskin_create_practice_owner` crea la consulta, la
-- cuenta y su fila de `practitioner` dentro de la MISMA transacción, así que una cuenta de
-- doctora confirmada sin fila de `practitioner` no es un alta en vuelo, es un resto.
--
-- Se escribe como migración y no como un comando suelto contra la base de producción a
-- propósito: así corre una sola vez, en el despliegue, queda en el historial, y nadie tiene
-- que entrar a la VPS con credenciales para ejecutarla.

DO $$
DECLARE
  v_sueltas integer := 0;
BEGIN
  WITH colgadas AS (
    UPDATE account a
       SET email = ('borrada+' || a.id::text || '@medskin.invalid')::citext,
           first_name = 'Cuenta',
           last_name = 'borrada',
           phone = NULL,
           status = 'borrada',
           deleted_at = now(),
           deletion_reason = 'consulta_borrada_antes_de_0081',
           updated_at = now()
     WHERE a.role = 'doctor'
       AND a.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM practitioner pr WHERE pr.account_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM practice pc WHERE pc.owner_account_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM patient_link pl WHERE pl.account_id = a.id)
    RETURNING a.id
  )
  SELECT count(*) INTO v_sueltas FROM colgadas;

  -- Queda en el registro del despliegue: cuántos correos volvieron a estar libres. Si el
  -- número sorprende a alguien, la bitácora de cada borrado sigue ahí para contar cuál fue.
  RAISE NOTICE 'correos soltados de consultas ya borradas: %', v_sueltas;
END
$$;
