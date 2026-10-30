// EL CÁLCULO DEL HUECO. Dominio puro: ni base, ni HTTP, ni reloj del servidor.
//
// LA HORA DE PARED NO ES UN INTERVALO FIJO DE HORAS. Una franja de «9 a 13» el día que cambia
// el horario de verano dura tres horas o cinco, no cuatro, y una agenda que suma milisegundos
// se mueve una hora ese día. Por eso aquí NADA se calcula sumando horas a un instante: cada
// hora de pared de la consulta se convierte a instante con el desfase REAL de ese día, que lo
// da `Intl.DateTimeFormat` con `timeZoneName: 'longOffset'`.
//
// Node 22 todavía no trae `Temporal` —que es lo que el contrato nombra— y no se añade una
// dependencia para esto: `Intl` ya lleva la base de datos de zonas horarias dentro, es la misma
// que usaría `Temporal`, y lo que necesitamos de ella son dos funciones.

export type Window = { startsAt: Date; endsAt: Date };

export type SlotRules = {
  timeZone: string;
  /** Franjas por día de la semana, 0 = domingo. Hora de pared: `09:00`. */
  rules: readonly { weekday: number; startsAt: string; endsAt: string }[];
  holidays: readonly { from: string; to: string }[];
  gapMinutes: number;
  slotMinutes: number;
  minNoticeHours: number;
  maxBookingDays: number;
};

export type DayAvailability = {
  day: string;
  slots: readonly string[];
  /** Por qué un día no tiene huecos. Un día vacío sin motivo deja a la app mintiendo. */
  reason: 'feriado' | 'sin_horario' | 'completo' | 'fuera_de_plazo' | null;
};

/**
 * El desfase de una zona en un instante, en minutos. `longOffset` da `GMT-04:00`; para UTC da
 * `GMT`, que es desfase cero y hay que leerlo así en vez de como un fallo.
 */
export function offsetMinutes(timeZone: string, instant: Date): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).format(instant);
  const found = /GMT([+-])(\d{2}):(\d{2})/.exec(formatted);
  if (found === null) return 0;
  const [, sign, hours, minutes] = found as unknown as [string, string, string, string];
  const total = Number(hours) * 60 + Number(minutes);
  return sign === '-' ? -total : total;
}

/**
 * Una hora de pared de la consulta —`2026-11-03` + `15:30`— al instante que le corresponde.
 *
 * Dos pasadas, y la segunda no sobra: el desfase se busca con una primera aproximación, y si
 * el día cruza un cambio de horario esa aproximación cae del lado equivocado. Con la segunda,
 * el resultado es estable salvo dentro de la hora que no existe, donde cualquier respuesta es
 * una convención.
 */
export function instantOf(day: string, wallTime: string, timeZone: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const [hour, minute] = wallTime.split(':').map(Number) as [number, number];
  const naive = Date.UTC(year, month - 1, date, hour, minute);

  const first = offsetMinutes(timeZone, new Date(naive));
  const second = offsetMinutes(timeZone, new Date(naive - first * 60_000));
  return new Date(naive - second * 60_000);
}

/** El día de calendario de un instante EN LA ZONA DE LA CONSULTA, no en UTC. */
export function dayOf(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** El día de la semana de una fecha de calendario, 0 = domingo. */
export function weekdayOf(day: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay();
}

/** Los días de un rango, inclusive, en fechas de calendario. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  const [year, month, date] = from.split('-').map(Number) as [number, number, number];
  let cursor = Date.UTC(year, month - 1, date);
  const end = (() => {
    const [y, m, d] = to.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  })();
  while (cursor <= end) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return days;
}

/**
 * Los huecos de un día. El orden de las comprobaciones es el que decide el `motivo`, y el
 * motivo es la mitad del valor de este endpoint.
 */
export function slotsOfDay(p: {
  day: string;
  durationMinutes: number;
  rules: SlotRules;
  busy: readonly Window[];
  now: Date;
}): DayAvailability {
  const { day, durationMinutes, rules, busy, now } = p;

  // 1 · Fuera de plazo: ni antes del aviso mínimo ni más allá de la reserva máxima. Se mira
  // primero porque no depende del horario de la consulta.
  const dayEnd = instantOf(day, '23:59', rules.timeZone);
  const earliest = new Date(now.getTime() + rules.minNoticeHours * 3_600_000);
  const latest = new Date(now.getTime() + rules.maxBookingDays * 86_400_000);
  if (dayEnd < earliest || instantOf(day, '00:00', rules.timeZone) > latest) {
    return { day, slots: [], reason: 'fuera_de_plazo' };
  }

  // 2 · Feriado: «un día cerrado con citas vivas es una paciente que se presenta a una puerta
  // cerrada», así que el feriado cierra el día entero para reservas nuevas.
  if (rules.holidays.some((h) => day >= h.from && day <= h.to)) {
    return { day, slots: [], reason: 'feriado' };
  }

  // 3 · Sin horario: la consulta no atiende ese día de la semana.
  const windows = rules.rules.filter((rule) => rule.weekday === weekdayOf(day));
  if (windows.length === 0) return { day, slots: [], reason: 'sin_horario' };

  const slots: string[] = [];
  for (const window of windows) {
    const opens = instantOf(day, window.startsAt, rules.timeZone);
    const closes = instantOf(day, window.endsAt, rules.timeZone);

    for (
      let start = opens.getTime();
      // El tratamiento tiene que caber ENTERO antes de cerrar: media sesión no es un hueco.
      start + durationMinutes * 60_000 <= closes.getTime();
      start += rules.slotMinutes * 60_000
    ) {
      const slotStart = new Date(start);
      if (slotStart < earliest || slotStart > latest) continue;

      // El margen entre citas no es hueco: se descuenta sin mostrarlo, y se descuenta a los
      // DOS lados —antes y después— porque es tiempo de limpieza y de notas.
      const slotEnd = new Date(start + durationMinutes * 60_000);
      const guardStart = new Date(start - rules.gapMinutes * 60_000);
      const guardEnd = new Date(slotEnd.getTime() + rules.gapMinutes * 60_000);

      const taken = busy.some(
        (window_) => window_.startsAt < guardEnd && window_.endsAt > guardStart,
      );
      if (!taken) slots.push(slotStart.toISOString());
    }
  }

  // 4 · Completo: hay horario, pero no queda ni un hueco. Distinto de «no atiende».
  return { day, slots, reason: slots.length === 0 ? 'completo' : null };
}

/** Los tres huecos más cercanos a uno que se ocupó. Es el valor del `409 hueco_ocupado`. */
export function nearestSlots(
  days: readonly DayAvailability[],
  wanted: Date,
  howMany = 3,
): readonly string[] {
  return days
    .flatMap((day) => day.slots)
    .sort(
      (a, b) =>
        Math.abs(new Date(a).getTime() - wanted.getTime()) -
        Math.abs(new Date(b).getTime() - wanted.getTime()),
    )
    .slice(0, howMany);
}

/**
 * La seña: «20 % del precio», y solo cuando la consulta lo configura y el precio pasa de su
 * mínimo. Redondea al centavo, hacia arriba: cobrar de menos por redondeo es regalar dinero de
 * la consulta, y cobrar de más una fracción de centavo no existe.
 */
export function depositFor(
  priceCents: number,
  settings: { depositPercent: number; depositMinCents: number | null },
): number | null {
  if (settings.depositPercent <= 0) return null;
  if (settings.depositMinCents === null) return null;
  if (priceCents < settings.depositMinCents) return null;
  return Math.ceil((priceCents * settings.depositPercent) / 100);
}

/**
 * Qué pasa con la seña al cancelar. UNA REGLA, UNA FRASE, DOS PANTALLAS: el estado del diseño
 * las encontró prometiendo dos cosas distintas, y esto es lo que las une.
 */
export function depositOnCancel(p: {
  by: 'patient' | 'practice' | 'system';
  startsAt: Date;
  now: Date;
  attended: boolean | null;
}): { status: 'devuelta' | 'credito'; how: 'entera' | 'credito_90_dias'; why: string } {
  // La consulta cancela: entera, siempre, y sin importar cuándo. No es culpa de la paciente.
  if (p.by !== 'patient') {
    return {
      status: 'devuelta',
      how: 'entera',
      why: 'La consulta canceló: tu doctora te la devuelve por el mismo medio.',
    };
  }
  // No se presentó: igual que cancelar con menos de 24 h.
  if (p.attended === false) {
    return {
      status: 'credito',
      how: 'credito_90_dias',
      why: 'No se registró tu asistencia: queda como crédito por 90 días.',
    };
  }
  const hoursAhead = (p.startsAt.getTime() - p.now.getTime()) / 3_600_000;
  if (hoursAhead > 24) {
    return {
      status: 'devuelta',
      how: 'entera',
      why: 'Cancelaste con más de 24 horas.',
    };
  }
  return {
    status: 'credito',
    how: 'credito_90_dias',
    why: 'Cancelaste con menos de 24 horas: queda como crédito por 90 días.',
  };
}
