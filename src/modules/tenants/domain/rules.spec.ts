// Las reglas de `consultas.md` que no son una consulta. Sin base y sin dobles: son
// funciones del dominio.

import { describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import {
  capabilities,
  estimatedResponseAt,
  hasRoomForPatients,
  isOwnCredentialKey,
  planLabel,
  readLicenseForm,
  SPECIALTIES,
} from './rules';

const PRACTICE = '22222222-2222-4222-8222-222222222222';

const FORMULARIO = {
  pais_ejercicio: 'BO',
  especialidad: 'medicina_estetica',
  matricula: '48921',
  credencial_clave: `lic/${PRACTICE}/4f2a.pdf`,
  declaracion_aceptada: true,
  terminos_aceptados: true,
};

/** El `codigo` del contrato, que es lo que las dos apps llevan indexado. */
function codigoDe(ejecutar: () => unknown): string {
  try {
    ejecutar();
  } catch (failure) {
    if (failure instanceof ContractError) return failure.code;
    throw failure;
  }
  throw new Error('no lanzó ningún error del contrato');
}

describe('`puede` · la app lo lee, no lo deduce del estado de la licencia', () => {
  it('invitar y registrar se abren con la licencia verificada y cupo en el plan', () => {
    expect(capabilities('verificada', true)).toEqual({
      invitar_pacientes: true,
      registrar_sesiones: true,
      armar_catalogo: true,
      definir_horarios: true,
    });
  });

  it('los otros tres estados dejan catálogo y horarios en `true`: la espera no bloquea el arranque', () => {
    for (const estado of ['sin_enviar', 'en_revision', 'rechazada']) {
      expect(capabilities(estado, true)).toEqual({
        invitar_pacientes: false,
        registrar_sesiones: false,
        armar_catalogo: true,
        definir_horarios: true,
      });
    }
  });

  it('la consulta en su tope no puede invitar, aunque su licencia esté verificada', () => {
    // El candado se pinta ANTES, en vez de dejar que la doctora escriba el alta entera y la
    // pierda contra un `409`. Y registrar tratamientos sigue abierto: es sobre una ficha que
    // ya existe y no consume ningún cupo.
    expect(capabilities('verificada', false)).toEqual({
      invitar_pacientes: false,
      registrar_sesiones: true,
      armar_catalogo: true,
      definir_horarios: true,
    });
  });

  it('el cupo se mide con el límite del plan: 300 de 300 es tope, 299 todavía no', () => {
    expect(hasRoomForPatients(148, 300)).toBe(true);
    expect(hasRoomForPatients(299, 300)).toBe(true);
    expect(hasRoomForPatients(300, 300)).toBe(false);
    // Un plan que se bajó por debajo de lo que ya hay: tope, no cupo negativo.
    expect(hasRoomForPatients(310, 300)).toBe(false);
  });
});

describe('`plan.nombre` · constante del borde', () => {
  it('etiqueta las tres claves del `CHECK` y devuelve la clave si llegara una cuarta', () => {
    expect(planLabel('consultorio')).toBe('Consultorio');
    expect(planLabel('clinica')).toBe('Clínica');
    expect(planLabel('individual')).toBe('Individual');
    // Una etiqueta de pantalla no tira la lectura entera: la licencia y el plan siguen.
    expect(planLabel('empresarial')).toBe('empresarial');
  });
});

describe('el formulario de la licencia · el orden de los errores es el de la pantalla', () => {
  it('acepta el cuerpo del contrato y recorta lo que el cliente mandó con espacios', () => {
    expect(readLicenseForm({ ...FORMULARIO, matricula: '  48921 ' }, PRACTICE)).toEqual({
      practiceCountry: 'BO',
      specialty: 'medicina_estetica',
      licenseNumber: '48921',
      credentialKey: `lic/${PRACTICE}/4f2a.pdf`,
    });
  });

  it('la matrícula va primero, y una de menos de tres caracteres es una matrícula vacía', () => {
    expect(codigoDe(() => readLicenseForm({ ...FORMULARIO, matricula: '  ' }, PRACTICE))).toBe(
      'matricula_vacia',
    );
    // El `CHECK license_number_ck` pide entre 3 y 40: un `48` no entra en la base, así que
    // se para aquí con el error del contrato y no con un 500 del motor.
    expect(codigoDe(() => readLicenseForm({ ...FORMULARIO, matricula: '48' }, PRACTICE))).toBe(
      'matricula_vacia',
    );
  });

  it('un país que no es un país no pasa, y un cuerpo sin él tampoco', () => {
    expect(codigoDe(() => readLicenseForm({ ...FORMULARIO, pais_ejercicio: 'QQ' }, PRACTICE))).toBe(
      'pais_sin_cobertura',
    );
    expect(codigoDe(() => readLicenseForm({ ...FORMULARIO, pais_ejercicio: 'bo' }, PRACTICE))).toBe(
      'pais_sin_cobertura',
    );
    expect(codigoDe(() => readLicenseForm({ ...FORMULARIO, pais_ejercicio: null }, PRACTICE))).toBe(
      'pais_sin_cobertura',
    );
    // Y un país de verdad que no es el de la consulta SÍ pasa: la matrícula puede ser de
    // otro país y bloquearlo sería una regla que nadie escribió.
    expect(readLicenseForm({ ...FORMULARIO, pais_ejercicio: 'AR' }, PRACTICE).practiceCountry).toBe(
      'AR',
    );
  });

  it('la especialidad sale del catálogo, no del cuerpo', () => {
    expect(
      codigoDe(() => readLicenseForm({ ...FORMULARIO, especialidad: 'cirugia' }, PRACTICE)),
    ).toBe('especialidad_desconocida');
  });

  it('las cuatro de la primera entrega entran, y ni una quinta', () => {
    // La lista la decidió `producto` el 28 de octubre y vive en `consultas.md`, que es de
    // donde la app saca su desplegable: si se edita allí y no aquí, esta prueba lo dice.
    expect(SPECIALTIES).toEqual([
      'medicina_estetica',
      'dermatologia',
      'cirugia_plastica',
      'medicina_general',
    ]);
    for (const especialidad of SPECIALTIES) {
      expect(readLicenseForm({ ...FORMULARIO, especialidad }, PRACTICE).specialty).toBe(
        especialidad,
      );
    }
    expect(
      codigoDe(() => readLicenseForm({ ...FORMULARIO, especialidad: 'odontologia' }, PRACTICE)),
    ).toBe('especialidad_desconocida');
  });

  it('los dos consentimientos tienen que ser `true` de verdad: un "true" de texto no es una declaración', () => {
    expect(
      codigoDe(() => readLicenseForm({ ...FORMULARIO, declaracion_aceptada: 'true' }, PRACTICE)),
    ).toBe('declaracion_sin_aceptar');
    expect(
      codigoDe(() => readLicenseForm({ ...FORMULARIO, terminos_aceptados: 1 }, PRACTICE)),
    ).toBe('terminos_sin_aceptar');
  });

  it('sin credencial es `credencial_sin_subir`, y con una que no sirve es `credencial_no_valida`', () => {
    expect(codigoDe(() => readLicenseForm({ ...FORMULARIO, credencial_clave: '' }, PRACTICE))).toBe(
      'credencial_sin_subir',
    );
    expect(
      codigoDe(() =>
        readLicenseForm({ ...FORMULARIO, credencial_clave: `lic/${PRACTICE}/x.docx` }, PRACTICE),
      ),
    ).toBe('credencial_no_valida');
  });

  it('un cuerpo que no es un objeto no revienta: es un formulario sin matrícula', () => {
    expect(codigoDe(() => readLicenseForm(null, PRACTICE))).toBe('matricula_vacia');
    expect(codigoDe(() => readLicenseForm('48921', PRACTICE))).toBe('matricula_vacia');
  });
});

describe('la clave de la credencial · es de la consulta del token y de ningún otro', () => {
  const OTRA = '33333333-3333-4333-8333-333333333333';

  it('acepta las tres extensiones del contrato bajo el prefijo de su consulta', () => {
    for (const nombre of ['4f2a.pdf', 'FOTO.JPG', 'credencial.jpeg', 'credencial.png']) {
      expect(isOwnCredentialKey(`lic/${PRACTICE}/${nombre}`, PRACTICE)).toBe(true);
    }
  });

  it('rechaza la clave de OTRA consulta: quien revisa abriría el documento de otra doctora', () => {
    expect(isOwnCredentialKey(`lic/${OTRA}/4f2a.pdf`, PRACTICE)).toBe(false);
  });

  it('rechaza salirse del prefijo y rechaza una URL, que es lo que nunca es una clave', () => {
    expect(isOwnCredentialKey(`lic/${PRACTICE}/../${OTRA}/4f2a.pdf`, PRACTICE)).toBe(false);
    expect(isOwnCredentialKey(`https://medskin.app/lic/${PRACTICE}/4f2a.pdf`, PRACTICE)).toBe(
      false,
    );
    expect(isOwnCredentialKey(`lic/${PRACTICE}/sin-extension`, PRACTICE)).toBe(false);
  });
});

describe('`respuesta_estimada_en` · 24 h hábiles en la zona del despliegue', () => {
  const LA_PAZ = 'America/La_Paz';

  it('un martes a las 18:24 promete el miércoles a la misma hora', () => {
    const martes = new Date('2026-10-27T22:24:00Z'); // 18:24 en La Paz
    expect(estimatedResponseAt(martes, LA_PAZ).toISOString()).toBe('2026-10-28T22:24:00.000Z');
  });

  it('un viernes salta el fin de semana entero: lo hábil es lo que no es sábado ni domingo', () => {
    const viernes = new Date('2026-10-30T22:24:00Z'); // viernes 18:24 en La Paz
    // +24 h cae sábado, y se empuja hasta el lunes.
    expect(estimatedResponseAt(viernes, LA_PAZ).toISOString()).toBe('2026-11-02T22:24:00.000Z');
  });

  it('la zona manda, y no es un detalle: el mismo instante cae en dos días distintos', () => {
    const instante = new Date('2026-10-30T22:24:00Z');
    // En Auckland ese instante ya es sábado por la mañana: las 24 h caen en domingo y se
    // empujan UNA vez, no dos, así que la respuesta se promete un día antes que en La Paz.
    expect(estimatedResponseAt(instante, 'Pacific/Auckland').toISOString()).toBe(
      '2026-11-01T22:24:00.000Z',
    );
    expect(estimatedResponseAt(instante, LA_PAZ).toISOString()).toBe('2026-11-02T22:24:00.000Z');
  });

  it('siempre está en el futuro, que es lo que la función de la base exige', () => {
    const ahora = new Date('2026-10-27T22:24:00Z');
    expect(estimatedResponseAt(ahora, LA_PAZ).getTime()).toBeGreaterThan(ahora.getTime());
  });
});
