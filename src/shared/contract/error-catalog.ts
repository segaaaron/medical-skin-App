// El catálogo de errores del tramo. Es contrato, no implementación: el `codigo` y el
// `mensaje` son la frase que ve el usuario y las dos apps llevan esta misma tabla indexada
// por `codigo` para hablarle sin red (_convenciones.md · Forma del error).
//
// De ahí dos reglas que no se tocan:
//   1. `codigo` y `mensaje` en ESPAÑOL. Todo identificador de código, en inglés (napkin §4).
//   2. **Ningún error dice «error inesperado».** Si algo no tiene código aquí, es que falta
//      decidirlo con `producto`, no que haya que inventar una frase.
//
// Sin NestJS a propósito: el dominio lanza estos errores y el dominio compila solo.

export type ErrorCode =
  // POST /v1/acceso
  | 'correo_vacio'
  | 'contrasena_vacia'
  | 'acceso_no_coincide'
  | 'contrasena_temporal_caducada'
  | 'acceso_en_pausa'
  | 'cuenta_suspendida'
  // POST /v1/acceso/contrasena-nueva
  | 'contrasena_corta'
  | 'contrasena_muy_usada'
  | 'contrasena_igual_a_la_temporal'
  | 'token_sin_alcance'
  | 'contrasena_ya_elegida'
  | 'plazo_vencido'
  // sesión (sesion.md · «La forma del token»)
  | 'token_caducado'
  | 'token_no_valido'
  | 'sesion_revocada'
  | 'contrasena_temporal_pendiente'
  // sesiones activas
  | 'sesion_no_existe'
  | 'es_esta_sesion'
  // POST /v1/recuperacion
  | 'correo_mal_escrito'
  | 'demasiados_codigos'
  // POST /v1/recuperacion/codigo
  | 'codigo_incompleto'
  | 'codigo_no_es_numero'
  | 'codigo_no_coincide'
  | 'codigo_caducado'
  | 'codigo_anulado'
  | 'demasiados_intentos'
  // PATCH /v1/cuentas/mia/contrasena
  | 'contrasena_igual_a_la_actual'
  | 'contrasena_actual_no_coincide'
  // los seis del transporte (_convenciones.md · «Los errores del transporte»)
  | 'ruta_no_existe'
  | 'cuerpo_no_valido'
  | 'metodo_no_permitido'
  | 'cuerpo_demasiado_grande'
  | 'formato_no_admitido'
  | 'demasiadas_peticiones'
  // transversales
  | 'clave_idempotencia_reutilizada'
  | 'fallo_de_servicio';

type Entry = {
  readonly status: number;
  readonly message: string;
  /** `null` si el error no pertenece a un campo: la app lo pinta como snackbar. */
  readonly field: string | null;
};

export const CATALOG: Readonly<Record<ErrorCode, Entry>> = {
  correo_vacio: { status: 400, message: 'Escribe tu correo.', field: 'correo' },
  contrasena_vacia: { status: 400, message: 'Escribe tu contraseña.', field: 'contrasena' },

  // EL ERROR MÁS IMPORTANTE DEL PRODUCTO. Uno, no tres: correo que no existe, contraseña
  // mal y cuenta borrada responden exactamente esto. `campo` va en `null` y los dos campos
  // que se encienden viajan en `datos.campos` (decisión 19 del 27 de octubre): es el único
  // error del tramo con dos, y no justifica cambiar la forma para los otros cincuenta.
  acceso_no_coincide: { status: 401, message: 'Revisa tu correo y tu contraseña.', field: null },

  contrasena_temporal_caducada: {
    status: 401,
    message: 'Esa contraseña ya caducó. Pídele a tu doctora que te mande una nueva.',
    field: 'contrasena',
  },
  // La frase lleva la hora, no «en 15 minutos»: la pausa puede haber empezado hace rato.
  acceso_en_pausa: {
    status: 429,
    message: 'Demasiados intentos. Puedes volver a entrar a las {hora}.',
    field: null,
  },
  cuenta_suspendida: {
    status: 403,
    message: 'Tu cuenta está suspendida. Escríbenos a hola@medskin.app.',
    field: null,
  },

  contrasena_corta: { status: 400, message: '8 caracteres o más', field: 'nueva' },
  contrasena_muy_usada: {
    status: 400,
    message: 'No es una de las contraseñas más usadas',
    field: 'nueva',
  },
  contrasena_igual_a_la_temporal: {
    status: 400,
    message: 'Esa es la temporal que te mandamos. Elige una tuya.',
    field: 'nueva',
  },
  token_sin_alcance: {
    status: 401,
    message: 'Esta pantalla ya no corresponde. Vuelve a entrar.',
    field: null,
  },
  contrasena_ya_elegida: {
    status: 409,
    message: 'Ya elegiste tu contraseña. Entra con ella.',
    field: null,
  },
  plazo_vencido: {
    status: 410,
    message: 'Se pasó el tiempo. Vuelve a entrar con la contraseña que te mandamos.',
    field: null,
  },

  // Los tres del token: frases distintas porque significan cosas distintas para quien las
  // lee, y `sesion.md` lo exige explícitamente.
  token_caducado: { status: 401, message: 'Tu sesión se cerró. Entra otra vez.', field: null },
  token_no_valido: { status: 401, message: 'Tu sesión se cerró. Entra otra vez.', field: null },
  sesion_revocada: { status: 401, message: 'Cerramos tu sesión en este teléfono.', field: null },
  contrasena_temporal_pendiente: {
    status: 403,
    message: 'Primero elige tu contraseña.',
    field: null,
  },

  sesion_no_existe: { status: 404, message: 'Esa sesión ya no está abierta.', field: null },
  es_esta_sesion: {
    status: 400,
    message: 'Esa es esta sesión. Usa «Cerrar sesión».',
    field: 'sesion_id',
  },

  // ---------------------------------------------------------------------------------
  // Recuperación · `recuperacion.md`. El `401 codigo_no_coincide` es uno para tres
  // situaciones —código mal, correo sin cuenta, cuenta sin código vivo— por la misma
  // razón que `acceso_no_coincide`: un correo sin cuenta responde exactamente lo mismo.
  // ---------------------------------------------------------------------------------
  correo_mal_escrito: {
    status: 400,
    message: 'Ese correo no parece un correo. Revísalo.',
    field: 'correo',
  },
  demasiados_codigos: {
    status: 429,
    message: 'Pediste varios códigos. Espera unos minutos antes de pedir otro.',
    field: null,
  },
  codigo_incompleto: { status: 400, message: 'Escribe los seis dígitos.', field: 'codigo' },
  codigo_no_es_numero: { status: 400, message: 'El código son seis números.', field: 'codigo' },
  // La frase lleva el número de intentos y la pone quien lanza, con `datos.intentos_restantes`.
  codigo_no_coincide: {
    status: 401,
    message: 'Ese código no es. Te quedan {intentos} intentos.',
    field: 'codigo',
  },
  codigo_caducado: { status: 410, message: 'Ese código ya caducó. Pide otro.', field: null },
  // Dos frases distintas a propósito: «se anuló» tiene que decir además que la cuenta
  // sigue bien, porque es justo lo que la paciente va a temer (`Arranque.dc.html` · 8).
  codigo_anulado: {
    status: 410,
    message: 'Ese código se anuló por tantos intentos. Pide uno nuevo: tu cuenta sigue bien.',
    field: null,
  },
  demasiados_intentos: {
    status: 429,
    message: 'Demasiados intentos. Espera unos minutos.',
    field: null,
  },

  // ---------------------------------------------------------------------------------
  // PATCH /v1/cuentas/mia/contrasena · «Aquí sí se nombra el campo que falló, al
  // contrario que en `POST /v1/acceso`: quien llama ya está dentro» (`cuentas.md`).
  // ---------------------------------------------------------------------------------
  contrasena_igual_a_la_actual: {
    status: 400,
    message: 'Esa ya es tu contraseña. Elige otra.',
    field: 'nueva',
  },
  contrasena_actual_no_coincide: {
    status: 401,
    message: 'Esa no es tu contraseña actual.',
    field: 'actual',
  },

  // ---------------------------------------------------------------------------------
  // Los seis del transporte (_convenciones.md · «Los errores del transporte», 27 de
  // octubre). No son de ningún endpoint: los devuelve el borde antes de llegar a uno.
  // Tres no le dicen nada al usuario porque son errores de programación del cliente,
  // pero TIENEN código, y por eso la app puede registrarlos y nosotros verlos.
  // ---------------------------------------------------------------------------------
  ruta_no_existe: { status: 404, message: '', field: null },
  cuerpo_no_valido: {
    status: 400,
    message: 'Algo de lo que mandaste no está bien. Revísalo y vuelve a intentar.',
    field: null,
  },
  metodo_no_permitido: { status: 405, message: '', field: null },
  cuerpo_demasiado_grande: {
    status: 413,
    message: 'Eso es demasiado grande para mandarlo así. Las fotos se suben por su propia pantalla.',
    field: null,
  },
  formato_no_admitido: { status: 415, message: '', field: null },
  demasiadas_peticiones: {
    status: 429,
    message: 'Vas muy rápido. Espera unos segundos.',
    field: null,
  },

  clave_idempotencia_reutilizada: {
    status: 409,
    message: 'Esa clave ya se usó con otra petición. Usa una nueva.',
    field: null,
  },

  // La frase completa la pone quien lanza: es obligatoria y cambia por endpoint
  // (_convenciones.md · «El 500, en todas partes»). Esta es la parte que no cambia.
  fallo_de_servicio: { status: 500, message: 'El servidor no respondió.', field: null },
};

/** El cuerpo exacto de _convenciones.md. Nada más y nada menos. */
export type ErrorBody = {
  error: {
    codigo: ErrorCode;
    mensaje: string;
    campo: string | null;
    datos?: Record<string, unknown>;
  };
};

/**
 * El error del contrato. Lo lanza el dominio, lo traduce el filtro.
 *
 * `datos` es «solo lo que la frase necesita para interpolar» y NUNCA nada clínico.
 */
export class ContractError extends Error {
  readonly status: number;
  readonly field: string | null;
  readonly userMessage: string;

  constructor(
    readonly code: ErrorCode,
    readonly data?: Record<string, unknown>,
    /** Sustituye el `mensaje` del catálogo. Lo usan el 500 y las frases con hora. */
    message?: string,
  ) {
    const entry = CATALOG[code];
    super(code);
    this.name = 'ContractError';
    this.status = entry.status;
    this.field = entry.field;
    this.userMessage = message ?? entry.message;
  }

  body(): ErrorBody {
    return {
      error: {
        codigo: this.code,
        mensaje: this.userMessage,
        campo: this.field,
        ...(this.data ? { datos: this.data } : {}),
      },
    };
  }
}

/**
 * El 500 con la frase COMPLETA que cada endpoint tiene escrita en su contrato: «No pudimos
 * <lo que intentaba>. El servidor no respondió. <qué quedó a salvo>: puedes volver a
 * intentarlo.» La segunda parte es obligatoria y cambia por endpoint, así que se pasa
 * literal y no se compone aquí.
 *
 * La causa real del motor viaja aparte, hacia `service_failure`, y NUNCA hacia el cliente
 * (OWASP A05: ni un stack trace sale de aquí).
 */
export class ServiceFailure extends ContractError {
  constructor(
    phrase: string,
    override readonly cause?: unknown,
  ) {
    super('fallo_de_servicio', undefined, phrase);
    this.name = 'ServiceFailure';
  }
}

/**
 * Las frases del 500 de `acceso.md`, una por endpoint y copiadas literales de la tabla de
 * errores de cada uno. Viven juntas porque son contrato y porque un 500 sin su segunda
 * frase es un error que no dice dónde quedaron las cosas de quien lo lee.
 */
export const FAILURE_PHRASES = {
  signIn:
    'No pudimos entrar. El servidor no respondió. Tu contraseña no cambió: puedes volver a intentarlo.',
  savePassword:
    'No pudimos guardar tu contraseña. El servidor no respondió. Escríbela otra vez: todavía puedes entrar con la temporal.',
  signOut: 'Cerramos tu sesión en este teléfono. En los otros puede seguir abierta.',
  listSessions:
    'No pudimos cargar tus sesiones. El servidor no respondió: puedes volver a intentarlo.',
  closeSession:
    'No pudimos cerrar esa sesión. El servidor no respondió: puedes volver a intentarlo.',

  // `recuperacion.md`. La primera NO sigue el patrón de tres frases y es a propósito: su
  // contrato escribe el snackbar literal, «No se pudo enviar el código.» con «Reintentar».
  requestRecoveryCode: 'No se pudo enviar el código.',
  checkRecoveryCode:
    'No pudimos comprobar el código. El servidor no respondió. El código sigue valiendo: puedes volver a intentarlo.',

  // `cuentas.md` · PATCH /v1/cuentas/mia/contrasena.
  changePassword:
    'No pudimos guardar tu contraseña. El servidor no respondió. La de ahora sigue valiendo: puedes volver a intentarlo.',

  /**
   * La frase del 500 cuando el fallo ocurre ANTES de saber a qué ruta iba
   * (_convenciones.md · «El 500, en todas partes», decisión 24 del 27 de octubre).
   */
  fallback:
    'No pudimos completar lo que pediste. El servidor no respondió: puedes volver a intentarlo.',
} as const;

/**
 * El código del transporte que le toca a cada estado de HTTP. Es la tabla de
 * _convenciones.md · «Los errores del transporte» leída al revés: el borde solo sabe el
 * número, y el catálogo pone el código y la frase.
 */
export const TRANSPORT_CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: 'cuerpo_no_valido',
  404: 'ruta_no_existe',
  405: 'metodo_no_permitido',
  413: 'cuerpo_demasiado_grande',
  415: 'formato_no_admitido',
  429: 'demasiadas_peticiones',
};
