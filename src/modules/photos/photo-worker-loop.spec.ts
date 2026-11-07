// El bucle del trabajador: no solapa pasadas y un fallo deja su fila en `service_failure`.
// El trabajador es un doble; el registro de fallos es el real, contra la base.

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FailureLog } from '../../shared/failures/service-failure';
import { LOOP_INTERVAL_MS, PhotoWorkerLoop } from './infrastructure/photo-worker-loop';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 2 });

const noFailures = { record: () => Promise.resolve(undefined) };

function idleWorker(run: () => Promise<number>) {
  return {
    run,
    purgeDerivatives: () => Promise.resolve(0),
    rebuildDerivatives: () => Promise.resolve(0),
    eraseDeleted: () => Promise.resolve(0),
  };
}

const clean = () => owner.query(`delete from service_failure where operation = 'foto.bucle'`);

beforeAll(clean);
afterAll(async () => {
  await clean();
  await owner.end();
  await app.end();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('el bucle de fotos', () => {
  it('no empieza otra pasada mientras la anterior sigue', async () => {
    vi.useFakeTimers();
    let release = (): void => undefined;
    let passes = 0;
    const loop = new PhotoWorkerLoop(
      idleWorker(() => {
        passes += 1;
        return passes === 1
          ? new Promise<number>((resolve) => (release = () => resolve(0)))
          : Promise.resolve(0);
      }),
      noFailures,
    );

    await vi.advanceTimersByTimeAsync(LOOP_INTERVAL_MS);
    expect(passes).toBe(1);
    await vi.advanceTimersByTimeAsync(LOOP_INTERVAL_MS * 6);
    expect(passes).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(LOOP_INTERVAL_MS);
    expect(passes).toBe(2);
    loop.onApplicationShutdown();
  });

  it('un fallo de la pasada queda registrado y la pasada no lanza', async () => {
    const loop = new PhotoWorkerLoop(
      idleWorker(() => Promise.reject(new Error('la base no respondió'))),
      new FailureLog(app),
    );
    loop.onApplicationShutdown();

    await expect(loop.pass()).resolves.toBeUndefined();

    const { rows } = await owner.query<{ operation: string; error_message: string }>(
      `select operation, error_message from service_failure where operation = 'foto.bucle'`,
    );
    expect(rows).toEqual([{ operation: 'foto.bucle', error_message: 'la base no respondió' }]);
  });
});
