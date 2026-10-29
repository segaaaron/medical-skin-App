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
