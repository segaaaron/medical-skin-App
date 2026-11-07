// Repite una tarea con la espera EMPEZANDO al terminar cada pasada: una tanda lenta nunca se
// solapa con la siguiente. `unref()` para no sostener el proceso al apagar. La tarea responde
// de sus propios errores: si lanza, aquí se descarta para que el bucle no muera.

export class Periodic {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly everyMs: number,
    private readonly task: () => Promise<void>,
  ) {
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.task()
        .catch(() => undefined)
        .finally(() => this.schedule());
    }, this.everyMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
  }
}
