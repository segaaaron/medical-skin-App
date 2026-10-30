// LA PRIMERA CUENTA DE CONSOLA · `pnpm platform:seed`
//
// La pone una semilla y NO un endpoint, por la misma razón que el alta de la primera
// doctora: la cuenta que puede abrir el padrón de todas las consultas no la crea nadie desde
// dentro. Un endpoint que crea cuentas de plataforma es un endpoint que, con un error de
// permisos, fabrica superusuarios (`plataforma-acceso.md` · «La primera cuenta»).
//
// LA CONTRASEÑA ENTRA POR LA ENTRADA ESTÁNDAR Y NUNCA POR ARGUMENTO. Un argumento queda en
// el historial del intérprete de órdenes, en la lista de procesos de la máquina y, si la
// orden se pega en un chat, en un sitio más. No se imprime, no se registra y no vuelve: lo
// único que sale por pantalla es el `id` de la fila.
//
// Corre con `DATABASE_URL_OWNER`, como las migraciones: `platform_account` no tiene grants
// para ningún rol de aplicación, así que ni `medskin` ni la propia consola podrían escribir
// aquí. Es la misma propiedad que hace que la consola no pueda leer sus propias cuentas.
//
//   pnpm platform:seed andrea@medskin.app "Andrea del equipo de soporte" \
//     plataforma:inquilinos:crear,plataforma:inquilinos:leer
//   Contraseña: ********

import { createInterface } from 'node:readline';

import { Pool } from 'pg';

import { PLATFORM_PERMISSIONS } from '../platform/platform-token';
import { Argon2Passwords } from '../security/passwords';

/**
 * Lee la contraseña sin mostrarla. `readline` con el eco apagado cuando hay terminal, y una
 * lectura normal cuando no la hay —una tubería, que es como se hace desde un guion— porque
 * apagar el eco de algo que no es un terminal lanza.
 */
async function readPassword(): Promise<string> {
  const input = process.stdin;
  const tty = input.isTTY === true;
  if (tty) {
    process.stderr.write('Contraseña: ');
    input.setRawMode(true);
  }
  const rl = createInterface({ input, terminal: false });
  const line = await new Promise<string>((resolve) => {
    rl.once('line', (value) => resolve(value));
  });
  rl.close();
  if (tty) {
    input.setRawMode(false);
    process.stderr.write('\n');
  }
  return line;
}

function readPermissions(raw: string): readonly string[] {
  const permissions = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');

  if (permissions.length === 0) {
    throw new Error('hacen falta permisos: una fila que no dice qué puede hacer no entra');
  }
  // La lista es CERRADA. Una cadena desconocida aquí sería una fila que el endpoint no puede
  // servir: `POST /v1/platform/access` responde 500 antes que firmar un token que el guardia
  // va a rechazar entero. Mejor que falle al sembrarla.
  const known = new Set<string>(PLATFORM_PERMISSIONS);
  for (const permission of permissions) {
    if (!known.has(permission)) {
      throw new Error(
        `permiso desconocido: ${permission}\nlos que hay: ${PLATFORM_PERMISSIONS.join(', ')}`,
      );
    }
  }
  return permissions;
}

async function seedPlatform(): Promise<void> {
  const [email, label, rawPermissions] = process.argv.slice(2);
  if (
    email === undefined ||
    label === undefined ||
    rawPermissions === undefined ||
    email.trim() === '' ||
    label.trim() === ''
  ) {
    throw new Error(
      'uso: pnpm platform:seed <correo> <etiqueta> <permiso,permiso,...>\n' +
        'la contraseña se pide por la entrada estándar, nunca por argumento',
    );
  }

  const permissions = readPermissions(rawPermissions);
  const password = await readPassword();
  if (password.length < 8) {
    throw new Error('la contraseña tiene que ser de 8 caracteres o más');
  }

  // Del entorno y no de `config()`: `DATABASE_URL_OWNER` no está en el esquema a propósito
  // —lo lee `migrate.ts` y nadie más— porque la API no tiene que poder leerla ni por error.
  // Esta semilla es la segunda excepción, y por la misma razón que la primera: escribe donde
  // ningún rol de aplicación tiene grants.
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) {
    throw new Error('falta DATABASE_URL_OWNER: esta semilla escribe donde la aplicación no puede');
  }

  const hash = await new Argon2Passwords().hash(password);
  const pool = new Pool({ connectionString: url });
  try {
    const { rows } = await pool.query<{ id: string }>(
      `insert into platform_account (email, password_hash, label, permissions)
            values ($1, $2, $3, $4)
       on conflict (email) do update
               set password_hash = excluded.password_hash,
                   label         = excluded.label,
                   permissions   = excluded.permissions,
                   status        = 'activa',
                   failed_attempts = 0,
                   locked_until  = null,
                   updated_at    = now()
         returning id`,
      [email.trim().toLowerCase(), hash, label.trim(), permissions],
    );
    // `on conflict do update` y no un error: volver a sembrar es como se cambia una
    // contraseña de consola, y hacerlo levanta la pausa — que es lo que hace falta cuando
    // alguien se queda fuera. Lo que NO hace es crear una segunda fila con el mismo correo.
    const row = rows[0];
    if (row === undefined) throw new Error('la fila no se escribió');
    process.stdout.write(`platform_account ${row.id}\n`);
  } finally {
    await pool.end();
  }
}

seedPlatform().catch((failure: unknown) => {
  process.stderr.write(`${failure instanceof Error ? failure.message : String(failure)}\n`);
  process.exitCode = 1;
});
