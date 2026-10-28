// El reloj del sistema. Cumple `ClockPort` del dominio por forma y no por `implements`:
// así `shared/` no importa de `modules/` y la flecha de dependencia sigue apuntando hacia
// dentro.

import { config } from './config/config';

export class SystemClock {
  private readonly formatter: Intl.DateTimeFormat;

  constructor(timeZone: string = config().ZONA_HORARIA) {
    this.formatter = new Intl.DateTimeFormat('es-BO', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  now(): Date {
    return new Date();
  }

  /** «a las 10:29» en la hora del despliegue. */
  localTime(moment: Date): string {
    return this.formatter.format(moment);
  }
}
