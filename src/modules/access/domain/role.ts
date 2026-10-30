// Cómo se resuelve lo que la app lee: el `rol` y la lista de `permisos`.
// Regla dura: NADA de esto viene del cliente (_convenciones.md · «Lo que ningún endpoint
// de este tramo hace»). Sale de la fila de `account` y de la de `practitioner`.

import type { AccountRole, PractitionerRole, Role } from '../../../shared/contract/session';

/**
 * El `rol` de la respuesta. `paciente` cuando la cuenta es de paciente; en otro caso, el
 * `practitioner.role` de la fila de ESTA consulta.
 *
 * Devuelve `null` cuando la cuenta es `practitioner` y no hay fila de consulta activa: eso
 * no es un rol que se pueda inventar, es una inconsistencia de datos, y quien llama la
 * convierte en 500 con su causa real en `service_failure`.
 */
export function resolveRole(
  accountRole: AccountRole,
  practitionerRole: PractitionerRole | null,
): Role | null {
  if (accountRole === 'patient') return 'patient';
  return practitionerRole;
}

/**
 * Los permisos del doctor, para cuando `practitioner.permissions` es nulo — que es el 100 %
 * de las filas de la primera entrega.
 *
 * UNA SOLA FILA desde el 30 de octubre de 2026. Antes eran tres —doctora, asistente clínico
 * y recepción— con una tabla de dieciséis permisos repartidos entre ellas. Esa tabla no la
 * pidió nadie: salió de un paréntesis del documento de diseño, y el propio diseño pone el
 * «equipo con roles» en la FASE 3. Estaba además construida en la capa débil: NINGUNA de las
 * 136 políticas de la base distinguía esos sub-roles, así que lo único que separaba a
 * recepción de una historia clínica eran dieciséis comprobaciones en TypeScript que un
 * endpoint nuevo podía olvidar.
 *
 * La columna `practitioner.permissions` se queda, y ahora es lo único que acota: si algún
 * día hay más de una persona en una consulta, se le escribe su lista explícita. Eso es lo
 * que el estado del diseño pedía desde el principio — «permisos como interruptores, no como
 * roles» — y es lo contrario de lo que había.
 *
 * `equipo:crear` y `equipo:permisos` salen de la lista con los endpoints que los pedían.
 * `consulta:licencia:enviar` nunca estuvo aquí: es «solo la dueña», y la dueña es una FILA
 * (`practice.owner_account_id`), no una cadena.
 */
export const PERMISSIONS_BY_ROLE: Readonly<Record<PractitionerRole, readonly string[]>> = {
  doctor: [
    'pacientes:leer',
    'pacientes:crear',
    'pacientes:acceso:enviar',
    'agenda:leer',
    'citas:crear',
    'citas:cancelar',
    'sesiones:registrar',
    'historia:leer',
    'catalogo:leer',
    'catalogo:editar',
    'precios:editar',
    'promociones:editar',
    'horarios:leer',
    'horarios:definir',
    'cobros:registrar',
    'inventario:editar',
    'informes:leer',
    'margenes:leer',
    'plan:leer',
    'plan:ampliar',
  ],
};

/**
 * La lista resuelta que viaja en el token y en `GET /v1/session`. Nunca el rol: «la app no
 * deduce permisos del rol», y por eso quien resuelve es el servidor.
 */
export function resolvePermissions(
  role: Role,
  explicit: readonly string[] | null,
): readonly string[] {
  if (role === 'patient') return [];
  if (explicit !== null) return explicit;
  return PERMISSIONS_BY_ROLE[role];
}
