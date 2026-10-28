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
  if (accountRole === 'paciente') return 'paciente';
  return practitionerRole;
}

/**
 * Los permisos por rol, para cuando `practitioner.permissions` es nulo — que es el 100 %
 * de las filas de la primera entrega (decisión 11 de `preguntas-abiertas.md`).
 *
 * ATENCIÓN: de esta tabla los contratos solo escriben DOS cosas:
 *   · la lista exacta de `doctora`, que es el ejemplo de `GET /v1/sesion` (`sesion.md`);
 *   · que `pacientes:crear` es «doctora y asistente clínico · Recepción **no**»
 *     (`cuentas.md` · `POST /v1/pacientes`).
 * El resto de las dos listas no está fijado en ningún contrato. Queda anotado para
 * `producto`: una lista de permisos que el servidor inventa es una autorización que nadie
 * revisó (OWASP A01).
 */
export const PERMISSIONS_BY_ROLE: Readonly<Record<PractitionerRole, readonly string[]>> = {
  doctora: ['pacientes:crear', 'pacientes:leer', 'sesiones:registrar', 'catalogo:editar'],
  asistente_clinico: ['pacientes:crear', 'pacientes:leer', 'sesiones:registrar'],
  recepcion: ['pacientes:leer'],
};

/**
 * La lista resuelta que viaja en el token y en `GET /v1/sesion`. Nunca el rol: «la app no
 * deduce permisos del rol», y por eso quien resuelve es el servidor.
 */
export function resolvePermissions(
  role: Role,
  explicit: readonly string[] | null,
): readonly string[] {
  if (role === 'paciente') return [];
  if (explicit !== null) return explicit;
  return PERMISSIONS_BY_ROLE[role];
}
