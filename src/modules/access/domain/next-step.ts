// `siguiente_paso` · el servidor manda el paso, la app no lo deduce (`acceso.md`).
// La alternativa era que cada app armara el mismo árbol de decisiones en Swift y en Kotlin
// y que se desincronizaran en la primera regla nueva.

import type { NextStep, Role } from '../../../shared/contract/session';

/** El estado que hace falta para decidir, y nada más: esto se consulta en cada arranque. */
export type NextStepInput = {
  /** La credencial sigue siendo la temporal, o se acaba de recuperar. */
  passwordIsTemporary: boolean;
  /** `license.status` de su consulta. Nulo para una paciente. */
  licenseStatus: string | null;
  /** Las tres tareas de `PrimerDia` terminadas, o la lista cerrada por ella. */
  firstDayDone: boolean;
};

/**
 * El orden es el de la tabla del contrato y es el que importa: la contraseña temporal gana
 * sobre todo lo demás, porque «mientras la contraseña siga siendo la temporal, no se abre
 * ninguna otra pantalla».
 *
 * `segundo_factor` no se devuelve nunca en esta entrega: `sesion.md` está en `propuesto` y
 * el segundo factor va apagado.
 *
 * `vincular` y `ficha_medica` tampoco, y no por decisión: dependen de `patient_link`, que
 * es del tramo 2. Una paciente con su contraseña definitiva recibe `inicio` hasta entonces.
 */
export function resolveNextStep(role: Role, facts: NextStepInput): NextStep {
  if (facts.passwordIsTemporary) return 'contrasena_nueva';
  if (role === 'paciente') return 'inicio';
  if (facts.licenseStatus === 'sin_enviar') return 'licencia';
  if (!facts.firstDayDone) return 'primer_dia';
  return 'inicio';
}
