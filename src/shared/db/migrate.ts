import { runMigrations } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { QUEUE_SCHEMA } from '../queues/queues';

/**
 * EL CERROJO DE LAS MIGRACIONES. Esto corre en el arranque de CADA contenedor —el `CMD` migra y
 * después escucha— así que con más de una réplica hay dos procesos aplicando lo mismo a la vez.
 *
 * El migrador de Drizzle no toma ninguno: comprobado en el paquete instalado, ni un
 * `pg_advisory_lock` en lo que escribe `__drizzle_migrations`. Sin cerrojo, dos arranques
 * simultáneos leen la misma lista de pendientes y los dos intentan aplicarlas: con suerte una
 * falla con «already exists» y el despliegue se cae; sin suerte, dos `INSERT` en el registro y un
 * esquema a medias.
 *
 * `pg_advisory_lock` y no un `LOCK TABLE`: vive fuera de las transacciones del migrador, así que
 * cubre la pasada entera —Drizzle y BullMQ— y se suelta solo si el proceso muere.
 */
const CERROJO_MIGRACIONES = 728_193_044;

// Migra con el DUEÑO del esquema. La conexión de la API no es dueña de las tablas
// para que RLS sí se le aplique: si migrara ella, el aislamiento sería una ilusión.
async function aplicar() {
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) throw new Error('Falta DATABASE_URL_OWNER: las migraciones las aplica el dueño del esquema.');

  // `max: 2`: una conexión sostiene el cerrojo mientras la otra migra.
  const pool = new Pool({ connectionString: url, max: 2 });
  const guardia = await pool.connect();
  try {
    // Espera, no falla: el segundo contenedor se queda aquí hasta que el primero termine, y
    // entonces no encuentra nada pendiente y arranca.
    await guardia.query('select pg_advisory_lock($1)', [CERROJO_MIGRACIONES]);

    await migrate(drizzle(pool), { migrationsFolder: 'src/shared/db/migrations' });
    process.stdout.write('migraciones aplicadas\n');

    // LAS TABLAS DE LAS COLAS, en su propio esquema y con el mismo dueño.
    //
    // BullMQ NO las crea al conectarse —«connections do not apply migrations automatically»—:
    // hay que llamar a `runMigrations` desde un paso de despliegue, que es este. Son
    // idempotentes y se serializan con un cerrojo consultivo, así que dos procesos arrancando a
    // la vez no se pisan.
    const client = await pool.connect();
    try {
      await runMigrations(client);
    } finally {
      client.release();
    }

    // Y LOS PERMISOS DEL ROL DE LA APLICACIÓN sobre ese esquema. `medskin` no es dueño de nada
    // —esa es la regla que hace real la RLS— así que tampoco lo es de las tablas de las colas, y
    // sin esto el primer trabajo muere con «permission denied».
    //
    // Va aquí y no en una migración de Drizzle porque el esquema `bullmq` no existe hasta la
    // línea de arriba: una migración que lo nombrara fallaría al aplicarse desde cero.
    const appRole = new URL(process.env.DATABASE_URL ?? '').username || 'medskin';
    await pool.query(`GRANT USAGE ON SCHEMA ${QUEUE_SCHEMA} TO ${appRole}`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${QUEUE_SCHEMA} TO ${appRole}`,
    );
    await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${QUEUE_SCHEMA} TO ${appRole}`);
    // Lo que BullMQ cree después, en su próxima versión de esquema, nace ya concedido.
    await pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${QUEUE_SCHEMA}
         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole}`,
    );
    await pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${QUEUE_SCHEMA}
         GRANT USAGE, SELECT ON SEQUENCES TO ${appRole}`,
    );
    process.stdout.write(`colas: esquema ${QUEUE_SCHEMA} al día, permisos de ${appRole} dados\n`);
  } finally {
    await guardia
      .query('select pg_advisory_unlock($1)', [CERROJO_MIGRACIONES])
      .catch(() => undefined);
    guardia.release();
    await pool.end();
  }
}

void aplicar();
