// El reloj del sistema. Cumple `ClockPort` del dominio por forma y no por `implements`:
// así `shared/` no importa de `modules/` y la flecha de dependencia sigue apuntando hacia
// dentro.

import { config } from './config/config';

export class SystemClock {
  private readonly formatter: Intl.DateTimeFormat;
  private readonly longFormatter: Intl.DateTimeFormat;
  private readonly dayFormatter: Intl.DateTimeFormat;

  constructor(timeZone: string = config().ZONA_HORARIA) {
    this.formatter = new Intl.DateTimeFormat('es-BO', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    this.longFormatter = new Intl.DateTimeFormat('es-BO', {
      timeZone,
      weekday: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    this.dayFormatter = new Intl.DateTimeFormat('es-BO', {
      timeZone,
      day: 'numeric',
      month: 'long',
    });
  }

  now(): Date {
    return new Date();
  }

  /** «a las 10:29» en la hora del despliegue. */
  localTime(moment: Date): string {
    return this.formatter.format(moment);
  }

  /**
   * «jueves 30 a las 18:24», para el `caduca_en_texto` de `cuentas.md`. Lo escribe el
   * servidor y no la app por lo mismo que el texto del WhatsApp: dos apps que formatean
   * fechas en dos idiomas de programación acaban escribiendo dos frases distintas.
   */
  localLongWhen(moment: Date): string {
    const parts = this.longFormatter.formatToParts(moment);
    const of = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((part) => part.type === type)?.value ?? '';
    return `${of('weekday')} ${of('day')} a las ${of('hour')}:${of('minute')}`;
  }

  /**
   * «3 de agosto», para la frase del duplicado del alta: «Ya tienes a Valeria Antelo con
   * este correo, de alta el 3 de agosto». La escribe el servidor por lo mismo que las otras
   * dos: una fecha formateada en dos apps acaba leyéndose de dos maneras.
   */
  localDay(moment: Date): string {
    return this.dayFormatter.format(moment);
  }
}
