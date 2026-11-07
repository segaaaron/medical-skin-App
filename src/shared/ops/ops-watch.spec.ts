// La vigilancia contra la base real: deja una fila de alarma por tipo, una vez por hora, y no
// deja nada cuando todo está bien.

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { HealthController } from '../../modules/ops/health.controller';
import { OpsWatch } from './ops-watch';

const app = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin',
  max: 2,
});
afterAll(async () => {
  await app.end();
});

function watch(options: ConstructorParameters<typeof OpsWatch>[2], clock: { t: number }) {
  const recorded: string[] = [];
  const failures = {
    record: (f: { errorCode: string }) => {
      recorded.push(f.errorCode);
      return Promise.resolve();
    },
  };
  return { recorded, watch: new OpsWatch(app, failures, options, () => clock.t) };
}

describe('OpsWatch', () => {
  it('push sin credencial en producción: una alarma, y no otra hasta pasada una hora', async () => {
    const clock = { t: 1_000_000 };
    const { recorded, watch: w } = watch(
      { pushChannels: 0, storageAlertBytes: null, production: true },
      clock,
    );
    await w.check();
    await w.check();
    expect(recorded.filter((c) => c === 'push_sin_configurar')).toEqual(['push_sin_configurar']);

    clock.t += 61 * 60_000;
    await w.check();
    expect(recorded.filter((c) => c === 'push_sin_configurar')).toHaveLength(2);
  });

  it('con push configurado, o fuera de producción, no hay alarma de push', async () => {
    const clock = { t: 1 };
    const con = watch({ pushChannels: 1, storageAlertBytes: null, production: true }, clock);
    const dev = watch({ pushChannels: 0, storageAlertBytes: null, production: false }, clock);
    await con.watch.check();
    await dev.watch.check();
    expect(con.recorded).not.toContain('push_sin_configurar');
    expect(dev.recorded).not.toContain('push_sin_configurar');
  });

  it('el tope de almacenamiento se compara con los bytes de las maestras', async () => {
    const clock = { t: 1 };
    const sobre = watch({ pushChannels: 1, storageAlertBytes: 0, production: false }, clock);
    const bajo = watch(
      { pushChannels: 1, storageAlertBytes: Number.MAX_SAFE_INTEGER, production: false },
      clock,
    );
    await sobre.watch.check();
    await bajo.watch.check();
    expect(sobre.recorded).toContain('almacenamiento_lleno');
    expect(bajo.recorded).not.toContain('almacenamiento_lleno');
  });

  it('si la base no responde, lo registra como hallazgo y no lanza', async () => {
    const muerta = new Pool({ connectionString: 'postgresql://x:x@127.0.0.1:1/x', max: 1 });
    const recorded: string[] = [];
    const w = new OpsWatch(
      muerta,
      {
        record: (f: { errorCode: string }) => {
          recorded.push(f.errorCode);
          return Promise.resolve();
        },
      },
      { pushChannels: 1, storageAlertBytes: null, production: false },
    );
    await expect(w.check()).resolves.toBeUndefined();
    expect(recorded).toEqual(['vigilancia_caida']);
    await muerta.end();
  });
});

describe('GET /health', () => {
  it('responde ok con la base arriba y 503 con la base caída', async () => {
    await expect(new HealthController(app).check()).resolves.toEqual({ estado: 'ok' });

    const muerta = new Pool({ connectionString: 'postgresql://x:x@127.0.0.1:1/x', max: 1 });
    await expect(new HealthController(muerta).check()).rejects.toMatchObject({ status: 503 });
    await muerta.end();
  });
});
