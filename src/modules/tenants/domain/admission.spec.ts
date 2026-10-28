// Los dos cuerpos de la consola, leídos en el borde. Sin base y sin dobles.

import { describe, expect, it } from 'vitest';

import { ContractError } from '../../../shared/contract/error-catalog';
import { readEmail } from '../../recovery/domain/code';
import { PLAN_LIMITS, ownerWelcomeMailBody, readAdmission, readDecision } from './admission';

const ALTA = {
  nombre: 'Clínica Paz',
  region: 'latam',
  pais: 'BO',
  zona_horaria: 'America/La_Paz',
  moneda: 'BOB',
  plan: 'consultorio',
  doctora: { nombre: 'Andrea', apellido: 'Paz', correo: 'andrea.paz@clinicapaz.bo' },
  nota_interna: 'Vino por el webinar',
};

function codigoDe(ejecutar: () => unknown): string {
  try {
    ejecutar();
  } catch (failure) {
    if (failure instanceof ContractError) return failure.code;
    throw failure;
  }
  throw new Error('no lanzó ningún error del contrato');
}

describe('el alta de una consulta · el cuerpo del contrato', () => {
  it('lee los nueve campos y saca el límite DEL PLAN, no del cuerpo', () => {
    const form = readAdmission(ALTA, 'latam', readEmail);

    expect(form.practice).toEqual({
      name: 'Clínica Paz',
      region: 'latam',
      country: 'BO',
      timeZone: 'America/La_Paz',
      currency: 'BOB',
      plan: 'consultorio',
      // «Plan Consultorio · 148 de 300»: el número sale del catálogo del borde.
      patientLimit: 300,
      internalNote: 'Vino por el webinar',
    });
    expect(form.owner).toEqual({
      firstName: 'Andrea',
      lastName: 'Paz',
      email: 'andrea.paz@clinicapaz.bo',
    });
  });

  it('un `limite_pacientes` en el cuerpo no se lee: el plan manda', () => {
    const form = readAdmission({ ...ALTA, limite_pacientes: 99_999 }, 'latam', readEmail);
    expect(form.practice.patientLimit).toBe(PLAN_LIMITS.consultorio);
  });

  it('la nota interna es opcional y nace nula', () => {
    expect(
      readAdmission({ ...ALTA, nota_interna: undefined }, 'latam', readEmail).practice.internalNote,
    ).toBeNull();
  });

  it('el nombre de la consulta va primero, y con menos de dos letras está vacío', () => {
    expect(codigoDe(() => readAdmission({ ...ALTA, nombre: ' ' }, 'latam', readEmail))).toBe(
      'nombre_vacio',
    );
    expect(codigoDe(() => readAdmission({ ...ALTA, nombre: 'A' }, 'latam', readEmail))).toBe(
      'nombre_vacio',
    );
  });

  it('una región que no existe es `region_desconocida`', () => {
    expect(codigoDe(() => readAdmission({ ...ALTA, region: 'apac' }, 'latam', readEmail))).toBe(
      'region_desconocida',
    );
  });

  it('una región REAL que no es la del despliegue no se crea aquí, y la frase dice dónde', () => {
    // Un despliegue sirve una región y esta petición escribe en ESTA base: «la región no se
    // cambia después» es la decisión más cara de revertir (§7.4).
    let lanzado: ContractError | null = null;
    try {
      readAdmission({ ...ALTA, region: 'eu' }, 'latam', readEmail);
    } catch (failure) {
      lanzado = failure as ContractError;
    }
    expect(lanzado?.code).toBe('region_no_corresponde');
    expect(lanzado?.status).toBe(403);
    expect(lanzado?.userMessage).toBe('Ese token es de otra región. Abre la consola de eu.');
  });

  it('un plan fuera del catálogo es `plan_desconocido`, y el catálogo son tres', () => {
    expect(Object.keys(PLAN_LIMITS)).toEqual(['individual', 'consultorio', 'clinica']);
    expect(codigoDe(() => readAdmission({ ...ALTA, plan: 'premium' }, 'latam', readEmail))).toBe(
      'plan_desconocido',
    );
  });

  it('país, zona horaria y moneda mal formados son `cuerpo_no_valido`', () => {
    expect(codigoDe(() => readAdmission({ ...ALTA, pais: 'Bolivia' }, 'latam', readEmail))).toBe(
      'cuerpo_no_valido',
    );
    expect(
      codigoDe(() =>
        readAdmission({ ...ALTA, zona_horaria: 'America/Inventada' }, 'latam', readEmail),
      ),
    ).toBe('cuerpo_no_valido');
    expect(
      codigoDe(() => readAdmission({ ...ALTA, moneda: 'bolivianos' }, 'latam', readEmail)),
    ).toBe('cuerpo_no_valido');
  });

  it('sin nombre o sin apellido de la doctora, el error nombra SU campo', () => {
    let lanzado: ContractError | null = null;
    try {
      readAdmission(
        { ...ALTA, doctora: { apellido: 'Paz', correo: ALTA.doctora.correo } },
        'latam',
        readEmail,
      );
    } catch (failure) {
      lanzado = failure as ContractError;
    }
    expect(lanzado?.code).toBe('nombre_vacio');
    expect(lanzado?.field).toBe('doctora.nombre');
    expect(lanzado?.userMessage).toBe('Escribe el nombre y el apellido de la doctora.');
  });

  it('un correo que no es un correo —o que falta— es `correo_mal_escrito` sobre su campo', () => {
    for (const correo of ['andrea.paz', '', undefined]) {
      let lanzado: ContractError | null = null;
      try {
        readAdmission({ ...ALTA, doctora: { ...ALTA.doctora, correo } }, 'latam', readEmail);
      } catch (failure) {
        lanzado = failure as ContractError;
      }
      expect(lanzado?.code).toBe('correo_mal_escrito');
      expect(lanzado?.field).toBe('doctora.correo');
    }
  });

  it('un cuerpo que no es un objeto no revienta: es un alta sin nombre', () => {
    expect(codigoDe(() => readAdmission(null, 'latam', readEmail))).toBe('nombre_vacio');
  });
});

describe('la decisión de la licencia · el cuerpo de la consola', () => {
  it('verificar no pide motivo, y el motivo que venga de más no viaja', () => {
    expect(readDecision({ decision: 'verificada', motivo_rechazo: 'lo que sea' })).toEqual({
      status: 'verificada',
      rejectionReason: null,
    });
  });

  it('rechazar EXIGE motivo, de 10 a 300: la doctora lo va a leer', () => {
    expect(codigoDe(() => readDecision({ decision: 'rechazada' }))).toBe('motivo_rechazo_vacio');
    expect(codigoDe(() => readDecision({ decision: 'rechazada', motivo_rechazo: 'corto' }))).toBe(
      'motivo_rechazo_vacio',
    );
    // Y el nulo también, que es el caso que el `CHECK` de la 0000 dejaba pasar: `length(NULL)`
    // es NULL y `false OR NULL` no es `false`. Lo cerró la 0016, y aquí no llega ni a la base.
    expect(codigoDe(() => readDecision({ decision: 'rechazada', motivo_rechazo: null }))).toBe(
      'motivo_rechazo_vacio',
    );

    expect(
      readDecision({ decision: 'rechazada', motivo_rechazo: 'La credencial está vencida.' }),
    ).toEqual({ status: 'rechazada', rejectionReason: 'La credencial está vencida.' });
  });

  it('`revisada_por` del cuerpo se ignora: lo pone el servidor desde el token', () => {
    const decision = readDecision({ decision: 'verificada', revisada_por: 'usr_plt_otra_persona' });
    expect(decision).toEqual({ status: 'verificada', rejectionReason: null });
  });

  it('una decisión que no es ninguna de las dos es `cuerpo_no_valido`', () => {
    expect(codigoDe(() => readDecision({ decision: 'quizas' }))).toBe('cuerpo_no_valido');
    expect(codigoDe(() => readDecision({}))).toBe('cuerpo_no_valido');
  });
});

describe('el correo del alta', () => {
  it('dice la consulta, el correo y la contraseña, y ni una palabra clínica', () => {
    const cuerpo = ownerWelcomeMailBody({
      firstName: 'Andrea',
      email: 'andrea.paz@clinicapaz.bo',
      practiceName: 'Clínica Paz',
      temporaryPassword: 'tejado-lila-07',
      expiryText: 'Caduca el viernes 30 a las 09:12',
    });

    expect(cuerpo).toContain('Clínica Paz');
    expect(cuerpo).toContain('andrea.paz@clinicapaz.bo');
    expect(cuerpo).toContain('tejado-lila-07');
    expect(cuerpo).toContain('Caduca el viernes 30 a las 09:12');
    // Nada de tratamientos, zonas del cuerpo ni pacientes: un correo es lo que se lee en la
    // pantalla bloqueada de un teléfono (§11.1).
    expect(cuerpo).not.toMatch(/tratamiento|paciente|piel/i);
  });
});
