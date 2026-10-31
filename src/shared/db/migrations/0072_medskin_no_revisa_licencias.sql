-- =======================================================================================
-- MEDSKIN NO REVISA LICENCIAS · 30 de octubre de 2026
--
-- Esta migración BORRA un producto entero que nunca debió existir: la revisión manual de la
-- licencia del doctor. El dueño la descartó hoy y su razón es la que manda: **MedSkin no es
-- una asociación médica ni un inspector de salud.** Es una herramienta que ayuda a un doctor
-- con sus pacientes; el doctor hace su evaluación profesional y responde de ella.
--
-- Se pide la matrícula, la especialidad y el país de ejercicio, y se guardan TAL COMO ÉL LAS
-- DECLARA. Nadie las aprueba, nadie las rechaza, y nada se bloquea mientras tanto.
--
-- EL MOTIVO DE FONDO ES DE RESPONSABILIDAD, NO DE ESFUERZO, y por eso esto se borra en vez de
-- quedarse apagado: si MedSkin verificara, MedSkin respondería el día que alguien sin
-- habilitación atienda a una persona, porque MedSkin lo aprobó. Guardando lo declarado,
-- responde quien lo declaró. Una máquina de estados dormida en el esquema es una invitación a
-- volver a encenderla, y lo que se quita es precisamente la promesa.
--
-- LO QUE SE QUEDA, y es lo que el dueño pidió conservar: las tres columnas declaradas, su
-- política de aislamiento, el `GRANT` acotado del doctor y la fila de `access_audit` de cada
-- declaración. Ese registro es lo que sostiene «responde quien lo declaró»: sin él, MedSkin
-- guardaría el dato sin poder decir quién lo puso.
--
-- Y SE AÑADE UNA COLUMNA, `declared_at`. Esto se escribió primero SIN ella, reusando
-- `updated_at` como «cuándo lo declaró», y la base lo tumbó al aplicarla: `updated_at` es
-- `NOT NULL DEFAULT now()`, así que una consulta que no ha declarado nada tendría la fecha de
-- su alta ahí. `declarada_en` habría mostrado una declaración que nunca ocurrió, que es
-- precisamente la clase de dato inventado que este contrato no sirve.
--
-- ORDEN DE LAS SENTENCIAS, y es el que importa: la política va ANTES de las columnas. Su
-- `USING` nombra `status`, y PostgreSQL no deja caer una columna que una política usa
-- (`DROP COLUMN` da `cannot drop column status because other objects depend on it`). Primero
-- se reescribe el `USING`, y recién entonces la columna no tiene a nadie encima.
-- =======================================================================================

-- ---------------------------------------------------------------------------------------
-- 1 · LA POLÍTICA DEL DOCTOR DEJA DE MIRAR EL ESTADO
--
-- Decía `practice_id = medskin_current_practice() AND status IN ('sin_enviar','rechazada')`,
-- que era la mitad de base de la máquina de estados: con la licencia `en_revision` o
-- `verificada`, su propio `UPDATE` tocaba cero filas. Ahora es un formulario y el último
-- `POST` gana, así que lo único que queda es el aislamiento, que es lo que esta política
-- existe para hacer.
--
-- `WITH CHECK` se queda igual: la fila que escribe tiene que seguir siendo de su consulta.
-- ---------------------------------------------------------------------------------------
ALTER POLICY license_practitioner_update ON "license"
  USING (practice_id = medskin_current_practice())
  WITH CHECK (practice_id = medskin_current_practice());--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 2 · LA COLA DE REVISIÓN
--
-- `license_review_queue_idx (status, submitted_at)` servía a UNA consulta: «qué hay en
-- revisión, por antigüedad», que es la bandeja que desaparece. Las dos columnas se van, así
-- que el índice caería solo con ellas; va explícito para que quede dicho que nadie más lo
-- usaba. `license_practice_uq (practice_id)` SE QUEDA: es la clave natural de la fila.
-- ---------------------------------------------------------------------------------------
DROP INDEX "license_review_queue_idx";--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 3 · LOS TRES `CHECK` DE LA MÁQUINA DE ESTADOS
--
-- `license_status_ck` acotaba los cuatro estados. `license_rejection_reason_ck` (0000) y
-- `license_rejection_reason_present_ck` (0016) obligaban a que un rechazo trajera motivo —las
-- dos mitades del mismo `CHECK`, y la 0016 existe porque la primera dejaba pasar el nulo—.
-- Las tres nombran columnas que se van.
--
-- `license_number_ck` SE QUEDA, y es el único: «la matrícula es nula o mide entre 3 y 40» es
-- la regla del dato declarado, no de la revisión. Es la red de base del `400 matricula_vacia`.
-- ---------------------------------------------------------------------------------------
ALTER TABLE "license" DROP CONSTRAINT "license_status_ck";--> statement-breakpoint
ALTER TABLE "license" DROP CONSTRAINT "license_rejection_reason_ck";--> statement-breakpoint
ALTER TABLE "license" DROP CONSTRAINT "license_rejection_reason_present_ck";--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 4 · LAS NUEVE COLUMNAS DE LA REVISIÓN
--
-- `status`, `submitted_at`, `response_estimated_at`, `decided_at`, `rejection_reason` y
-- `reviewed_by` son la máquina de estados entera y su rastro.
--
-- `declaration_accepted` y `terms_accepted` eran dos aceptaciones legales recogidas en el
-- mismo formulario, y se van CON la revisión: la declaración era «la credencial es mía y está
-- vigente», que es una afirmación sobre un documento que ya no se pide. **El consentimiento al
-- tratamiento de datos no se pierde con esto** —no vivía aquí—: vive en `consent` y en el alta
-- de la cuenta, que es donde la persona lo da.
--
-- `credential_key` era la clave del documento de identidad profesional escaneado. Se va, y es
-- la línea importante: guardar la foto del documento de identidad de alguien sin que nadie la
-- mire es quedarse con todo el riesgo de custodiarla y ninguno de sus beneficios. Los objetos
-- que ya estén en el bucket los barre la retención (§13), no esta migración: una migración no
-- borra bytes de un almacén de objetos, y fingir que lo hace sería peor que no decirlo.
--
-- Los `GRANT` de columna del doctor y de `medskin_access` sobre estas seis caen con ellas, que
-- es el comportamiento de `DROP COLUMN` y aquí es justo lo que se quiere. Lo que NO cae es su
-- `GRANT UPDATE (practice_country, specialty, license_number, updated_at)`, que es con lo que
-- guarda el formulario: queda exactamente el permiso del dato declarado.
-- ---------------------------------------------------------------------------------------
ALTER TABLE "license"
  DROP COLUMN "status",
  DROP COLUMN "credential_key",
  DROP COLUMN "declaration_accepted",
  DROP COLUMN "terms_accepted",
  DROP COLUMN "submitted_at",
  DROP COLUMN "response_estimated_at",
  DROP COLUMN "decided_at",
  DROP COLUMN "rejection_reason",
  DROP COLUMN "reviewed_by";--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 4 bis · `declared_at` · CUÁNDO LO DECLARÓ
--
-- NULA mientras no haya declarado nada, que es lo que `updated_at` no puede decir. Las filas
-- que ya existen se quedan nulas a propósito, incluidas las que tengan matrícula puesta por el
-- alta de la consola: **no se inventa una fecha para ellas.** `created_at` sería la del alta y
-- `updated_at` la de cualquier escritura anterior; las dos mentirían, y una casilla vacía en
-- una pantalla de soporte es más honesta que una fecha que nadie puso.
--
-- El `GRANT` es el del formulario: el doctor la escribe en el mismo `UPDATE` que las otras
-- tres. `medskin_access` también, porque el alta de la consola escribe esa fila.
-- ---------------------------------------------------------------------------------------
ALTER TABLE "license" ADD COLUMN "declared_at" timestamptz;--> statement-breakpoint
GRANT UPDATE ("declared_at") ON "license" TO app_practitioner;--> statement-breakpoint
GRANT UPDATE ("declared_at") ON "license" TO medskin_access;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 5 · `medskin_license_to_review()`
--
-- Era la transición a `en_revision`, con su guarda de dueña y su `FOR UPDATE`. Existía por un
-- motivo que ya no se da: el doctor no tenía el `GRANT` de `status`, así que el estado lo
-- movía una `SECURITY DEFINER` y no un `UPDATE` suyo. Sin estado no hay nada que mover, y el
-- formulario lo escribe él con su propia política y su `GRANT` de tres columnas.
--
-- **Esto quita una `SECURITY DEFINER` del esquema, que es la dirección buena.** Cada función
-- que corre como `medskin_access` es superficie que hay que leer entera para saber qué puede;
-- una menos es una menos.
-- ---------------------------------------------------------------------------------------
DROP FUNCTION medskin_license_to_review(timestamptz);--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 6 · `medskin_notify_owner()`
--
-- La creó la 0050 para UNA cosa: avisarle al doctor de la decisión de su licencia, por push y
-- por correo. Sin decisión no hay aviso, y era su único llamador (`platform.repository.ts`).
--
-- Se borra en vez de quedarse por si acaso, y el motivo es el de siempre con una
-- `SECURITY DEFINER`: encola en la cuenta DUEÑA de cualquier consulta, sin contexto de
-- inquilino, y está concedida a `app_platform`. Una función con ese alcance y cero llamadores
-- es exactamente la que alguien reutiliza en seis meses sin leer por qué su guarda era así.
-- El día que la consola necesite avisar al doctor de otra cosa, se escribe con la guarda de
-- ese caso.
-- ---------------------------------------------------------------------------------------
DROP FUNCTION medskin_notify_owner(uuid, text, text, text, jsonb, text);
