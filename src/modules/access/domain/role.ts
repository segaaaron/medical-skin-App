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
 * de las filas de la primera entrega.
 *
 * ESTA ES LA TABLA DE `_convenciones.md` · «Los permisos de cada rol», copiada fila por
 * fila (decisión 22, 27 de octubre de 2026). No se edita aquí: se edita allí y se copia.
 * El criterio que la ordena: recepción **no abre historias y no registra tratamientos**;
 * el asistente clínico sí, porque está en la sala, pero no toca precios ni dinero ni
 * informes; y lo de la consulta como negocio —catálogo, márgenes, equipo, licencia— es de
 * la doctora.
 *
 * Los cuatro de LECTURA —`catalogo:leer`, `horarios:leer`, `plan:leer`, `plan:ampliar`— se
 * añadieron el 29 de octubre de 2026 y son el arreglo de un hallazgo, no una función nueva:
 * leer el catálogo pedía `pacientes:leer`, leer el protocolo pedía `catalogo:editar`, LEER el
 * horario pedía `horarios:definir` y ver el plan pedía `equipo:crear`. Una tabla de permisos
 * cuyo nombre no corresponde con lo que acota deja de significar nada en cuanto la dueña la
 * edite, que es la única razón por la que existe la columna `practitioner.permissions`.
 *
 * `inquilino:licencia:enviar` es «solo la dueña» y por eso NO está aquí: la dueña es la
 * `doctora` cuya cuenta está en `practice.owner_account_id`, que es una fila y no una
 * cadena, así que ese permiso no sale de una tabla por rol. Lo resuelve quien conozca esa
 * fila, y hoy no lo resuelve nadie: `inquilinos.md` es de otro encargo.
 */
export const PERMISSIONS_BY_ROLE: Readonly<Record<PractitionerRole, readonly string[]>> = {
  doctora: [
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
    'equipo:crear',
    'equipo:permisos',
  ],
  asistente_clinico: [
    'pacientes:leer',
    'pacientes:crear',
    'pacientes:acceso:enviar',
    'agenda:leer',
    'citas:crear',
    'citas:cancelar',
    'sesiones:registrar',
    'historia:leer',
    'catalogo:leer',
    'horarios:leer',
    'inventario:editar',
  ],
  recepcion: [
    'pacientes:leer',
    'agenda:leer',
    'citas:crear',
    'citas:cancelar',
    'catalogo:leer',
    'horarios:leer',
    'horarios:definir',
    'cobros:registrar',
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
  if (role === 'paciente') return [];
  if (explicit !== null) return explicit;
  return PERMISSIONS_BY_ROLE[role];
}
