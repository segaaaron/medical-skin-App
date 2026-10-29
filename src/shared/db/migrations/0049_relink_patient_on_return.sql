-- =======================================================================================
-- EL «vuelve_si» TIENE QUIEN LO LEA · 29 de octubre de 2026
--
-- El 200 del borrado de cuenta le promete a la paciente, por escrito: «vuelve_si: tu doctora
-- te da de alta otra vez con este mismo correo». El borrado hace su parte —suelta el vínculo
-- (`account_id = NULL`) y CONSERVA EL CORREO a propósito, «es la llave del vuelve_si»
-- (0014:247)— y ninguna línea del sistema volvía a leer esa llave: el alta siempre insertaba
-- un `patient_link` nuevo.
--
-- Lo que pasaba de verdad: Ana borra su cuenta, su ficha y sus antecedentes se quedan con el
-- vínculo suelto; meses después la misma doctora la da de alta con ese correo y se crea UNA
-- SEGUNDA FICHA. La cuenta sí se reusaba; el expediente no. Para la doctora eran dos pacientes
-- que son la misma persona, y en la app de Ana aparecía una ficha vacía.
--
-- POR QUÉ UNA FUNCIÓN Y NO UN `UPDATE`: `patient_link.account_id` solo lo puede escribir
-- `medskin_access` —`GRANT UPDATE (account_id, status, updated_at)` de la 0014—, y eso está
-- bien: si `app_practitioner` pudiera escribir esa columna, una doctora podría apuntar el
-- vínculo de una ficha suya a la cuenta de cualquiera. La función reengancha SOLO:
--   · un vínculo SUELTO (`account_id is null`), nunca uno vivo de otra cuenta;
--   · de la consulta del CONTEXTO, nunca de otra;
--   · cuyo correo guardado es el de la cuenta que se reengancha, que es la llave entera.
-- Y devuelve el `patient_id` que reusar, o nulo si no había nada que reengancharse.
-- =======================================================================================
CREATE FUNCTION medskin_relink_patient(p_email text, p_account_id uuid)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  UPDATE patient_link l
     SET account_id = p_account_id, status = 'invitada', updated_at = now()
   WHERE l.id = (
     SELECT x.id FROM patient_link x
      WHERE x.account_id IS NULL
        AND x.practice_id = medskin_current_practice()
        AND x.email = p_email::citext
        AND EXISTS (SELECT 1 FROM account a
                     WHERE a.id = p_account_id AND a.email = p_email::citext)
      ORDER BY x.updated_at DESC NULLS LAST
      LIMIT 1
   )
  RETURNING l.patient_id;
$fn$;--> statement-breakpoint
ALTER FUNCTION medskin_relink_patient(text, uuid) OWNER TO medskin_access;--> statement-breakpoint
REVOKE ALL ON FUNCTION medskin_relink_patient(text, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medskin_relink_patient(text, uuid) TO app_practitioner;
