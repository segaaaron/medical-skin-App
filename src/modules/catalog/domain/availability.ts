// LA REGLA CLÍNICA, QUE ES LA RAZÓN DE SER DE ESTE TRAMO.
//
// §6.2 punto 7 y el anti objetivo 7 de §4: «que la app recomiende una promoción clínicamente
// inadecuada» es uno de los siete fallos que el producto no se permite. Así que el filtro vive
// AQUÍ, en el servidor, y no en la app: la primera versión de la app que se olvide de aplicarlo
// le ofrece a una embarazada un tratamiento contraindicado.
//
// Y LO QUE SALE ES UN BOOLEANO, NO UN MOTIVO. Un tratamiento puede estar cerrado porque está
// contraindicado en su ficha o porque no se cumplió el intervalo mínimo, y las dos cosas son su
// dato clínico. Cuando la razón es el intervalo —que es TIEMPO, no diagnóstico— se devuelve
// `disponible_desde` y la app dice «podrás reservarlo desde el 12 de enero», que es útil y no
// revela nada. Cuando es una contraindicación no se devuelve nada más.

import type { CatalogTreatment, PatientFacts } from './ports';
import type { Contraindication } from './treatment';

export type Availability = {
  available: boolean;
  /** Solo cuando la razón es el intervalo. Con una contraindicación va nulo, siempre. */
  availableFrom: string | null;
};

/**
 * Si este tratamiento está disponible para ESTA paciente. El orden importa: la contraindicación
 * se mira primero, porque si bloquea no hay fecha que dar — dar una fecha diría que lo único que
 * falta es esperar, y eso sería una pista sobre su ficha.
 */
export function availabilityOf(
  treatment: CatalogTreatment,
  facts: PatientFacts,
  today: string,
): Availability {
  for (const item of treatment.contraindications) {
    // Una RELATIVA avisa a la doctora y no cierra la puerta: ella puede seguir asumiéndolo. En
    // el catálogo de la paciente solo bloquea la absoluta.
    if (!item.absolute) continue;
    if (blocks(item, facts)) return { available: false, availableFrom: null };
  }

  // El intervalo mínimo: tiempo, no diagnóstico. Sin sesiones registradas —tramo 5— no hay
  // fecha que comparar y el tratamiento está disponible.
  if (treatment.lastSessionOn !== null && treatment.minIntervalDays !== null) {
    const from = addDays(treatment.lastSessionOn, treatment.minIntervalDays);
    if (from > today) return { available: false, availableFrom: from };
  }

  return { available: true, availableFrom: null };
}

/** Si esta contraindicación se cumple en la ficha de esta paciente. */
function blocks(item: Contraindication, facts: PatientFacts): boolean {
  const history = facts.history;
  switch (item.key) {
    case 'embarazo':
      return history.pregnancyOrLactation === 'embarazo';
    case 'lactancia':
      return history.pregnancyOrLactation === 'lactancia';
    // Las tres de lista comparan sin mayúsculas y por contenido: «lidocaína» contra «Lidocaína
    // 2%» tiene que coincidir, porque lo que escribe una doctora no es un catálogo cerrado.
    case 'alergia':
      return has(history.allergies, item.value);
    case 'medicacion':
      return has(history.medication, item.value);
    case 'antecedente':
      return has(history.pastConditions, item.value);
    case 'fototipo_mayor_que':
      return history.phototype !== null && history.phototype > Number(item.value);
    case 'fototipo_menor_que':
      return history.phototype !== null && history.phototype < Number(item.value);
    case 'edad_menor_que':
      return ageOn(facts.birthDate) < Number(item.value);
    default:
      // Una clave que el `CHECK` admite y esto no conoce: NO bloquea y no se inventa un
      // criterio. Si algún día se añade una clave, se añade aquí y su prueba lo exige.
      return false;
  }
}

function has(list: readonly string[], value: string | null): boolean {
  if (value === null) return false;
  const needle = value.trim().toLowerCase();
  return list.some((item) => item.toLowerCase().includes(needle) || needle.includes(item.toLowerCase()));
}

function addDays(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const moved = new Date(Date.UTC(year, month - 1, date + days));
  return moved.toISOString().slice(0, 10);
}

function ageOn(birthDate: string): number {
  const [year, month, date] = birthDate.split('-').map(Number) as [number, number, number];
  const now = new Date();
  let age = now.getUTCFullYear() - year;
  const beforeBirthday =
    now.getUTCMonth() + 1 < month || (now.getUTCMonth() + 1 === month && now.getUTCDate() < date);
  if (beforeBirthday) age -= 1;
  return age;
}
