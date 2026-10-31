// `siguiente_paso` · el servidor manda el paso, la app no lo deduce (`acceso.md`).
// La alternativa era que cada app armara el mismo árbol de decisiones en Swift y en Kotlin
// y que se desincronizaran en la primera regla nueva.

import type { NextStep, Role } from '../../../shared/contract/session';

/** El estado que hace falta para decidir, y nada más: esto se consulta en cada arranque. */
export type NextStepInput = {
  /** La credencial sigue siendo la temporal, o se acaba de recuperar. */
  passwordIsTemporary: boolean;
  /**
   * «¿Declaró su matrícula?», que es `license.license_number IS NOT NULL`. Era
   * `licenseStatus: string | null` con los cuatro estados de la revisión manual, y la
   * revisión se fue (migración 0072). `false` para una paciente, que no tiene consulta — y no
   * la manda a ninguna pantalla porque `role === 'patient'` sale antes.
   */
  licenseDeclared: boolean;
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
  if (role === 'patient') return 'inicio';
  // «¿Declaró su matrícula?», y NO «¿en qué estado está su revisión?». Era
  // `licenseStatus === 'sin_enviar'`, y ese estado se fue con la revisión manual (0072).
  // El paso se queda porque lo que promete sigue siendo verdad: quien no la declaró acaba en
  // esa pantalla. Lo que ya no pasa es que una doctora que SÍ la declaró se quede ahí
  // esperando a que alguien la apruebe.
  if (!facts.licenseDeclared) return 'licencia';
  if (!facts.firstDayDone) return 'primer_dia';
  return 'inicio';
}
