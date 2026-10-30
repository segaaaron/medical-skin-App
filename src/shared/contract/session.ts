// El vocabulario del acceso y de la sesión. Tres listas de valores que NO son la misma
// (_convenciones.md · «Los valores de `rol`»), y por eso se escriben las tres.
//
// Los VALORES siguen en español donde el contrato los fija (`doctora`, `paciente`,
// `contrasena_temporal`): son formato de API, que es lo que las dos apps ya consumen. Los
// identificadores, en inglés (napkin §4).

/**
 * `account.role` en la base. Es el rol de AUTENTICACIÓN y nada más: por qué puerta entra
 * quien llama. Dos valores y no más, decidido por el dueño el 30 de octubre de 2026.
 */
export type AccountRole = 'doctor' | 'patient';

/**
 * `practitioner.role` en la base: quién es dentro de la consulta.
 *
 * UN SOLO VALOR desde el 30 de octubre de 2026. Antes había tres —`doctora`, `recepcion`,
 * `asistente_clinico`— que salieron de un paréntesis del documento de diseño («practitioner
 * N (doctor, asistente, recepción, solo-lectura)») y que el dueño nunca pidió: el producto
 * es un doctor y sus pacientes. El equipo con roles está en la FASE 3 del propio diseño, y
 * se había adelantado dos fases. Lo que ayudaría al doctor dentro de su app es el asistente
 * virtual, que es un ALCANCE del token y no un rol (`Scope`).
 */
export type PractitionerRole = 'doctor';

/**
 * El `rol` que viaja al cliente: `doctor` o `patient`, y nada más. `duena` no es un valor:
 * la dueña es el `doctor` cuya cuenta está en `practice.owner_account_id`, que es una fila
 * y no una cadena.
 */
export type Role = PractitionerRole | 'patient';

/** `sesion.md` · «La forma del token». `suplantacion` queda fuera del tramo. */
export type Scope =
  | 'contrasena_temporal'
  | 'recuperacion'
  | 'segundo_factor'
  /**
   * EL ASISTENTE VIRTUAL · la IA que ayuda al doctor DENTRO de su propia app.
   *
   * Es un alcance y no un rol, y esa es la decisión: el `rol` enciende pantallas en la app,
   * así que un valor nuevo ahí obligaría a cambiarla. Un alcance no: la app sigue recibiendo
   * `rol: "doctor"` y no se entera. Lo que cambia es qué puertas abre ese token, y eso lo
   * decide el guardia por lista blanca de rutas, que es la capa fuerte.
   *
   * No tiene cuenta, ni credencial, ni fila: vive dentro de la sesión del doctor, con el
   * mismo `sub`, el mismo `sid` y la misma consulta. Firmar la nota clínica NO está en su
   * lista: el historial lo crea el doctor, y `session_note.signed_by_practitioner_id` tiene
   * que seguir siendo verdad.
   */
  | 'virtual_assistant'
  | 'completo';

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
  /** Solo doctora y equipo. Una paciente no es de ninguna consulta. */
  practice?: string;
  permisos: readonly string[];
};

/**
 * El token de `recuperacion.md` · `POST /v1/recovery/code`, y es OTRA forma: **no
 * lleva `rol`, no lleva `sid` y no lleva `practice`.**
 *
 * No es una omisión por pereza. El cuerpo de un JWT lo lee el cliente, así que una
 * reclamación `rol` aquí diría «esta cuenta es de doctora» a quien acertó un código de
 * seis dígitos, y el contrato lo prohíbe con nombre y apellido: «El código va **antes** de
 * saber el rol. Si esta respuesta trajera el rol, el flujo de recuperación sería el
 * oráculo que el flujo de acceso cierra — y encima un oráculo mejor, porque diría *qué* es
 * la persona, no solo que existe». `practice` lo diría igual de claro.
 *
 * Y sin `sid` porque no hay sesión todavía: la sesión se abre al guardar la contraseña, en
 * la misma transacción. Un `sid` inventado aquí sería un identificador que no apunta a
 * ninguna fila.
 */
export type RecoveryClaims = {
  sub: string;
  alcance: 'recuperacion';
  region: Region;
};
