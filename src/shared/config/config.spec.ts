// La configuración. Una API que arranca a medias y revienta en la primera petición es una
// mala configuración (OWASP A05) con disfraz de despliegue correcto: si falta una variable
// el proceso no arranca y DICE CUÁL.
//
// Y lo que no hace: no imprime el valor. Entre estas variables hay secretos.

import { describe, expect, it } from 'vitest';

import { loadConfig } from './config';

const COMPLETO = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://medskin:x@localhost:5433/medskin',
  REDIS_URL: 'redis://localhost:6380',
  REGION: 'latam',
  REGION_ETIQUETA: 'Bolivia · bo-1',
  ZONA_HORARIA: 'America/La_Paz',
  JWT_PRIVATE_KEY_PATH: './.secrets/jwt.key',
  JWT_PUBLIC_KEY_PATH: './.secrets/jwt.pub',
  SERVICE_HMAC_KEY: 'x'.repeat(32),
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  CORREO_REMITENTE: 'no-responder@medskin.local',
};

describe('loadConfig', () => {
  it('valida el entorno completo y aplica los valores por omisión', () => {
    const cfg = loadConfig(COMPLETO);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.SMTP_SECURE).toBe(false);
    // CORS cerrado: una lista vacía no abre ningún origen.
    expect(cfg.CORS_ORIGENES).toEqual([]);
  });

  it('nombra la variable que falta', () => {
    const sinLlave: Record<string, string> = { ...COMPLETO };
    delete sinLlave.SERVICE_HMAC_KEY;
    expect(() => loadConfig(sinLlave)).toThrowError(/SERVICE_HMAC_KEY/);
  });

  it('nombra TODAS las que faltan, no solo la primera', () => {
    const fallo = capturar(() => loadConfig({ NODE_ENV: 'development' }));
    expect(fallo).toMatch(/DATABASE_URL/);
    expect(fallo).toMatch(/REDIS_URL/);
    expect(fallo).toMatch(/REGION/);
    expect(fallo).toMatch(/JWT_PRIVATE_KEY_PATH/);
  });

  it('NUNCA imprime el valor de un secreto', () => {
    const fallo = capturar(() => loadConfig({ ...COMPLETO, SERVICE_HMAC_KEY: 'corta' }));
    expect(fallo).toMatch(/SERVICE_HMAC_KEY/);
    expect(fallo).not.toMatch(/corta/);
  });

  it('rechaza una llave de servicio de menos de 32 bytes', () => {
    expect(() => loadConfig({ ...COMPLETO, SERVICE_HMAC_KEY: 'x'.repeat(31) })).toThrow();
  });

  it('rechaza una región que no es una de las tres del diseño', () => {
    expect(() => loadConfig({ ...COMPLETO, REGION: 'bo' })).toThrowError(/REGION/);
  });

  it('rechaza una URL de base que no es de Postgres', () => {
    expect(() => loadConfig({ ...COMPLETO, DATABASE_URL: 'mysql://x' })).toThrowError(
      /DATABASE_URL/,
    );
  });

  it('parte la lista de orígenes de CORS y descarta los vacíos', () => {
    const cfg = loadConfig({ ...COMPLETO, CORS_ORIGENES: 'https://a.app, https://b.app ,' });
    expect(cfg.CORS_ORIGENES).toEqual(['https://a.app', 'https://b.app']);
  });
});

function capturar(trabajo: () => unknown): string {
  try {
    trabajo();
  } catch (fallo) {
    return fallo instanceof Error ? fallo.message : String(fallo);
  }
  throw new Error('se esperaba un fallo de configuración y no se lanzó ninguno');
}
