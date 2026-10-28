// El vocabulario del acceso y de la sesión. Tres listas de valores que NO son la misma
// (_convenciones.md · «Los valores de `rol`»), y por eso se escriben las tres.
//
// Los VALORES siguen en español donde el contrato los fija (`doctora`, `paciente`,
// `contrasena_temporal`): son formato de API, que es lo que las dos apps ya consumen. Los
// identificadores, en inglés (napkin §4).

/** `account.role` en la base. Es el rol de AUTENTICACIÓN y nada más. */
export type AccountRole = 'practitioner' | 'paciente';

/** `practitioner.role` en la base: quién es dentro de la consulta. */
export type PractitionerRole = 'doctora' | 'recepcion' | 'asistente_clinico';

/**
 * El `rol` que viaja al cliente. `practitioner` NO se devuelve nunca: es valor de base y
 * no dice nada que una app pueda usar. `duena` tampoco es un valor: la dueña es la
 * `doctora` cuya cuenta está en `practice.owner_account_id`, que es una fila.
 */
export type Role = PractitionerRole | 'paciente';

/** `sesion.md` · «La forma del token». `suplantacion` queda fuera del tramo. */
export type Scope = 'contrasena_temporal' | 'recuperacion' | 'segundo_factor' | 'completo';

/** `acceso.md` · «`siguiente_paso`, la lista completa». El servidor manda el paso. */
export type NextStep =
  | 'contrasena_nueva'
  | 'segundo_factor'
  | 'vincular'
  | 'ficha_medica'
  | 'licencia'
  | 'primer_dia'
  | 'inicio';

export type Region = 'eu' | 'us' | 'latam';

/**
 * Las reclamaciones del JWT, `sesion.md` · «La forma del token»: `sub` (cuenta), `sid`
 * (sesión), `rol`, `alcance`, `region`, `practice` (solo doctora y equipo), `permisos`,
 * más `exp` e `iat`, que los pone el firmador. Los NOMBRES de las reclamaciones son
 * contrato, igual que los campos JSON, y por eso van en español.
 */
export type Claims = {
  sub: string;
  sid: string;
  rol: Role;
  alcance: Scope;
  region: Region;
  /** Solo doctora y equipo. Una paciente no es de ningún inquilino. */
  practice?: string;
  permisos: readonly string[];
};
