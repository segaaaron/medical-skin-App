// Las reglas del dominio, probadas sin nada alrededor: ni NestJS, ni base, ni Redis. Si
// este archivo necesitara levantar algo, la capa estaría mal cortada.

import { describe, expect, it } from 'vitest';

import { isCommonPassword } from './common-passwords';
import { resolveNextStep } from './next-step';
import { checkNewPassword, MIN_LENGTH } from './password-rules';
import { PERMISSIONS_BY_ROLE, resolvePermissions, resolveRole } from './role';

describe('resolveRole · el `rol` que viaja al cliente', () => {
  it('una cuenta de doctor sale como `doctor`', () => {
    expect(resolveRole('doctor', 'doctor')).toBe('doctor');
  });

  it('una cuenta de paciente es `patient`, aunque no tenga fila de consulta', () => {
    expect(resolveRole('patient', null)).toBe('patient');
  });

  it('una cuenta de doctor sin fila de consulta no tiene rol: devuelve null', () => {
    // No se inventa uno. Quien llama lo convierte en 500 con su causa real.
    expect(resolveRole('doctor', null)).toBeNull();
  });
});

describe('resolvePermissions', () => {
  it('la lista explícita gana sobre la del rol', () => {
    // Es el mecanismo que queda para acotar a alguien: «permisos como interruptores, no
    // como roles», que es lo que el estado del diseño pedía.
    expect(resolvePermissions('doctor', ['agenda:leer'])).toEqual(['agenda:leer']);
  });

  it('una lista explícita vacía es una lista vacía, no «los de su rol»', () => {
    // Nulo significa «los de su rol»; vacío significa «ninguno», y son dos cosas.
    expect(resolvePermissions('doctor', [])).toEqual([]);
  });

  it('nulo resuelve los del rol', () => {
    expect(resolvePermissions('doctor', null)).toEqual(PERMISSIONS_BY_ROLE.doctor);
  });

  it('el paciente no tiene permisos de consulta', () => {
    expect(resolvePermissions('patient', null)).toEqual([]);
  });

  it('el doctor puede crear pacientes y registrar sesiones', () => {
    expect(PERMISSIONS_BY_ROLE.doctor).toContain('pacientes:crear');
    expect(PERMISSIONS_BY_ROLE.doctor).toContain('sesiones:registrar');
    expect(PERMISSIONS_BY_ROLE.doctor).toContain('historia:leer');
  });

  it('ya no hay permisos de equipo: los endpoints que los pedían se fueron', () => {
    expect(PERMISSIONS_BY_ROLE.doctor).not.toContain('equipo:crear');
    expect(PERMISSIONS_BY_ROLE.doctor).not.toContain('equipo:permisos');
  });
});

describe('resolveNextStep · el servidor manda el paso', () => {
  const nada = { passwordIsTemporary: false, licenseStatus: null, firstDayDone: true };

  it('la contraseña temporal gana sobre todo lo demás', () => {
    expect(
      resolveNextStep('doctor', {
        passwordIsTemporary: true,
        licenseStatus: 'sin_enviar',
        firstDayDone: false,
      }),
    ).toBe('contrasena_nueva');
  });

  it('la licencia sin enviar manda a `licencia`', () => {
    expect(
      resolveNextStep('doctor', { ...nada, licenseStatus: 'sin_enviar', firstDayDone: false }),
    ).toBe('licencia');
  });

  it('con la licencia en revisión y el primer día a medias, va a `primer_dia`', () => {
    expect(
      resolveNextStep('doctor', { ...nada, licenseStatus: 'en_revision', firstDayDone: false }),
    ).toBe('primer_dia');
  });

  it('todo en orden es `inicio`', () => {
    expect(resolveNextStep('doctor', { ...nada, licenseStatus: 'aprobada' })).toBe('inicio');
  });

  it('nunca devuelve `segundo_factor`: va apagado en esta entrega', () => {
    const pasos = (['doctor', 'doctor', 'doctor', 'patient'] as const).flatMap(
      (rol) =>
        [true, false].flatMap((temporal) =>
          ['sin_enviar', 'en_revision', 'aprobada', null].flatMap((licencia) =>
            [true, false].map((primerDia) =>
              resolveNextStep(rol, {
                passwordIsTemporary: temporal,
                licenseStatus: licencia,
                firstDayDone: primerDia,
              }),
            ),
          ),
        ),
    );
    expect(pasos).not.toContain('segundo_factor');
  });

  it('una paciente con su contraseña definitiva va a `inicio` hasta el tramo 2', () => {
    // `vincular` y `ficha_medica` dependen de `patient_link`, que no existe todavía.
    expect(resolveNextStep('patient', { ...nada, licenseStatus: 'sin_enviar' })).toBe('inicio');
  });
});

describe('checkNewPassword · 8 o más y no de las usadas, y nada de composición', () => {
  it('rechaza menos de 8 con contrasena_corta', () => {
    expect(() => checkNewPassword('a'.repeat(MIN_LENGTH - 1))).toThrowError(/contrasena_corta/);
  });

  it('rechaza lo que no es una cadena', () => {
    expect(() => checkNewPassword(undefined)).toThrowError(/contrasena_corta/);
    expect(() => checkNewPassword(12345678)).toThrowError(/contrasena_corta/);
  });

  it('cuenta puntos de código: ocho emojis valen', () => {
    expect(checkNewPassword('🌵🌵🌵🌵🌵🌵🌵🌵')).toBe('🌵🌵🌵🌵🌵🌵🌵🌵');
  });

  it('rechaza las más usadas, sin importar mayúsculas', () => {
    expect(() => checkNewPassword('PASSWORD')).toThrowError(/contrasena_muy_usada/);
    expect(() => checkNewPassword('contraseña')).toThrowError(/contrasena_muy_usada/);
  });

  it('acepta una frase sin mayúscula, sin número y sin símbolo', () => {
    expect(checkNewPassword('tejadolila')).toBe('tejadolila');
  });

  it('la lista incluye las variantes en español que una lista en inglés no trae', () => {
    expect(isCommonPassword('teamo')).toBe(true);
    expect(isCommonPassword('clave123')).toBe(true);
    expect(isCommonPassword('tejado-lila-07')).toBe(false);
  });
});
