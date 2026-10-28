import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

// Migra con el DUEÑO del esquema. La conexión de la API no es dueña de las tablas
// para que RLS sí se le aplique: si migrara ella, el aislamiento sería una ilusión.
async function aplicar() {
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) throw new Error('Falta DATABASE_URL_OWNER: las migraciones las aplica el dueño del esquema.');

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: 'src/shared/db/migrations' });
    process.stdout.write('migraciones aplicadas\n');
  } finally {
    await pool.end();
  }
}

void aplicar();
