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
  // POST /v1/access
  | 'correo_vacio'
  | 'contrasena_vacia'
  | 'acceso_no_coincide'
  | 'contrasena_temporal_caducada'
  | 'acceso_en_pausa'
  | 'cuenta_suspendida'
  // POST /v1/access/new-password
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
  // POST /v1/session/refresh
  | 'refresco_vacio'
  | 'refresco_no_valido'
  | 'refresco_caducado'
  | 'refresco_reutilizado'
  | 'demasiados_refrescos'
  // sesiones activas
  | 'sesion_no_existe'
  | 'es_esta_sesion'
  // POST /v1/recovery
  | 'correo_mal_escrito'
  | 'demasiados_codigos'
  // POST /v1/recovery/code
  | 'codigo_incompleto'
  | 'codigo_no_es_numero'
  | 'codigo_no_coincide'
  | 'codigo_caducado'
  | 'codigo_anulado'
  | 'demasiados_intentos'
  // PATCH /v1/accounts/mine/password
  | 'contrasena_igual_a_la_actual'
  | 'contrasena_actual_no_coincide'
  // `negocio.md` · cobros, margenes, inventario e informes
  | 'importe_no_valido'
  | 'medio_desconocido'
  | 'credito_insuficiente'
  | 'ya_cobrado'
  | 'stock_negativo'
  | 'merma_sin_motivo'
  | 'movimiento_de_sesion'
  | 'cobro_no_existe'
  | 'exportacion_reciente'
  | 'exportacion_vencida'
  // `cuidados.md` · cuidados, mensajes y avisos
  | 'paso_futuro'
  | 'paso_no_existe'
  | 'mensaje_vacio'
  | 'mensaje_demasiado_largo'
  | 'demasiados_mensajes'
  | 'vinculo_revocado'
  // `imagenes.md` · las fotos
  | 'tipo_no_admitido'
  | 'demasiado_grande'
  | 'vista_desconocida'
  | 'sin_consentimiento_de_imagenes'
  | 'cuota_de_la_consulta'
  | 'no_se_subio'
  | 'no_es_una_imagen'
  | 'dimensiones_fuera_de_rango'
  | 'ya_confirmada'
  | 'foto_no_existe'
  | 'foto_no_lista'
  | 'vistas_distintas'
  | 'maestra_en_almacenamiento_frio'
  | 'foto_de_la_doctora'
  | 'en_una_sesion_firmada'
  // `sesiones.md` · sesiones clinicas, lotes y consentimientos
  | 'unidades_no_cuadran'
  | 'sin_aplicaciones'
  | 'punto_fuera_de_rango'
  | 'lote_no_existe'
  | 'cita_sin_atender'
  | 'cita_ya_tiene_sesion'
  | 'lote_vencido'
  | 'stock_insuficiente'
  | 'sesion_clinica_no_existe'
  | 'nota_ya_firmada'
  | 'sesion_anulada'
  | 'nota_vacia'
  | 'consentimiento_pendiente'
  | 'conflictos_sin_resolver'
  | 'solo_la_doctora_firma'
  | 'nota_sin_firmar'
  | 'nota_firmada'
  | 'texto_vacio'
  | 'motivo_desconocido'
  | 'motivo_muy_corto'
  | 'respuestas_incorrectas'
  | 'version_desactualizada'
  | 'respuestas_incompletas'
  | 'ya_firmado'
  | 'codigo_de_lote_repetido'
  | 'vencimiento_en_el_pasado'
  // `agenda.md` · la agenda
  | 'franja_al_reves'
  | 'franjas_que_se_cruzan'
  | 'dia_desconocido'
  | 'paso_no_valido'
  | 'zona_horaria_desconocida'
  | 'feriado_con_citas'
  | 'rango_demasiado_grande'
  | 'tratamiento_no_disponible'
  | 'hueco_ocupado'
  | 'fuera_de_horario'
  | 'antes_del_aviso_minimo'
  | 'fuera_de_plazo'
  | 'promocion_no_aplica'
  | 'ya_tiene_cita'
  | 'cita_no_existe'
  | 'cita_ya_atendida'
  | 'cita_cancelada'
  | 'reagendar_tarde'
  | 'sena_no_requerida'
  | 'sena_ya_confirmada'
  | 'sena_vencida'
  | 'demasiadas_esperas'
  // `tratamientos.md` · el catalogo de la consulta
  | 'categoria_desconocida'
  | 'duracion_fuera_de_rango'
  | 'precio_no_valido'
  | 'intervalo_necesario'
  | 'producto_no_existe'
  | 'nombre_repetido'
  | 'tratamiento_no_existe'
  | 'desfase_sin_sentido'
  | 'paso_sin_texto'
  | 'demasiados_pasos'
  | 'semaforo_dia_repetido'
  | 'clave_desconocida'
  | 'valor_necesario'
  | 'falta_precio_base'
  | 'zona_desconocida'
  | 'vigencia_al_reves'
  | 'vigencia_en_el_pasado'
  | 'descuento_fuera_de_rango'
  | 'segmento_desconocido'
  | 'codigo_repetido'
  | 'promocion_no_existe'
  // GET /v1/patients · `pacientes.md`
  | 'busqueda_muy_corta'
  | 'nada_que_cambiar'
  | 'paciente_archivada'
  | 'cita_futura'
  // GET /v1/links y sus dos POST
  | 'vinculo_no_existe'
  | 'vinculo_ya_resuelto'
  | 'vinculo_sin_aceptar'
  | 'estado_no_valido'
  | 'vinculo_no_valido'
  // POST /v1/accounts/{account_id}/access
  | 'paciente_no_existe'
  | 'celular_necesario_para_whatsapp'
  | 'ya_eligio_su_contrasena'
  | 'demasiados_reenvios'
  | 'via_no_valida'
  | 'sin_permiso'
  // POST /v1/team
  | 'nombre_vacio'
  | 'rol_no_asignable'
  | 'correo_no_disponible'
  // POST /v1/team/{member_id}/access
  | 'miembro_no_existe'
  // Las dos de consola de `cuentas.md`
  | 'cuenta_no_existe'
  // POST /v1/patients · `cuentas.md` (cuenta y acceso) + `pacientes.md` (el paso 3)
  | 'nacimiento_no_valido'
  | 'nacimiento_futuro'
  | 'menor_de_edad'
  | 'celular_mal_escrito'
  | 'referida_sin_quien'
  | 'referida_no_existe'
  | 'correo_duplicado_en_la_consulta'
  | 'licencia_sin_verificar'
  | 'limite_del_plan'
  | 'demasiadas_altas'
  | 'alergias_sin_cuales'
  | 'medicacion_sin_cuales'
  | 'fototipo_fuera_de_escala'
  | 'embarazo_valor_desconocido'
  // DELETE /v1/accounts/mine
  | 'consulta_con_equipo'
  | 'consulta_con_pacientes'
  | 'suscripcion_activa'
  // GET /v1/tenants/mine · `inquilinos.md`
  | 'rol_no_corresponde'
  // POST /v1/tenants/mine/license · `inquilinos.md`
  | 'matricula_vacia'
  | 'pais_sin_cobertura'
  | 'especialidad_desconocida'
  | 'declaracion_sin_aceptar'
  | 'terminos_sin_aceptar'
  | 'credencial_sin_subir'
  | 'credencial_no_valida'
  | 'licencia_en_revision'
  | 'licencia_ya_verificada'
  | 'demasiados_envios'
  // los seis del transporte (_convenciones.md · «Los errores del transporte»)
  | 'ruta_no_existe'
  | 'cuerpo_no_valido'
  | 'cuerpo_demasiado_grande'
  | 'formato_no_admitido'
  | 'demasiadas_peticiones'
  // transversales
  | 'clave_idempotencia_faltante'
  | 'clave_idempotencia_reutilizada'
  // los tres de la consola interna (`plataforma-acceso.md` · Errores). `sin_permiso` ya está
  // arriba y es el mismo código con otra frase, como en el reenvío de la doctora.
  | 'token_de_plataforma_no_valido'
  | 'token_de_plataforma_caducado'
  | 'region_no_corresponde'
  // Los tres endpoints de consola de `inquilinos.md`
  | 'region_desconocida'
  | 'plan_desconocido'
  | 'correo_ya_tiene_cuenta'
  | 'inquilino_no_existe'
  | 'licencia_no_existe'
  | 'licencia_ya_decidida'
  | 'licencia_sin_enviar'
  | 'motivo_rechazo_vacio'
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

  // ---------------------------------------------------------------------------------
  // POST /v1/session/refresh · los cinco de `sesion.md`.
  //
  // TRES VAN CON `mensaje` VACÍO Y ES CORRECTO (decisión del 28 de octubre): la app los
  // resuelve **sin texto** —va a «Entra a MedSkin», o espera y reintenta con retroceso—,
  // igual que `ruta_no_existe` y `formato_no_admitido`. Lo que la regla exige es que
  // tengan código estable, no que tengan frase; lo que no puede pasar es que no tengan
  // código.
  //
  // Los otros dos sí llevan la suya, y son distintas a propósito: «pasó tiempo sin usar
  // MedSkin» es información, «cerramos tu sesión por seguridad» es una advertencia que
  // puede hacerla cambiar la contraseña. Juntarlas quitaría la única señal que tiene de
  // que algo pasó.
  // ---------------------------------------------------------------------------------
  refresco_vacio: { status: 400, message: '', field: 'refresco' },
  refresco_no_valido: { status: 401, message: '', field: null },
  refresco_caducado: {
    status: 401,
    message: 'Pasó tiempo sin usar MedSkin. Entra otra vez.',
    field: null,
  },
  refresco_reutilizado: {
    status: 401,
    message: 'Cerramos tu sesión por seguridad. Entra otra vez.',
    field: null,
  },
  demasiados_refrescos: { status: 429, message: '', field: null },

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
  // PATCH /v1/accounts/mine/password · «Aquí sí se nombra el campo que falló, al
  // contrario que en `POST /v1/access`: quien llama ya está dentro» (`cuentas.md`).
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
  // ---------------------------------------------------------------------------------
  // POST /v1/accounts/{account_id}/access · `cuentas.md`.
  // ---------------------------------------------------------------------------------
  // «Un `cuenta_id` de otra consulta no devuelve fila y el endpoint responde
  // -------------------------------------------------------------------------------------
  // `GET /v1/patients` · la lista y la busqueda
  //
  // `busqueda_muy_corta` va con `mensaje` VACIO, como `clave_idempotencia_faltante`: «la app
  // no manda la peticion hasta el segundo caracter» (`pacientes.md`), asi que no hay nada que
  // contarle a una persona. Lo que no puede faltar es el codigo, para que la app lo registre.
  //
  // Los otros dos no estan en la tabla del contrato y existen igual: un `?estado=cualquiera`
  // NO puede caer en `activa` en silencio, porque entonces la app creeria que esta filtrando
  // algo que no filtra y ensenaria archivadas donde promete activas. Anotado para `producto`:
  // faltan en la tabla de errores de ese endpoint.
  // -------------------------------------------------------------------------------------
  // -------------------------------------------------------------------------------------
  // `negocio.md`. MedSkin registra cobros; no cobra. Ningun codigo de aqui habla de pasarela.
  // -------------------------------------------------------------------------------------
  importe_no_valido: {
    status: 400,
    message: 'El importe tiene que ser un número entero mayor que cero.',
    field: 'importe',
  },
  medio_desconocido: {
    status: 400,
    message: 'Elige un medio de pago de la lista.',
    field: 'medio',
  },
  // La frase lleva el importe y la fecha dentro, asi que la pone quien los tiene.
  credito_insuficiente: {
    status: 409,
    message: 'Su crédito no alcanza o ya venció.',
    field: null,
  },
  ya_cobrado: { status: 409, message: 'Esa sesión ya está cobrada.', field: null },
  stock_negativo: {
    status: 409,
    message: 'Ese lote no tiene tantas unidades. No puedes descontar más de lo que hay.',
    field: 'unidades',
  },
  merma_sin_motivo: {
    status: 400,
    message: 'Dinos por qué se perdió: va al inventario.',
    field: 'motivo',
  },
  movimiento_de_sesion: {
    status: 409,
    message: 'Esa salida la registra la sesión. Corrígela desde la sesión.',
    field: 'tipo',
  },
  cobro_no_existe: { status: 404, message: 'Ese cobro ya no está.', field: null },
  exportacion_reciente: {
    status: 429,
    message: 'Ya pediste una copia hoy. Te llega por correo.',
    field: null,
  },
  exportacion_vencida: {
    status: 410,
    message: 'Ese enlace ya venció. Pide otra copia.',
    field: null,
  },

  // -------------------------------------------------------------------------------------
  // `cuidados.md`.
  // -------------------------------------------------------------------------------------
  paso_futuro: { status: 409, message: 'Ese cuidado todavía no toca.', field: null },
  paso_no_existe: { status: 404, message: 'Ese cuidado ya no está.', field: null },
  mensaje_vacio: { status: 400, message: 'Escribe algo.', field: 'texto' },
  mensaje_demasiado_largo: {
    status: 400,
    message: 'Es muy largo. Mándalo en dos.',
    field: 'texto',
  },
  demasiados_mensajes: {
    status: 429,
    message: 'Mandaste muchos mensajes seguidos. Espera un rato.',
    field: null,
  },
  vinculo_revocado: { status: 409, message: 'Ese chat está cerrado.', field: null },

  // -------------------------------------------------------------------------------------
  // `imagenes.md`. Lo que estos codigos protegen es la cara de una persona.
  // -------------------------------------------------------------------------------------
  tipo_no_admitido: {
    status: 400,
    message: 'Ese archivo no es una foto que podamos guardar.',
    field: 'tipo_declarado',
  },
  demasiado_grande: {
    status: 400,
    message: 'Esa foto es muy grande. La app la reduce antes de subirla.',
    field: 'bytes_declarados',
  },
  vista_desconocida: { status: 400, message: 'Elige una de las vistas.', field: 'vista' },
  // BLOQUEA LA FIRMA, NO LA CAPTURA: la app ya tiene la foto cifrada en el telefono y lo que se
  // frena es que salga de ahi. Es la unica forma de que el consentimiento signifique algo.
  sin_consentimiento_de_imagenes: {
    status: 409,
    message: 'Falta su consentimiento para fotos. Fírmalo con ella antes de tomarlas.',
    field: null,
  },
  cuota_de_la_consulta: {
    status: 409,
    message: 'Llegaste al límite de almacenamiento de tu plan. Amplíalo para seguir subiendo fotos.',
    field: null,
  },
  no_se_subio: { status: 409, message: 'Esa foto no llegó. Vuelve a intentarlo.', field: null },
  // Se decide por los BYTES MAGICOS, nunca por la extension ni por el `Content-Type`. Y el
  // rechazo se registra como fallo: el objeto se borra y queda la fila del intento.
  no_es_una_imagen: {
    status: 422,
    message: 'Ese archivo no es una foto. No lo guardamos.',
    field: null,
  },
  dimensiones_fuera_de_rango: {
    status: 422,
    message: 'Esa foto no nos sirve: es demasiado pequeña o demasiado grande.',
    field: null,
  },
  // Mensaje vacio: «nada, la app sigue».
  ya_confirmada: { status: 409, message: '', field: null },
  foto_no_existe: { status: 404, message: 'Esa foto ya no está.', field: null },
  foto_no_lista: { status: 409, message: 'Esa foto todavía se está procesando.', field: null },
  vistas_distintas: {
    status: 409,
    message: 'Solo se pueden comparar fotos de la misma vista.',
    field: null,
  },
  maestra_en_almacenamiento_frio: {
    status: 409,
    message: 'Esa foto está en almacenamiento de largo plazo. Tardará unos segundos.',
    field: null,
  },
  foto_de_la_doctora: {
    status: 409,
    message: 'Esa foto la tomó tu doctora en consulta: es parte de tu historia clínica.',
    field: null,
  },
  en_una_sesion_firmada: {
    status: 409,
    message: 'Esa foto es parte de una sesión ya firmada. Para quitarla, agrega una corrección.',
    field: null,
  },

  // -------------------------------------------------------------------------------------
  // `sesiones.md`. Lo que este bloque protege es un EXPEDIENTE: casi todos sus 409 bloquean en
  // vez de avisar, y eso es deliberado.
  // -------------------------------------------------------------------------------------
  // La frase lleva los dos números dentro, así que la pone quien los tiene.
  unidades_no_cuadran: {
    status: 400,
    message: 'Los puntos no suman lo que registraste. Revisa antes de guardar.',
    field: 'aplicaciones',
  },
  sin_aplicaciones: {
    status: 400,
    message: 'Registra al menos qué se aplicó.',
    field: 'aplicaciones',
  },
  punto_fuera_de_rango: {
    status: 400,
    message: 'Ese punto cae fuera de la imagen.',
    field: 'puntos',
  },
  lote_no_existe: { status: 404, message: 'Ese lote no está en tu inventario.', field: null },
  cita_sin_atender: { status: 409, message: 'Marca primero que llegó.', field: null },
  cita_ya_tiene_sesion: {
    status: 409,
    message: 'Esa cita ya tiene su sesión registrada.',
    field: null,
  },
  // BLOQUEA y no avisa, al contrario que casi todo lo demás: «registrar un producto vencido en
  // un expediente es documentar una mala práctica».
  lote_vencido: { status: 409, message: 'Ese lote está vencido. Elige otro.', field: null },
  stock_insuficiente: {
    status: 409,
    message: 'Ese lote no tiene tantas unidades. Revisa el lote o el inventario.',
    field: null,
  },
  // `sesion_no_existe` ya era la del DISPOSITIVO (tramo 1, «esa sesión ya no está abierta»).
  // Son dos cosas distintas y el codigo es contrato: la clinica lleva el suyo.
  sesion_clinica_no_existe: { status: 404, message: 'Esa sesión no está.', field: null },
  nota_ya_firmada: {
    status: 409,
    message: 'Esa nota ya está firmada. Para corregirla, agrega una corrección.',
    field: null,
  },
  sesion_anulada: { status: 409, message: 'Esa sesión está anulada.', field: null },
  nota_vacia: { status: 409, message: 'Escribe la nota antes de firmarla.', field: null },
  consentimiento_pendiente: {
    status: 409,
    message: 'Falta su consentimiento. Fírmalo con ella antes de cerrar la sesión.',
    field: null,
  },
  conflictos_sin_resolver: {
    status: 409,
    message: 'Resuelve los dos textos antes de firmar.',
    field: null,
  },
  solo_la_doctora_firma: {
    status: 403,
    message: 'La nota la firma la doctora.',
    field: null,
  },
  nota_sin_firmar: {
    status: 409,
    message: 'Esa nota aún no está firmada: edítala.',
    field: null,
  },
  nota_firmada: {
    status: 409,
    message: 'Esa sesión ya está firmada. Agrega una corrección en vez de anularla.',
    field: null,
  },
  texto_vacio: { status: 400, message: 'Escribe la corrección.', field: 'texto' },
  motivo_desconocido: { status: 400, message: 'Elige un motivo de la lista.', field: 'motivo' },
  motivo_muy_corto: {
    status: 400,
    message: 'Explica por qué se anula: va al expediente.',
    field: 'motivo',
  },
  // NO ES UN MURO: la app vuelve al párrafo de la pregunta fallada, no al principio. «El
  // objetivo no es aprobar un examen: es que entienda.»
  respuestas_incorrectas: {
    status: 409,
    message: 'Vamos a repasar esto juntas.',
    field: null,
  },
  version_desactualizada: {
    status: 409,
    message: 'El texto cambió. Vuelve a leerlo antes de firmar.',
    field: 'version',
  },
  respuestas_incompletas: { status: 400, message: 'Contesta las tres.', field: 'respuestas' },
  // Mensaje vacio: «nada, la app sigue».
  ya_firmado: { status: 409, message: '', field: null },
  codigo_de_lote_repetido: {
    status: 409,
    message: 'Ya tienes un lote con ese código.',
    field: 'codigo',
  },
  vencimiento_en_el_pasado: {
    status: 400,
    message: 'Ese lote ya está vencido. Si es correcto, no lo cargues.',
    field: 'vence_en',
  },

  // -------------------------------------------------------------------------------------
  // `agenda.md`. Las frases son las del contrato, literales.
  //
  // `hueco_ocupado` ES EL ERROR MAS IMPORTANTE DEL TRAMO, y su valor esta en `datos`: sin los
  // tres huecos cercanos la paciente vuelve al paso 1 y la mitad abandona ahi. Con ellos, la
  // hoja se redibuja y confirma en un toque.
  // -------------------------------------------------------------------------------------
  hueco_ocupado: { status: 409, message: 'Ese horario se acaba de ocupar.', field: null },
  fuera_de_horario: { status: 409, message: 'Ese horario ya no está disponible.', field: null },
  antes_del_aviso_minimo: {
    status: 409,
    message: 'Para hoy ya no podemos: reserva con más tiempo.',
    field: null,
  },
  fuera_de_plazo: {
    status: 409,
    message: 'Todavía no abrimos la agenda de esas fechas.',
    field: null,
  },
  // El motivo solo se da cuando es TIEMPO, nunca cuando es diagnostico: `datos` lleva
  // `disponible_desde` en el primer caso y nada en el segundo.
  tratamiento_no_disponible: {
    status: 409,
    message: 'Consúltalo con tu doctora.',
    field: null,
  },
  promocion_no_aplica: {
    status: 409,
    message: 'Esa promoción ya no aplica. Puedes reservar sin ella.',
    field: null,
  },
  ya_tiene_cita: { status: 409, message: 'Ya tienes una cita para esto.', field: null },
  cita_no_existe: { status: 404, message: 'Esa cita ya no está.', field: null },
  cita_ya_atendida: {
    status: 409,
    message: 'Esa cita ya se atendió. No se puede mover.',
    field: null,
  },
  cita_cancelada: { status: 409, message: 'Esa cita está cancelada.', field: null },
  reagendar_tarde: {
    status: 409,
    message: 'Para cambiarla con tan poco tiempo, escríbele a tu doctora.',
    field: null,
  },
  sena_no_requerida: { status: 409, message: 'Esta cita no necesita seña.', field: null },
  // Mensaje vacio: «nada, la app recarga».
  sena_ya_confirmada: { status: 409, message: '', field: null },
  sena_vencida: {
    status: 410,
    message: 'Se pasó el plazo y el horario se liberó. Puedes reservar otro.',
    field: null,
  },
  demasiadas_esperas: {
    status: 409,
    message: 'Ya tienes tres avisos pedidos en esta consulta. Quita uno para pedir otro.',
    field: null,
  },
  franja_al_reves: {
    status: 400,
    message: 'La hora de fin va después de la de inicio.',
    field: 'franjas',
  },
  franjas_que_se_cruzan: {
    status: 400,
    message: 'Esas dos franjas se cruzan. Júntalas.',
    field: 'franjas',
  },
  dia_desconocido: { status: 400, message: 'Elige un día de la semana.', field: 'franjas' },
  paso_no_valido: {
    status: 400,
    message: 'El paso de la agenda tiene que ser de 5, 10, 15, 20, 30 o 60 minutos.',
    field: 'paso_de_agenda_minutos',
  },
  zona_horaria_desconocida: {
    status: 400,
    message: 'Esa zona horaria no existe.',
    field: 'zona_horaria',
  },
  // «Un dia cerrado con citas vivas es una paciente que se presenta a una puerta cerrada»: el
  // feriado no se impone, y `datos` lleva la lista de lo que hay ese dia.
  feriado_con_citas: {
    status: 409,
    message: 'Ese día ya tienes citas agendadas. Cancélalas o avísales antes de cerrar el día.',
    field: 'feriados',
  },
  // Mensaje vacio: la app pide de semana en semana y no llega a provocarlo.
  rango_demasiado_grande: { status: 400, message: '', field: null },

  // -------------------------------------------------------------------------------------
  // `tratamientos.md`. Las frases son las del contrato, literales.
  // -------------------------------------------------------------------------------------
  categoria_desconocida: {
    status: 400,
    message: 'Elige una categoría de la lista.',
    field: 'categoria',
  },
  duracion_fuera_de_rango: {
    status: 400,
    message: 'La duración va de 5 minutos a 8 horas.',
    field: 'duracion_minutos',
  },
  precio_no_valido: {
    status: 400,
    message: 'El precio tiene que ser un número entero.',
    field: 'precio',
  },
  // La frase dice POR QUE hace falta: es la regla clinica, no un campo mas del formulario.
  intervalo_necesario: {
    status: 400,
    message:
      'Dinos cada cuántos días se puede repetir: es lo que evita agendarlo antes de tiempo.',
    field: 'intervalo_minimo_dias',
  },
  producto_no_existe: {
    status: 404,
    message: 'Ese producto no está en tu inventario.',
    field: 'insumos',
  },
  nombre_repetido: {
    status: 409,
    message: 'Ya tienes un tratamiento con ese nombre.',
    field: 'nombre',
  },
  tratamiento_no_existe: {
    status: 404,
    message: 'Ese tratamiento no está en tu catálogo.',
    field: null,
  },
  desfase_sin_sentido: {
    status: 400,
    message: 'Un paso de antes va con horas negativas y uno de después con positivas.',
    field: 'pasos',
  },
  paso_sin_texto: {
    status: 400,
    message: 'Escribe qué tiene que hacer, o quita el paso.',
    field: 'pasos',
  },
  demasiados_pasos: {
    status: 400,
    message: 'Veinte pasos son muchos para recordar. Junta los que puedas.',
    field: 'pasos',
  },
  semaforo_dia_repetido: {
    status: 400,
    message: 'Ya tienes una indicación para ese día.',
    field: 'semaforo',
  },
  clave_desconocida: {
    status: 400,
    message: 'Esa contraindicación no está en la lista.',
    field: 'contraindicaciones',
  },
  valor_necesario: {
    status: 400,
    message: 'Dinos a qué, exactamente.',
    field: 'contraindicaciones',
  },
  falta_precio_base: {
    status: 400,
    message: 'Ponle primero un precio base al tratamiento.',
    field: 'precios',
  },
  zona_desconocida: { status: 400, message: 'Esa zona no está en la lista.', field: 'precios' },
  vigencia_al_reves: {
    status: 400,
    message: 'La fecha de fin va después de la de inicio.',
    field: 'vigencia',
  },
  vigencia_en_el_pasado: {
    status: 400,
    message: 'Esa promoción ya habría terminado.',
    field: 'vigencia',
  },
  descuento_fuera_de_rango: {
    status: 400,
    message: 'Un descuento va del 1 % al 90 %.',
    field: 'descuento',
  },
  segmento_desconocido: {
    status: 400,
    message: 'Elige un segmento de la lista.',
    field: 'segmento',
  },
  promocion_no_existe: {
    status: 404,
    message: 'Esa promoción ya no está en tu lista.',
    field: null,
  },
  codigo_repetido: {
    status: 409,
    message: 'Ya tienes una promoción con ese código.',
    field: 'codigo',
  },

  busqueda_muy_corta: { status: 400, message: '', field: 'busca' },
  // Un `PATCH` sin un solo campo no es una edicion. Mensaje vacio: es un error DE LA APP,
  // igual que la clave de idempotencia que falta.
  nada_que_cambiar: { status: 400, message: '', field: null },
  // Los tres de los vinculos. `vinculo_ya_resuelto` va con mensaje VACIO a proposito: «la app
  // recarga y sigue», no hay nada que contarle a una persona que ya respondio.
  vinculo_no_existe: { status: 404, message: 'Esa invitación ya no está.', field: null },
  vinculo_ya_resuelto: { status: 409, message: '', field: null },
  vinculo_sin_aceptar: { status: 409, message: '', field: null },
  paciente_archivada: {
    status: 409,
    message: 'Esa ficha está archivada. Reactívala antes de editarla.',
    field: null,
  },
  // La agenda es del tramo 4: hoy este 409 no se alcanza, y existe porque el camino del
  // archivado ya lo espera.
  cita_futura: {
    status: 409,
    message: 'Tiene una cita por delante. Cancélala antes de archivar su ficha.',
    field: null,
  },
  estado_no_valido: {
    status: 400,
    message: 'Ese filtro no existe. Vuelve a elegir entre activas, archivadas o todas.',
    field: 'estado',
  },
  vinculo_no_valido: {
    status: 400,
    message: 'Ese filtro no existe. Vuelve a elegir entre invitada, vinculada o revocada.',
    field: 'vinculo',
  },

  // `404 paciente_no_existe`, la misma respuesta que un `cuenta_id` inventado: no se
  // distingue "no es tuya" de "no existe".»
  paciente_no_existe: { status: 404, message: 'Esa paciente no está en tu lista.', field: null },
  celular_necesario_para_whatsapp: {
    status: 400,
    message: 'Para mandárselo por WhatsApp hace falta su celular.',
    field: 'celular',
  },
  // «Una doctora NO puede resetear la contraseña de su paciente una vez elegida. Si
  // pudiera, sería dueña del acceso al expediente de una persona adulta.» La frase lleva
  // el nombre de la paciente y la pone quien lanza.
  ya_eligio_su_contrasena: {
    status: 409,
    message: 'Ya eligió su contraseña. Si no puede entrar, dile que use «Olvidé mi contraseña».',
    field: null,
  },
  demasiados_reenvios: {
    status: 429,
    message: 'Ya le mandaste el acceso 3 veces en la última hora. Espera un rato.',
    field: null,
  },
  // No está en la tabla del contrato: el cuerpo es `{ "via": … }` con tres valores y hace
  // falta un error para el cuarto. Anotado para `producto`.
  via_no_valida: {
    status: 400,
    message: 'Elige por dónde mandárselo: correo, WhatsApp, o dárselo en persona.',
    field: 'via',
  },
  // Un `codigo`, dos frases: esta es la del reenvío. `POST /v1/patients` dice «Recepción
  // no puede dar de alta pacientes.» y la pasa cuando se implemente. Anotado para
  // `producto`.
  sin_permiso: { status: 403, message: 'Recepción no puede mandar accesos.', field: null },

  // ---------------------------------------------------------------------------------
  // POST /v1/team · `cuentas.md`. «Errores de correo, duplicado, permiso,
  // idempotencia y 500: los mismos de `POST /v1/patients`», así que `correo_vacio` y
  // `correo_mal_escrito` son los de arriba con la frase de ESE endpoint, que la pasa
  // quien lanza.
  // ---------------------------------------------------------------------------------
  nombre_vacio: { status: 400, message: 'Escribe el nombre y el apellido.', field: 'nombre' },
  rol_no_asignable: {
    status: 400,
    message: 'Ese permiso no se puede dar desde aquí.',
    field: 'rol',
  },
  // UN SOLO 409 PARA DOS CAUSAS, Y LA FRASE NO CONFIRMA NINGUNA (28 de octubre de 2026).
  // El correo puede estar tomado porque la persona ya está en este equipo o porque ese
  // correo ya tiene cuenta en la región —una paciente de otra consulta—. Dar dos códigos
  // sería el oráculo del padrón que §12.2.1 cierra: la dueña escribiría correos ajenos de
  // uno en uno y el segundo código le diría cuáles son pacientes de MedSkin, que es dato
  // de salud. El precio es una frase con menos filo, y se paga a propósito.
  // Y DESDE EL 28 DE OCTUBRE LO USAN DOS ENDPOINTS: el alta de equipo y el alta de una
  // paciente, que desde la 0021 también lo da cuando el correo es de una practicante. La
  // genérica dejó de nombrar al equipo porque «tiene que ser verdadera en todos los casos»
  // (_convenciones.md) y sin red se muestra esta: «para el equipo» era falso después de un
  // alta de paciente. Con red, cada endpoint manda la suya, que nombra el suyo.
  correo_no_disponible: {
    status: 409,
    message:
      'Ese correo no se puede usar aquí. Dale de alta con otro correo suyo, o escríbenos a hola@medskin.app.',
    field: 'correo',
  },

  // ---------------------------------------------------------------------------------
  // POST /v1/team/{member_id}/access · el reenvío del acceso del equipo.
  //
  // UN SOLO `404` PARA CUATRO SITUACIONES —no es de esta consulta, está retirada, su
  // cuenta está borrada, o es la fila de quien llama— e indistinguible de un
  // `miembro_id` inventado, como el de las pacientes. Que cubra «eres tú» es decisión:
  // la dueña no se reenvía el acceso a sí misma, porque sería acuñarse credenciales sin
  // saber su contraseña actual, que es justo lo que `PATCH …/contrasena` exige.
  // ---------------------------------------------------------------------------------
  miembro_no_existe: { status: 404, message: 'Esa persona no está en tu equipo.', field: null },

  // ---------------------------------------------------------------------------------
  // DELETE /v1/accounts/mine · los tres `409` hermanos: «antes de borrar a la persona hay
  // que desarmar lo que depende de ella». Dos llevan un número o una fecha dentro de la
  // frase, y los pone quien lanza con el dato que devuelve la función del borrado.
  // ---------------------------------------------------------------------------------
  consulta_con_equipo: {
    status: 409,
    message:
      'Primero saca a tu equipo de la consulta: si borras tu cuenta ahora, se quedan sin acceso.',
    field: null,
  },
  consulta_con_pacientes: {
    status: 409,
    message:
      'Tu consulta tiene {pacientes} con su historia clínica. Por ley alguien tiene que seguir siendo responsable de ella, así que primero hay que traspasar o cerrar la consulta. Escríbenos a hola@medskin.app y lo hacemos contigo.',
    field: null,
  },
  suscripcion_activa: {
    status: 409,
    message: 'Tu plan sigue activo hasta el {fecha}. Cancélalo primero y después borra tu cuenta.',
    field: null,
  },

  // ---------------------------------------------------------------------------------
  // LA CONSOLA INTERNA · `POST /v1/platform/accounts/{id}/access/resend` y
  // `DELETE /v1/platform/accounts/{id}/lock`.
  //
  // UN SOLO 404 PARA TRES SITUACIONES —no existe, está borrada, o es de otra región— e
  // indistinguible de un identificador inventado. Soporte no tiene por qué poder
  // averiguar en qué región vive una cuenta preguntando de una en una.
  //
  // El `409 ya_eligio_su_contrasena` de estas rutas es el del catálogo tal cual: su frase
  // no lleva nombre porque soporte no puede leer el nombre de nadie.
  // ---------------------------------------------------------------------------------
  cuenta_no_existe: { status: 404, message: 'No encontramos esa cuenta.', field: null },

  // ---------------------------------------------------------------------------------
  // POST /v1/patients · el alta. Lo contratan dos archivos: `cuentas.md` pone la cuenta
  // y el acceso, `pacientes.md` pone los cuatro últimos, que son del paso 3.
  //
  // `nombre_vacio`, `correo_vacio`, `correo_mal_escrito`, `celular_necesario_para_whatsapp`,
  // `via_no_valida`, `sin_permiso`, `clave_idempotencia_reutilizada` y el 500 son los de
  // arriba: un `codigo` no se duplica por endpoint, y la frase específica la pasa quien
  // lanza (_convenciones.md · «Un `codigo` que se usa en varios endpoints»).
  // ---------------------------------------------------------------------------------
  // UN SOLO CÓDIGO PARA «FALTA» Y PARA «MAL ESCRITA», y el nombre no afirma ninguna de las
  // dos: `nacimiento_vacio` era levemente falso con un `18/04/1992` o un 31 de febrero, que
  // no es una fecha vacía. Mismo criterio que `correo_ya_en_el_equipo` →
  // `correo_no_disponible`: el nombre de un código no puede afirmar algo que no pasó
  // (decidido el 28 de octubre de 2026 al construir el alta). La frase vale para los dos.
  nacimiento_no_valido: {
    status: 400,
    message: 'Revisa su fecha de nacimiento: falta o no está bien escrita.',
    field: 'nacimiento',
  },
  nacimiento_futuro: { status: 400, message: 'Esa fecha todavía no llegó.', field: 'nacimiento' },
  // La única frase del tramo que manda a atender en papel, y es la verdad: el
  // consentimiento de un tutor no existe en el producto y fingir que sí sería peor.
  menor_de_edad: {
    status: 400,
    message:
      'Es menor de edad. Necesitas el consentimiento de su tutor y eso todavía no está en MedSkin: atiéndela en papel.',
    field: 'nacimiento',
  },
  // El contrato escribe «Ese número no parece un celular de Bolivia.» y la validación es
  // E.164, que no es por país: no hay en ningún sitio la regla de marcación de cada país,
  // y una frase que nombra Bolivia sería falsa en el primer inquilino de otro. La genérica
  // tiene que ser verdadera en todos los casos, así que nombra el formato. Anotado para
  // `producto`: si la frase con el país importa, hace falta la regla por país de donde
  // sacarla.
  celular_mal_escrito: {
    status: 400,
    message: 'Ese número no parece un celular. Escríbelo con el código del país: +59177124408.',
    field: 'celular',
  },
  referida_sin_quien: {
    status: 400,
    message: 'Dinos quién la refirió, o cambia cómo llegó.',
    field: 'referida_por',
  },
  // El mismo 404 para «no es de esta consulta» y para un identificador inventado: no se
  // distingue una cosa de la otra, que es la regla de `paciente_no_existe` (§12.2.1).
  referida_no_existe: {
    status: 404,
    message: 'Esa paciente no está en tu lista.',
    field: 'referida_por',
  },
  // «EL DUPLICADO NO ES UN MURO»: aviso ámbar sobre el campo, no alerta, con dos salidas
  // —«Ver su ficha» y «Es otra persona»—. La frase con el nombre y la fecha la pone quien
  // lanza, y `datos` lleva `{ paciente_id, nombre_completo, alta_en }` para que la app
  // pueda escribirla y abrir esa ficha. Y es POR CONSULTA, nunca global: que ese correo
  // tenga ficha en otra clínica no es cosa de esta doctora ni se le dice.
  correo_duplicado_en_la_consulta: {
    status: 409,
    message: 'Ya tienes una paciente con este correo. Revisa antes de crear otra ficha.',
    field: 'correo',
  },
  licencia_sin_verificar: {
    status: 409,
    message:
      'Todavía no puedes invitar pacientes: tu licencia está en revisión. Te avisamos en cuanto se apruebe.',
    field: null,
  },
  // La frase lleva el número del plan y la pone quien lanza, con `patient_limit`.
  limite_del_plan: {
    status: 409,
    message: 'Llegaste al límite de pacientes de tu plan. Amplíalo para dar de alta más.',
    field: null,
  },
  demasiadas_altas: {
    status: 429,
    message: 'Llevas muchas altas en poco tiempo. Espera unos minutos.',
    field: null,
  },

  // Los cuatro del paso 3 (`pacientes.md`). `null` y `false` no son lo mismo y estos
  // errores son lo que lo sostiene: una lista vacía con `tiene: true` es una pregunta a
  // medio contestar, no un «no tiene».
  alergias_sin_cuales: {
    status: 400,
    message: 'Dinos a qué es alérgica, o marca que no tiene alergias.',
    field: 'alergias',
  },
  medicacion_sin_cuales: {
    status: 400,
    message: 'Dinos qué medicación toma.',
    field: 'medicacion',
  },
  fototipo_fuera_de_escala: {
    status: 400,
    message: 'El fototipo va del 1 al 6.',
    field: 'fototipo',
  },
  embarazo_valor_desconocido: {
    status: 400,
    message: 'Elige una opción de la lista.',
    field: 'embarazo_o_lactancia',
  },

  // ---------------------------------------------------------------------------------
  // `inquilinos.md` · los dos endpoints de la doctora. Las frases son las de su tabla de
  // errores, palabra por palabra.
  //
  // `403 sin_permiso` NO se repite aquí: es el mismo `codigo` del catálogo con la frase de
  // ESTE endpoint —«Solo la dueña de la consulta puede enviar la licencia.»— que pasa quien
  // lanza, igual que ya hace el alta del equipo. Un `codigo` es contrato y no se duplica
  // por una frase.
  // ---------------------------------------------------------------------------------
  rol_no_corresponde: {
    status: 403,
    message: 'Esta pantalla no es de tu cuenta.',
    field: null,
  },

  matricula_vacia: {
    status: 400,
    message: 'Escribe tu matrícula profesional.',
    field: 'matricula',
  },
  pais_sin_cobertura: {
    status: 400,
    message: 'Todavía no operamos en ese país. Escríbenos a hola@medskin.app.',
    field: 'pais_ejercicio',
  },
  especialidad_desconocida: {
    status: 400,
    message: 'Elige una especialidad de la lista.',
    field: 'especialidad',
  },
  declaracion_sin_aceptar: {
    status: 400,
    message: 'Tienes que declarar que la credencial es tuya y está vigente.',
    field: 'declaracion_aceptada',
  },
  terminos_sin_aceptar: {
    status: 400,
    message: 'Tienes que aceptar los términos y el tratamiento de datos.',
    field: 'terminos_aceptados',
  },
  credencial_sin_subir: {
    status: 400,
    message: 'Falta la foto o el PDF de tu credencial.',
    field: 'credencial_clave',
  },
  credencial_no_valida: {
    status: 400,
    message: 'Ese archivo no nos sirve. Tiene que ser JPG, PNG o PDF, y pesar menos de 10 MB.',
    field: 'credencial_clave',
  },
  licencia_en_revision: {
    status: 409,
    message: 'Tu licencia ya está en revisión. Te avisamos en cuanto haya respuesta.',
    field: null,
  },
  licencia_ya_verificada: { status: 409, message: 'Tu licencia ya está verificada.', field: null },
  demasiados_envios: {
    status: 429,
    message: 'Ya enviaste tu licencia varias veces hoy. Espera a que la revisemos.',
    field: null,
  },

  // Los del transporte (_convenciones.md · «Los errores del transporte», 27 de octubre).
  // No son de ningún endpoint: los devuelve el borde antes de llegar a uno. Dos no le
  // dicen nada al usuario —`mensaje` vacío— porque son errores de programación del
  // cliente, pero TIENEN código, y por eso la app los registra y nosotros los vemos.
  //
  // `405 metodo_no_permitido` NO está, y es la retirada del 27 de octubre: Fastify no
  // distingue «ruta que no existe» de «método que esa ruta no admite», así que un `PUT` a
  // una ruta de solo `POST` sale como `404 ruta_no_existe`. Un código que el servidor no
  // puede dar es peor que no prometerlo.
  // ---------------------------------------------------------------------------------
  ruta_no_existe: { status: 404, message: '', field: null },
  cuerpo_no_valido: {
    status: 400,
    message: 'Algo de lo que mandaste no está bien. Revísalo y vuelve a intentar.',
    field: null,
  },
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

  // LA CABECERA QUE FALTA, con `mensaje` vacío como los otros dos errores de programación
  // del cliente (`ruta_no_existe`, `formato_no_admitido`): no hay nada que contarle a una
  // persona que no puede hacer nada al respecto. Y TIENE código, para que la app lo registre.
  // `_convenciones.md` la exige en «todo `POST` que crea algo» y `cuentas.md` dice por qué:
  // «es obligatorio: la pantalla es una carga que bloquea».
  clave_idempotencia_faltante: { status: 400, message: '', field: null },

  clave_idempotencia_reutilizada: {
    status: 409,
    message: 'Esa clave ya se usó con otra petición. Usa una nueva.',
    field: null,
  },

  // La frase completa la pone quien lanza: es obligatoria y cambia por endpoint
  // (_convenciones.md · «El 500, en todas partes»). Esta es la parte que no cambia.
  fallo_de_servicio: { status: 500, message: 'El servidor no respondió.', field: null },

  // ---------------------------------------------------------------------------------
  // La consola interna · `plataforma-acceso.md`. Quien los lee es una persona de MedSkin
  // en una pantalla interna, así que la frase puede ser técnica: «aquí no hay nada que
  // proteger de quien pregunta». Es la única familia del catálogo donde eso vale.
  //
  // `token_de_plataforma_caducado` va con `mensaje` VACÍO y es lo que dice el contrato
  // —«Nada. La consola pide otro token y repite la petición»—, igual que los tres del
  // refresco: no hay refresco en la región y la pantalla no muestra texto.
  //
  // `region_no_corresponde` lleva la región de destino dentro de la frase y la pone quien
  // lanza, con `datos.region`. Decir a qué región ir es correcto AQUÍ: es información
  // interna para una persona de MedSkin, no un oráculo sobre una paciente.
  // ---------------------------------------------------------------------------------
  token_de_plataforma_no_valido: {
    status: 401,
    message: 'Tu sesión de consola no es válida. Vuelve a entrar.',
    field: null,
  },
  token_de_plataforma_caducado: { status: 401, message: '', field: null },
  region_no_corresponde: {
    status: 403,
    message: 'Ese token es de otra región. Abre la consola de {region}.',
    field: null,
  },

  // ---------------------------------------------------------------------------------
  // `inquilinos.md` · los tres de la consola. Las frases son las de sus tablas, palabra
  // por palabra.
  //
  // `409 correo_ya_tiene_cuenta` SÍ revela que el correo existe, y está bien: «aquí quien
  // llama es MedSkin sobre su propio padrón, no un desconocido sobre el de una clínica de
  // estética. La regla de la respuesta idéntica protege a la paciente de un tercero, no a
  // la plataforma de sí misma.»
  //
  // `409 licencia_sin_enviar` es el código del 28 de octubre: la base distingue TRES casos
  // —sin fila, `sin_enviar`, ya decidida— y el contrato nombraba dos. Mandar `sin_enviar`
  // al `licencia_ya_decidida` le diría a soporte que algo se decidió cuando no se decidió
  // nada, y quien lee esa pantalla iría a buscar una decisión que no existe.
  // ---------------------------------------------------------------------------------
  region_desconocida: { status: 400, message: 'Esa región no existe todavía.', field: 'region' },
  plan_desconocido: { status: 400, message: 'Ese plan no existe.', field: 'plan' },
  correo_ya_tiene_cuenta: {
    status: 409,
    message: 'Ese correo ya tiene una cuenta en MedSkin. Busca la consulta antes de crear otra.',
    field: 'doctora.correo',
  },
  inquilino_no_existe: { status: 404, message: 'No encontramos esa consulta.', field: null },
  licencia_no_existe: {
    status: 404,
    message: 'Esa consulta no tiene ninguna licencia en revisión.',
    field: null,
  },
  licencia_ya_decidida: { status: 409, message: 'Esta licencia ya se decidió.', field: null },
  licencia_sin_enviar: {
    status: 409,
    message: 'Esa consulta todavía no mandó su licencia. No hay nada que decidir.',
    field: null,
  },
  motivo_rechazo_vacio: {
    status: 400,
    message: 'Escribe el motivo del rechazo: la doctora lo va a leer.',
    field: 'motivo_rechazo',
  },
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
    /**
     * Sustituye el `campo` del catálogo. Existe por un caso concreto:
     * `contrasena_actual_no_coincide` nació en `PATCH /v1/accounts/mine/password`, cuyo
     * cuerpo es `{ actual, nueva }`, y `DELETE /v1/accounts/mine` lo reusa con un cuerpo
     * cuyo campo se llama `contrasena`. El `codigo` es contrato y no se duplica por un
     * nombre de campo; lo que cambia es a qué casilla se enciende en la pantalla.
     */
    field?: string | null,
  ) {
    const entry = CATALOG[code];
    super(code);
    this.name = 'ContractError';
    this.status = entry.status;
    this.field = field === undefined ? entry.field : field;
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

  // `cuentas.md`.
  sendPatientAccess:
    'No pudimos preparar el acceso. El servidor no respondió. Su ficha está intacta: puedes volver a intentarlo.',
  /**
   * El 500 del envío, que es OTRO caso y por eso otra frase: aquí el acceso **sí** se acuñó
   * y lo que falló fue el relé, así que la temporal anterior ya está muerta. Es la única
   * frase del tramo que admite que algo se perdió, y lo admite porque se perdió.
   */
  sendPatientAccessMail:
    'No pudimos mandarle el acceso. Su ficha está intacta, pero su contraseña anterior ya no vale: vuelve a mandárselo.',
  changePassword:
    'No pudimos guardar tu contraseña. El servidor no respondió. La de ahora sigue valiendo: puedes volver a intentarlo.',
  readOwnAccount:
    'No pudimos cargar tu cuenta. El servidor no respondió: puedes volver a intentarlo.',
  deleteOwnAccount:
    'No pudimos borrar tu cuenta. El servidor no respondió. No se borró nada: puedes volver a intentarlo.',
  /**
   * `POST /v1/team`. NO es la de `POST /v1/patients`: «los mismos errores» no alcanza a
   * la frase del 500, porque un alta de equipo no crea ninguna ficha y decir «no pudimos
   * crear la ficha» a quien dio de alta a su recepcionista es nombrar algo que no existe
   * (`cuentas.md`, 28 de octubre, en respuesta a la pregunta que levantó construirlo).
   */
  createTeamMember:
    'No pudimos dar de alta a esa persona. El servidor no respondió: puedes volver a intentarlo.',
  /**
   * El 500 del envío del acceso del equipo, que es OTRO caso: la cuenta ya está creada y lo
   * que falló fue el relé, así que reintentar el alta devuelve `409 correo_no_disponible` y
   * «puedes volver a intentarlo» sería falso.
   *
   * **Ya no manda a soporte**, y es el cambio que trae
   * `POST /v1/team/{member_id}/access`: desde que ese endpoint existe hay una salida
   * dentro del producto —volver a mandarle el acceso a esa misma persona— y la frase la
   * nombra en vez de prometer un reintento que daba 409 (`cuentas.md` · «El hueco que
   * obliga a un endpoint más»).
   */
  createTeamMemberMail:
    'No pudimos mandarle el acceso. Su cuenta ya está creada, así que no la vuelvas a dar de alta: vuelve a mandárselo.',
  /**
   * El 500 del reenvío del acceso del equipo. **No dice «su ficha está intacta»**, al
   * contrario que el de pacientes: una recepcionista no tiene ficha, y es el mismo motivo
   * por el que el 500 del alta de equipo dejó de nombrarla. Lo que sí admite es lo que se
   * perdió: la temporal nueva ya está acuñada y la anterior ya está muerta.
   */
  resendTeamAccess:
    'No pudimos mandarle el acceso. Su contraseña anterior ya no vale: vuelve a mandárselo.',

  /**
   * `POST /v1/patients`, literal de `cuentas.md` y de `pacientes.md`, que escriben la
   * misma segunda frase: lo que la doctora llenó está en el teléfono y el alta se puede
   * repetir con la misma `Idempotency-Key`.
   */
  /** `pacientes.md` · `GET /v1/patients`. La app guarda la ultima lista y la ensena. */
  listPatients:
    'No pudimos cargar tus pacientes. El servidor no respondió. Te mostramos la última lista guardada: puedes volver a intentarlo.',
  /** `pacientes.md` · `GET /v1/patients/{id}`. Lo mismo con la ficha. */
  readPatient:
    'No pudimos cargar su ficha. El servidor no respondió. Te mostramos lo último guardado: puedes volver a intentarlo.',

  /** `negocio.md`. La segunda frase dice que NO se registro nada, que es lo que calma. */
  savePayment:
    'No pudimos registrar el cobro. El servidor no respondió. No se registró nada: puedes volver a intentarlo.',
  readPayments:
    'No pudimos cargar los cobros. El servidor no respondió: puedes volver a intentarlo.',
  readMargins:
    'No pudimos calcular tus márgenes. El servidor no respondió: puedes volver a intentarlo.',
  readInventory:
    'No pudimos cargar tu inventario. El servidor no respondió: puedes volver a intentarlo.',
  saveMovement:
    'No pudimos guardar el movimiento. El servidor no respondió: puedes volver a intentarlo.',
  readReports:
    'No pudimos calcular el informe. El servidor no respondió: puedes volver a intentarlo.',
  readPlan: 'No pudimos cargar tu plan. El servidor no respondió: puedes volver a intentarlo.',
  requestExport:
    'No pudimos preparar tu copia. El servidor no respondió: puedes volver a intentarlo.',

  /** `cuidados.md`. Las frases dicen DÓNDE quedó lo que se escribió, que es lo que calma. */
  readAftercare:
    'No pudimos cargar tus cuidados. El servidor no respondió. Te mostramos los últimos guardados: puedes volver a intentarlo.',
  markCareStep:
    'No pudimos marcarlo. Lo guardamos en tu teléfono y se envía solo: no lo marques dos veces.',
  readTrafficLight:
    'No pudimos cargar la guía. El servidor no respondió: puedes volver a intentarlo.',
  reportIncident:
    'No pudimos enviar tu reporte. El servidor no respondió. Está guardado en tu teléfono y se envía solo. Si empeora, llama a la consulta.',
  readMessages:
    'No pudimos cargar el chat. El servidor no respondió. Te mostramos lo último guardado: puedes volver a intentarlo.',
  sendMessage:
    'No pudimos enviar tu mensaje. Está guardado en tu teléfono y se envía solo cuando vuelva la señal.',
  saveDevice:
    'No pudimos registrar este teléfono para avisos. El servidor no respondió: puedes volver a intentarlo.',
  savePreferences:
    'No pudimos guardar tus preferencias. El servidor no respondió. Siguen las de antes: puedes volver a intentarlo.',

  /** `imagenes.md` · las fotos. La frase dice donde quedo la foto, que es lo que importa. */
  signUpload:
    'No pudimos preparar la subida. El servidor no respondió. Tu foto está guardada en el teléfono y se sube sola cuando vuelva la señal.',
  confirmUpload:
    'No pudimos confirmar la foto. El servidor no respondió. La foto ya está subida: puedes volver a intentarlo.',
  readPhotos:
    'No pudimos cargar sus fotos. El servidor no respondió. Te mostramos las que ya tienes guardadas: puedes volver a intentarlo.',
  readMaster:
    'No pudimos abrir la foto original. El servidor no respondió: puedes volver a intentarlo.',
  comparePhotos:
    'No pudimos armar la comparación. El servidor no respondió: puedes volver a intentarlo.',
  deletePhoto:
    'No pudimos borrar la foto. El servidor no respondió. Sigue ahí: puedes volver a intentarlo.',

  /** `sesiones.md` · lo que se registra en la sala. */
  saveSession:
    'No pudimos guardar la sesión. El servidor no respondió. Todo lo que registraste está guardado en este teléfono y se envía solo cuando vuelva la señal.',
  saveNoteDraft:
    'No pudimos guardar el borrador. El servidor no respondió. Lo que escribiste está guardado en este teléfono: se envía solo.',
  signNote:
    'No pudimos firmar la nota. El servidor no respondió. El borrador está a salvo: puedes volver a intentarlo.',
  saveCorrection:
    'No pudimos guardar la corrección. El servidor no respondió. La nota sigue como estaba: puedes volver a intentarlo.',
  saveAdverseEvent:
    'No pudimos registrar el evento. El servidor no respondió. Lo que escribiste está guardado en este teléfono: puedes volver a intentarlo.',
  saveConsent:
    'No pudimos guardar el consentimiento. El servidor no respondió. No se firmó nada: puedes volver a intentarlo.',
  readConsentText:
    'No pudimos cargar el consentimiento. El servidor no respondió: puedes volver a intentarlo.',
  saveLot: 'No pudimos guardar el lote. El servidor no respondió: puedes volver a intentarlo.',
  readLots:
    'No pudimos cargar tus lotes. El servidor no respondió. Te mostramos los últimos guardados: puedes volver a intentarlo.',
  voidSession:
    'No pudimos anular la sesión. El servidor no respondió. Sigue como estaba: puedes volver a intentarlo.',

  /** `agenda.md` · los horarios y la agenda. */
  saveSchedule:
    'No pudimos guardar tus horarios. El servidor no respondió. Siguen los de antes: puedes volver a intentarlo.',
  readAvailability:
    'No pudimos cargar los horarios. El servidor no respondió: puedes volver a intentarlo.',
  /** La segunda frase dice lo que importa: no se reservó nada y no se te cobró. */
  bookAppointment:
    'No pudimos confirmar tu cita. El servidor no respondió. No se reservó nada y no se te cobró: puedes volver a intentarlo.',
  readAppointments:
    'No pudimos cargar tu agenda. El servidor no respondió. Te mostramos la última guardada: puedes volver a intentarlo.',
  moveAppointment:
    'No pudimos mover tu cita. El servidor no respondió. Sigue agendada a la hora de antes: puedes volver a intentarlo.',
  cancelAppointment:
    'No pudimos cancelar tu cita. El servidor no respondió. Sigue agendada: puedes volver a intentarlo.',
  saveDeposit:
    'No pudimos registrar tu pago. El servidor no respondió. Tu horario sigue guardado: puedes volver a intentarlo.',
  saveWaitlist:
    'No pudimos guardar tu aviso. El servidor no respondió: puedes volver a intentarlo.',
  syncBatch:
    'No pudimos sincronizar. El servidor no respondió. Lo que hiciste sin conexión sigue guardado en este teléfono: puedes volver a intentarlo.',

  /** `tratamientos.md` · el catalogo de la doctora. */
  saveTreatment:
    'No pudimos guardar el tratamiento. El servidor no respondió. Lo que llenaste está guardado en este teléfono: puedes volver a intentarlo.',
  readTreatments:
    'No pudimos cargar tu catálogo. El servidor no respondió. Te mostramos el último guardado: puedes volver a intentarlo.',
  saveProtocol:
    'No pudimos guardar el protocolo. El servidor no respondió. Lo que llenaste está guardado en este teléfono: puedes volver a intentarlo.',
  saveContraindications:
    'No pudimos guardar las contraindicaciones. El servidor no respondió: puedes volver a intentarlo.',
  savePrices:
    'No pudimos guardar los precios. El servidor no respondió. Siguen los de antes: puedes volver a intentarlo.',
  savePromotion:
    'No pudimos crear la promoción. El servidor no respondió. Lo que llenaste está guardado en este teléfono: puedes volver a intentarlo.',
  /** `tratamientos.md` · `GET /v1/catalog`, el de la paciente. */
  readCatalog:
    'No pudimos cargar el catálogo. El servidor no respondió. Te mostramos el último guardado: puedes volver a intentarlo.',

  /** `pacientes.md` · los vinculos de la paciente. */
  patientLinks:
    'No pudimos guardar tu respuesta. El servidor no respondió: puedes volver a intentarlo.',
  /** `pacientes.md` · `PUT /v1/links/{id}/medical-form`. */
  patientHistory:
    'No pudimos guardar tu ficha. El servidor no respondió. Lo que llenaste está guardado en este teléfono: puedes volver a intentarlo.',

  /** `pacientes.md` · `PATCH /v1/patients/{id}`. */
  editPatient:
    'No pudimos guardar el cambio. El servidor no respondió. Su ficha sigue como estaba: puedes volver a intentarlo.',
  /** `pacientes.md` · archivar y reactivar. */
  archivePatient:
    'No pudimos archivar su ficha. El servidor no respondió. No se archivó nada: puedes volver a intentarlo.',

  createPatient:
    'No pudimos crear la ficha. El servidor no respondió. Lo que llenaste está guardado en este teléfono: puedes volver a intentarlo.',
  /**
   * El 500 del envío del acceso del alta, que es OTRO caso y por eso otra frase: aquí la
   * ficha, la cuenta y la temporal YA existen y lo que falló fue el relé, así que «puedes
   * volver a intentarlo» mandaría a crear una segunda ficha de la misma persona —el alta no
   * da `409` por el correo, da el aviso del duplicado— y «lo que llenaste está guardado» ya
   * no es lo que hace falta. La salida es la que existe: volver a mandarle el acceso con
   * `POST /v1/accounts/{account_id}/access`. Es la misma clase de frase que la del alta de
   * equipo, y por el mismo motivo (28 de octubre de 2026; anotado para `producto`).
   */
  createPatientMail:
    'No pudimos mandarle el acceso. Su ficha ya está creada, así que no la vuelvas a dar de alta: vuelve a mandárselo.',
  /**
   * Y la del aviso a quien YA TENÍA CUENTA, que es un tercer caso: no se acuñó ninguna
   * temporal, así que no hay contraseña perdida ni acceso que volver a mandar —el reenvío le
   * daría `409 ya_eligio_su_contrasena` si ya eligió la suya—. Lo que se perdió es el aviso,
   * y su camino a la app sigue intacto: la pantalla «¿Es esta tu doctora?». La frase dice las
   * dos cosas y no promete un reintento que no existe.
   */
  createPatientNotice:
    'No pudimos avisarle por correo. Su ficha ya está creada, así que no la vuelvas a dar de alta: ella ya tiene su cuenta y va a ver tu invitación cuando abra la app.',

  /**
   * Las dos de `sesion.md`, y las dos prometen lo mismo: **el 500 de la sesión NO
   * expulsa.** «Un fallo al comprobar la sesión no es una sesión inválida»: si la app
   * mandara a la doctora al login cada vez que el servidor tose, le borraría la cola de
   * salida sin conexión (§9.3) en el peor momento posible. La app solo expulsa con un 401.
   */
  readSession: 'No pudimos comprobar tu sesión. Puedes seguir con lo último guardado.',
  refreshSession: 'No pudimos renovar tu sesión. Puedes seguir con lo último guardado.',

  /**
   * `inquilinos.md` · los dos de la doctora, literales de su tabla.
   *
   * La de la lectura **no es alerta**: es el estado «sin conexión» de
   * `Plataforma.dc.html` · 4, con lo último guardado y su fecha. La del envío promete «lo
   * que llenaste está guardado en este teléfono» porque `Licencia.dc.html` · 1 dibuja
   * «Guardar y salir»: si el contrato no lo garantizara, la pantalla miente.
   */
  readOwnPractice:
    'No pudimos cargar tu consulta. El servidor no respondió. Te mostramos lo último guardado: puedes volver a intentarlo.',
  submitLicense:
    'No pudimos enviar tu licencia. El servidor no respondió. Lo que llenaste está guardado en este teléfono: puedes volver a intentarlo.',

  /**
   * La frase del 500 cuando el fallo ocurre ANTES de saber a qué ruta iba
   * (_convenciones.md · «El 500, en todas partes», decisión 24 del 27 de octubre).
   */
  fallback:
    'No pudimos completar lo que pediste. El servidor no respondió: puedes volver a intentarlo.',

  // ---------------------------------------------------------------------------------
  // Los cinco de la consola interna, literales de `inquilinos.md` y de `cuentas.md` ·
  // «Consola interna». Viven aquí y no en el módulo porque la tabla de rutas las necesita
  // ANTES de que exista el controlador: una ruta sin su frase es un 500 sin segunda frase.
  // ---------------------------------------------------------------------------------
  createTenant:
    'No pudimos crear la consulta. El servidor no respondió. No se creó nada: puedes volver a intentarlo.',
  readTenant: 'No pudimos cargar la consulta. El servidor no respondió: puedes volver a intentarlo.',
  decideLicense:
    'No pudimos guardar la decisión. El servidor no respondió. La licencia sigue en revisión: puedes volver a intentarlo.',
  resendPlatformAccess:
    'No pudimos reenviar el acceso. El servidor no respondió: puedes volver a intentarlo.',
  liftAccessPause:
    'No pudimos levantar la pausa. El servidor no respondió: puedes volver a intentarlo.',
} as const;

/**
 * El código del transporte que le toca a cada estado de HTTP. Es la tabla de
 * _convenciones.md · «Los errores del transporte» leída al revés: el borde solo sabe el
 * número, y el catálogo pone el código y la frase.
 */
export const TRANSPORT_CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: 'cuerpo_no_valido',
  404: 'ruta_no_existe',
  413: 'cuerpo_demasiado_grande',
  415: 'formato_no_admitido',
  429: 'demasiadas_peticiones',
};
