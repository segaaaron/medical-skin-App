// Las reglas de `consultas.md` que no son una consulta. Sin base y sin dobles: son
// funciones del dominio.

import { describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import {
  capabilities,
  hasRoomForPatients,
  planLabel,
  readConsoleLicenseDraft,
  readLicenseDeclaration,
  SPECIALTIES,
} from './rules';

const FORMULARIO = {
  pais_ejercicio: 'BO',
  especialidad: 'medicina_estetica',
  matricula: '48921',
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

describe('`puede` · la app lo lee, y lo único que lo cierra es el cupo', () => {
  it('con cupo, las cuatro abiertas: LA LICENCIA YA NO ENTRA AQUÍ', () => {
    // Tomaba el estado de la licencia y cerraba invitar y registrar mientras alguien
    // revisaba. No hay revisión (migración 0072), así que una consulta con cupo puede todo
    // desde el alta.
    expect(capabilities(true)).toEqual({
      invitar_pacientes: true,
      registrar_sesiones: true,
      armar_catalogo: true,
      definir_horarios: true,
    });
  });

  it('la consulta en su tope no puede invitar, y es la ÚNICA condición que queda', () => {
    // El candado se pinta ANTES, en vez de dejar que la doctora escriba el alta entera y la
    // pierda contra un `409`. Y registrar tratamientos sigue abierto: es sobre una ficha que
    // ya existe y no consume ningún cupo.
    expect(capabilities(false)).toEqual({
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

describe('lo que el doctor declara · el orden de los errores es el de la pantalla', () => {
  it('acepta el cuerpo del contrato y recorta lo que el cliente mandó con espacios', () => {
    expect(readLicenseDeclaration({ ...FORMULARIO, matricula: '  48921 ' })).toEqual({
      practiceCountry: 'BO',
      specialty: 'medicina_estetica',
      licenseNumber: '48921',
    });
  });

  it('IGNORA la credencial y las dos aceptaciones aunque un cliente viejo las siga mandando', () => {
    // Se fueron con la revisión manual. Un `POST` de una app sin actualizar se guarda igual:
    // los campos que ya no existen sobran, no invalidan la declaración.
    expect(
      readLicenseDeclaration({
        ...FORMULARIO,
        credencial_clave: 'lic/x/4f2a.pdf',
        declaracion_aceptada: false,
        terminos_aceptados: false,
      }),
    ).toEqual({
      practiceCountry: 'BO',
      specialty: 'medicina_estetica',
      licenseNumber: '48921',
    });
  });

  it('la matrícula va primero, y una de menos de tres caracteres es una matrícula vacía', () => {
    expect(codigoDe(() => readLicenseDeclaration({ ...FORMULARIO, matricula: '  ' }))).toBe(
      'matricula_vacia',
    );
    // El `CHECK license_number_ck` pide entre 3 y 40: un `48` no entra en la base, así que
    // se para aquí con el error del contrato y no con un 500 del motor.
    expect(codigoDe(() => readLicenseDeclaration({ ...FORMULARIO, matricula: '48' }))).toBe(
      'matricula_vacia',
    );
  });

  it('un país que no es un país no pasa, y un cuerpo sin él tampoco', () => {
    expect(codigoDe(() => readLicenseDeclaration({ ...FORMULARIO, pais_ejercicio: 'QQ' }))).toBe(
      'pais_sin_cobertura',
    );
    expect(codigoDe(() => readLicenseDeclaration({ ...FORMULARIO, pais_ejercicio: 'bo' }))).toBe(
      'pais_sin_cobertura',
    );
    expect(codigoDe(() => readLicenseDeclaration({ ...FORMULARIO, pais_ejercicio: null }))).toBe(
      'pais_sin_cobertura',
    );
    // Y un país de verdad que no es el de la consulta SÍ pasa: la matrícula puede ser de
    // otro país y bloquearlo sería una regla que nadie escribió.
    expect(readLicenseDeclaration({ ...FORMULARIO, pais_ejercicio: 'AR' }).practiceCountry).toBe(
      'AR',
    );
  });

  it('la especialidad sale del catálogo, no del cuerpo', () => {
    expect(
      codigoDe(() => readLicenseDeclaration({ ...FORMULARIO, especialidad: 'cirugia' })),
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
      expect(readLicenseDeclaration({ ...FORMULARIO, especialidad }).specialty).toBe(
        especialidad,
      );
    }
    expect(
      codigoDe(() => readLicenseDeclaration({ ...FORMULARIO, especialidad: 'odontologia' })),
    ).toBe('especialidad_desconocida');
  });

  it('un cuerpo que no es un objeto no revienta: es un formulario sin matrícula', () => {
    expect(codigoDe(() => readLicenseDeclaration(null))).toBe('matricula_vacia');
    expect(codigoDe(() => readLicenseDeclaration('48921'))).toBe('matricula_vacia');
  });
});

// =========================================================================================
// LOS TRES DATOS DE LA LICENCIA QUE RECOGE LA CONSOLA · 30 de octubre de 2026
//
// Lo que estas pruebas fijan es que el bloque es OPCIONAL —el alta se puede hacer sin él— y
// que cuando viene se valida igual que en la app, para que la doctora no encuentre su
// formulario prellenado con algo que no puede guardar.
// =========================================================================================
describe('readConsoleLicenseDraft · lo que la consola puede recoger', () => {
  const bueno = { pais_ejercicio: 'BO', especialidad: 'dermatologia', matricula: 'MP-12345' };

  it('sin bloque `licencia` devuelve null: el alta se puede hacer sin él', () => {
    expect(readConsoleLicenseDraft(undefined)).toBeNull();
    expect(readConsoleLicenseDraft(null)).toBeNull();
  });

  it('con los tres campos devuelve los tres, y nada más', () => {
    expect(readConsoleLicenseDraft(bueno)).toEqual({
      practiceCountry: 'BO',
      specialty: 'dermatologia',
      licenseNumber: 'MP-12345',
    });
  });

  it('valida igual que la app: si aquí pasa, allí también', () => {
    // Si la consola admitiera algo que la app rechaza, la doctora encontraría su formulario
    // prellenado con un valor que no puede guardar.
    expect(() => readConsoleLicenseDraft({ ...bueno, matricula: 'ab' })).toThrow(
      /matricula_vacia/,
    );
    expect(() => readConsoleLicenseDraft({ ...bueno, pais_ejercicio: '11' })).toThrow(
      /pais_sin_cobertura/,
    );
    expect(() => readConsoleLicenseDraft({ ...bueno, especialidad: 'inventada' })).toThrow(
      /especialidad_desconocida/,
    );
  });
});
