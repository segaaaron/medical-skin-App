// La configuración, validada una vez al arrancar. Si falta una variable el proceso no
// arranca y dice CUÁL: una API que arranca a medias y revienta en la primera petición es
// una mala configuración (OWASP A05) con disfraz de despliegue correcto.
//
// Nadie lee `process.env` fuera de este archivo. El resto del código recibe `config`.

import { z } from 'zod';

const urlPostgres = z.string().min(1).startsWith('postgresql://');

const esquema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().positive().default(3000),

  // La API usa el usuario de aplicación, nunca el dueño del esquema: RLS no se aplica al
  // dueño. `DATABASE_URL_OWNER` no está aquí a propósito: lo lee `migrate.ts` y nadie más.
  DATABASE_URL: urlPostgres,
  DATABASE_URL_POOLER: urlPostgres.optional(),

  REDIS_URL: z.string().min(1).startsWith('redis'),

  // §7.4: un despliegue por región. La etiqueta sale de aquí y no de la base (decisión 6
  // de preguntas-abiertas): todos los inquilinos de un despliegue comparten la etiqueta.
  REGION: z.enum(['eu', 'us', 'latam']),
  REGION_ETIQUETA: z.string().min(1),
  // La zona del despliegue, para las frases con hora («Puedes volver a entrar a las
  // 10:29»). No sale de la fila del inquilino a propósito: cuando esa frase se escribe
  // —una pausa de acceso, sin sesión— no hay inquilino, y la respuesta tiene que ser
  // idéntica exista o no la cuenta.
  ZONA_HORARIA: z.string().min(1),

  // El plazo legal de conservación del expediente, en años. Sale de aquí y NO de una tabla
  // (decisión del 28 de octubre, `cuentas.md` · DELETE /v1/accounts/mine): no es dato de
  // inquilino —todos los de un despliegue comparten el plazo— y guardarlo por fila serían N
  // copias del mismo literal que se pueden desincronizar. `se_conserva.hasta` se calcula
  // sumándolo a la fecha del borrado, y lo que queda escrito en la bitácora es la FECHA
  // resultante, no el parámetro: si mañana cambia el plazo, no cambia lo que se le prometió
  // a quien ya se borró. El número por país sigue siendo decisión abierta (§16.7).
  CONSERVACION_ANOS: z.coerce.number().int().positive().max(50),

  // EL PESO DE UNA FICHA EN DISCO, en MB, para el `almacenamiento_limite` de `GET /v1/plan`.
  //
  // Sale de la configuración y NO de una constante del código, porque el número depende del
  // despliegue: de lo que la app reduzca antes de subir y de si la maestra se recomprime. La
  // constante anterior —120 fotos × 1,6 MB— venía del plan de JPEG XL q95, y el 28 de octubre
  // de 2026 se midió que esta compilación de `sharp` NO trae libjxl: la maestra se guarda tal
  // cual. O sea que la pantalla del plan mostraba un número medido —`almacenamiento_usado`,
  // que son bytes reales— al lado de uno inventado.
  //
  // El valor por omisión, con los números de `servicios.md` §6.1: 120 fotos por ficha, cada
  // una con su maestra original de ~3 MB (la app no sube nada de más de 3000 px) y sus tres
  // derivadas en AVIF (~0,64 MB) ≈ 437 MB, redondeado a 450.
  ALMACENAMIENTO_POR_FICHA_MB: z.coerce.number().int().positive().max(100_000).default(450),

  // LOS AVISOS · APNs para iOS y FCM para Android (`servicios.md` §2). Los cinco de Apple y el
  // de Google son OPCIONALES a propósito: sin credencial no se construye el remitente, y la
  // bandeja de salida acumula los avisos en vez de gastar sus tres intentos contra un canal
  // que no existe. En desarrollo no hay ninguna —el certificado de Apple cuesta 99 USD al año
  // y no hace falta para encolar—, así que el valor por omisión es «no hay push» y se ve.
  //
  // El `.p8` de Apple y el JSON de la cuenta de servicio de Google son SECRETOS: en producción
  // los pone el servicio de llaves, nunca el repositorio, igual que las llaves del token.
  APNS_KEY_PATH: z.string().optional(),
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  /** El identificador del paquete de la app, que es el `apns-topic`. */
  APNS_TOPIC: z.string().optional(),
  // `api.sandbox.push.apple.com` hasta que la app esté en la tienda: un token de desarrollo
  // contra el servidor de producción es un `BadDeviceToken`, y es el error que más tiempo
  // cuesta la primera vez.
  APNS_HOST: z.string().default('api.sandbox.push.apple.com'),
  FCM_CUENTA_SERVICIO_PATH: z.string().optional(),

  JWT_PRIVATE_KEY_PATH: z.string().min(1),
  JWT_PUBLIC_KEY_PATH: z.string().min(1),

  // LA LLAVE DEL TOKEN DE PLATAFORMA, y es OTRA llave (`plataforma-acceso.md`): la consola
  // entra con un token que firma el servicio de plataforma, fuera de la región, «con su
  // propio `kid` y su propio par de llaves, distinto del de las sesiones de la app». Aquí
  // solo vive la PÚBLICA: este proceso no puede firmar un token de consola ni por error.
  //
  // La privada es OPCIONAL y solo sirve en `development`, donde el servicio que firma no
  // corre en la máquina de nadie y hace falta poder acuñar un token a mano. En producción no
  // se pone, y nada la lee.
  PLATFORM_JWT_PUBLIC_KEY_PATH: z.string().min(1),

  // LA VENTANA DE ROTACIÓN DE LA LLAVE DE LA CONSOLA. Una lista de rutas separadas por coma,
  // y puede estar vacía: son las llaves públicas que TAMBIÉN se aceptan además de la de
  // arriba. Sin esto, rotar la llave del servicio de plataforma apagaba la consola: el
  // momento en que la nueva se publica aquí y el momento en que el servicio empieza a firmar
  // con ella no pueden ser el mismo instante en dos procesos distintos, y los tokens de
  // quince minutos ya emitidos con la vieja se rechazaban todos.
  //
  // Cómo se usa una rotación, en orden: se añade la NUEVA aquí, se despliega, el servicio de
  // plataforma empieza a firmar con ella, se mueve a `PLATFORM_JWT_PUBLIC_KEY_PATH` y la
  // vieja se quita de aquí. En ningún paso hay un hueco sin llave válida.
  PLATFORM_JWT_PUBLIC_KEYS_EXTRA: z.string().optional(),
  PLATFORM_JWT_PRIVATE_KEY_PATH: z.string().min(1).optional(),

  // La llave del servicio con la que se calcula el HMAC de los correos de las claves de
  // Redis (_convenciones.md · «Los contadores», regla 2) y el resumen de los refrescos.
  // 32 bytes mínimo: con menos, el espacio enumerable de los correos se puede atacar.
  SERVICE_HMAC_KEY: z.string().min(32),

  // El almacenamiento de objetos. «S3» es el PROTOCOLO, no Amazon: en producción es Garage,
  // autoalojado en la misma VPS, y en desarrollo LocalStack. Por eso el endpoint es una
  // variable y no una región de AWS, y por eso `S3_FORCE_PATH_STYLE` existe: Garage y
  // LocalStack sirven por ruta, S3 de verdad por subdominio.
  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  CORREO_REMITENTE: z.string().email(),

  // CORS cerrado por defecto: una lista vacía no abre ningún origen (OWASP A05).
  CORS_ORIGENES: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    ),
});

export type Config = z.infer<typeof esquema>;

/** Valida el entorno. Lanza nombrando las variables que faltan o están mal. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const resultado = esquema.safeParse(env);
  if (resultado.success) return resultado.data;

  const detalle = resultado.error.issues
    .map((i) => `  ${i.path.join('.') || '(raíz)'}: ${i.message}`)
    .join('\n');
  // El valor NUNCA se imprime: entre estas variables hay secretos (OWASP A09).
  throw new Error(`La configuración no es válida y la API no arranca:\n${detalle}`);
}

let memoria: Config | null = null;

/** La configuración del proceso. Se valida la primera vez y se reutiliza. */
export function config(): Config {
  memoria ??= loadConfig();
  return memoria;
}
