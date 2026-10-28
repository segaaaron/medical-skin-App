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

  JWT_PRIVATE_KEY_PATH: z.string().min(1),
  JWT_PUBLIC_KEY_PATH: z.string().min(1),

  // La llave del servicio con la que se calcula el HMAC de los correos de las claves de
  // Redis (_convenciones.md · «Los contadores», regla 2) y el resumen de los refrescos.
  // 32 bytes mínimo: con menos, el espacio enumerable de los correos se puede atacar.
  SERVICE_HMAC_KEY: z.string().min(32),

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
