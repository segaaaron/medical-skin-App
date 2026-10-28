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
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 20_000,
  },
});
