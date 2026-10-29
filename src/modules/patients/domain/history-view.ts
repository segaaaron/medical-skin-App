// La forma de `antecedentes`, que es la misma en tres sitios: dentro de la ficha, en
// `GET /v1/pacientes/{id}/antecedentes`, y en lo que devuelve el `PUT`. Una sola función, aquí,
// porque tres copias de la misma forma divergen el día que se añade un campo.
//
// `fuentes` ES LO QUE HACE ESTO UTILIZABLE EN CONSULTA: la doctora ve de un vistazo que las
// alergias las escribió la paciente desde su app y la medicación la anotó ella. Y un campo con
// `fuente: null` es un campo que **nadie ha llenado**, que es distinto de un campo en `false`
// (`pacientes.md`).

/** La fila de `medical_history` tal como viene de la base. */
export type HistoryRow = {
  hasAllergies: boolean | null;
  allergies: readonly string[];
  allergiesSource: string | null;
  allergiesSourceAt: Date | null;
  takesMedication: boolean | null;
  medication: readonly string[];
  medicationSource: string | null;
  medicationSourceAt: Date | null;
  pregnancyOrLactation: string | null;
  pregnancySource: string | null;
  pregnancySourceAt: Date | null;
  phototype: number | null;
  phototypeSource: string | null;
  phototypeSourceAt: Date | null;
  pastConditions: readonly string[];
  pastConditionsSource: string | null;
  pastConditionsSourceAt: Date | null;
  previousTreatments: readonly string[];
  previousTreatmentsSource: string | null;
  previousTreatmentsSourceAt: Date | null;
  notes: string | null;
  notesSource: string | null;
  notesSourceAt: Date | null;
  updatedAt: Date;
};

export type HistorySource = { quien: string; cuando: string } | null;

export type HistoryView = {
  alergias: { tiene: boolean | null; cuales: readonly string[] };
  medicacion: { toma: boolean | null; cuales: readonly string[] };
  embarazo_o_lactancia: string | null;
  fototipo: number | null;
  antecedentes: readonly string[];
  tratamientos_previos: readonly string[];
  notas: string | null;
  fuentes: Record<string, HistorySource>;
  actualizado_en: string;
};

export function historyView(row: HistoryRow): HistoryView {
  return {
    alergias: { tiene: row.hasAllergies, cuales: row.allergies },
    medicacion: { toma: row.takesMedication, cuales: row.medication },
    embarazo_o_lactancia: row.pregnancyOrLactation,
    fototipo: row.phototype,
    antecedentes: row.pastConditions,
    tratamientos_previos: row.previousTreatments,
    notas: row.notes,
    fuentes: {
      alergias: sourceOf(row.allergiesSource, row.allergiesSourceAt),
      medicacion: sourceOf(row.medicationSource, row.medicationSourceAt),
      embarazo_o_lactancia: sourceOf(row.pregnancySource, row.pregnancySourceAt),
      fototipo: sourceOf(row.phototypeSource, row.phototypeSourceAt),
      antecedentes: sourceOf(row.pastConditionsSource, row.pastConditionsSourceAt),
      tratamientos_previos: sourceOf(row.previousTreatmentsSource, row.previousTreatmentsSourceAt),
      notas: sourceOf(row.notesSource, row.notesSourceAt),
    },
    actualizado_en: row.updatedAt.toISOString(),
  };
}

/**
 * Una ficha sin antecedentes **no existe**: el alta los crea siempre, aunque sea con los siete
 * campos vacíos (`POST /v1/pacientes`, paso 3). Pero si la fila falta —una ficha anterior a la
 * 0006, o un borrado manual— esto devuelve la forma completa en vacío en vez de un hueco: la
 * app ramifica por `fuentes`, no por la ausencia del objeto.
 */
export function emptyHistoryView(updatedAt: Date): HistoryView {
  return historyView({
    hasAllergies: null,
    allergies: [],
    allergiesSource: null,
    allergiesSourceAt: null,
    takesMedication: null,
    medication: [],
    medicationSource: null,
    medicationSourceAt: null,
    pregnancyOrLactation: null,
    pregnancySource: null,
    pregnancySourceAt: null,
    phototype: null,
    phototypeSource: null,
    phototypeSourceAt: null,
    pastConditions: [],
    pastConditionsSource: null,
    pastConditionsSourceAt: null,
    previousTreatments: [],
    previousTreatmentsSource: null,
    previousTreatmentsSourceAt: null,
    notes: null,
    notesSource: null,
    notesSourceAt: null,
    updatedAt,
  });
}

/** `quien` y `cuando` juntos, o nulo: media fuente no es una fuente. */
function sourceOf(who: string | null, when: Date | null): HistorySource {
  if (who === null || when === null) return null;
  return { quien: who, cuando: when.toISOString() };
}
