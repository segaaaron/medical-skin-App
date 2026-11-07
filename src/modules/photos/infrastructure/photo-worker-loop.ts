import type { FailureLog } from '../../../shared/failures/service-failure';
import { Periodic } from '../../../shared/ops/periodic';
import type { PhotoWorker } from './photo-worker';

export const LOOP_INTERVAL_MS = 5_000;

type Passes = Pick<PhotoWorker, 'run' | 'purgeDerivatives' | 'rebuildDerivatives' | 'eraseDeleted'>;

/** El trabajador en bucle. No es BullMQ: lo que reclama el trabajo es la fila de la foto. */
export class PhotoWorkerLoop {
  private readonly periodic: Periodic;

  constructor(
    private readonly worker: Passes,
    private readonly failures: Pick<FailureLog, 'record'>,
  ) {
    this.periodic = new Periodic(LOOP_INTERVAL_MS, () => this.pass());
  }

  /**
   * En serie y en este orden: procesar lo nuevo es lo que la doctora espera delante de la
   * pantalla; purgar, regenerar y borrar pueden esperar a la pasada siguiente.
   */
  async pass(): Promise<void> {
    try {
      await this.worker.run();
      await this.worker.purgeDerivatives();
      await this.worker.rebuildDerivatives();
      await this.worker.eraseDeleted();
    } catch (cause) {
      await this.failures.record({
        service: 'worker',
        operation: 'foto.bucle',
        severity: 'error',
        errorCode: 'fallo_de_servicio',
        cause,
        traceId: 'foto-bucle',
        requestId: 'foto-bucle',
        appVersion: null,
        platform: null,
        region: null,
        context: null,
      });
    }
  }

  /** Nest lo llama al apagar; basta con el nombre del método. */
  onApplicationShutdown(): void {
    this.periodic.stop();
  }
}
