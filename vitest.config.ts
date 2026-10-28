import { defineConfig } from 'vitest/config';
import process from 'node:process';

// Las pruebas necesitan las mismas variables que la aplicación. Node las carga de .env.
process.loadEnvFile('.env');

// Las pruebas tocan la base real en Docker: nunca en paralelo contra el mismo esquema.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    pool: 'forks',
    // Vitest 4 eliminó `poolOptions.forks.singleFork` y lo ignora en silencio: la garantía
    // pasa a ser `fileParallelism: false`, que según su propio tipo fuerza `maxWorkers` a 1.
    // Sin esto los archivos corren en paralelo contra la MISMA base y se pisan la siembra.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
