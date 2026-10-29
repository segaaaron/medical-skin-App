// `POST /v1/team` · el rol que la dueña SÍ puede dar. Dominio: sin NestJS y sin `pg`.
//
// El rol viaja en el cuerpo y es la única excepción del tramo, «porque no es el rol de
// autenticación sino el permiso dentro de un inquilino que ya está resuelto»: `account.role`
// sigue siendo `practitioner` y lo pone el servidor (`cuentas.md`).
//
// Son DOS valores y no los tres del `CHECK` de `practitioner`: `doctora` no se asigna desde
// aquí. Y `duena` no es un rol ninguno —la dueña es `practice.owner_account_id`, que es una
// fila—, así que un cuerpo con `rol: "duena"` o `rol: "paciente"` cae en el mismo
// `400 rol_no_asignable`. La base lo comprueba otra vez y antes de mirar el correo: así un
// cuerpo mal formado no revela nada del padrón.

export const ASSIGNABLE_TEAM_ROLES = ['recepcion', 'asistente_clinico'] as const;
export type AssignableTeamRole = (typeof ASSIGNABLE_TEAM_ROLES)[number];

export function isAssignableTeamRole(value: unknown): value is AssignableTeamRole {
  return (
    typeof value === 'string' && (ASSIGNABLE_TEAM_ROLES as readonly string[]).includes(value)
  );
}

/** El permiso de este endpoint. `cuentas.md`: «doctora dueña · permiso `equipo:crear`». */
export const TEAM_PERMISSION = 'equipo:crear';
