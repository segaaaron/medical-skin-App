import { defineConfig } from 'drizzle-kit';

// Las migraciones las aplica el DUEÑO del esquema, no la aplicación:
// la conexión de la API no es dueña de las tablas para que RLS sí se le aplique.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/compartido/db/esquema/*.ts',
  out: './src/compartido/db/migraciones',
  dbCredentials: { url: process.env.DATABASE_URL_OWNER ?? '' },
  strict: true,
  verbose: true,
});
