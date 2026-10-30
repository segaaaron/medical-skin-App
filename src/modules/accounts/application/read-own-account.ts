// GET /v1/accounts/mine · quién soy, qué rol tengo y QUÉ PANTALLA TOCA.
//
// Es el único endpoint que una sesión con la contraseña todavía temporal puede llamar aparte
// de `POST /v1/access/new-password` (`sesion.md` · `siguiente_paso`), así que es lo
// primero que piden las dos apps al arrancar.
//
// EL `rol` SE LEE, NO SE PIDE: no hay pantalla de «¿eres doctora o paciente?» y ningún
// endpoint de este tramo acepta un rol para autenticar. Para doctora y equipo sale de
// `practitioner.role` DE ESTA CONSULTA y nunca de `account.role`, que vale `practitioner`
// para las tres y no dice nada que una app pueda usar (_convenciones.md).

import {
  FAILURE_PHRASES,
  ServiceFailure,
} from '../../../shared/contract/error-catalog';
import type { NextStep, Region, Role } from '../../../shared/contract/session';
import type { Caller } from '../../access/application/caller';
import { resolveNextStep } from '../../access/domain/next-step';
import type { NextStepFacts, OwnerOfSessions } from '../../access/domain/ports';
import { resolveRole } from '../../access/domain/role';
import type { AccountOwner, LinkedPractice, OwnProfilePort } from '../domain/ports';

/**
 * Lo único que hace falta del acceso: el estado de la consulta que decide `siguiente_paso` y
 * el `practitioner.role` de quien pregunta, que se leen en la MISMA consulta. Es el puerto
 * que ya existe (`SessionPort.nextStepFacts`) y no una segunda consulta que diga lo mismo:
 * si fueran dos, un día la licencia o la lista del primer día cambiarían en una sola.
 */
export interface PractitionerFactsPort {
  nextStepFacts(owner: OwnerOfSessions): Promise<NextStepFacts>;
}

export type LinkedPracticeResponse = {
  practice_id: string;
  nombre: string;
  consulta: string;
  desde: string;
  vinculo: string;
};

export type OwnAccountResponse = {
  cuenta_id: string;
  rol: Role;
  nombre: string;
  apellido: string;
  correo: string;
  celular: string | null;
  estado: string;
  contrasena_es_temporal: boolean;
  siguiente_paso: NextStep;
  region: Region;
  doctoras: readonly LinkedPracticeResponse[];
};

export class ReadOwnAccount {
  constructor(
    private readonly accounts: OwnProfilePort,
    private readonly facts: PractitionerFactsPort,
  ) {}

  async run(caller: Caller): Promise<OwnAccountResponse> {
    // Una sesión que todavía no eligió su contraseña corre con `app_account`: llega a su
    // cuenta, a su credencial y a sus vínculos, y a nada más. No se le dan los privilegios
    // de `app_practitioner` para servir una lectura (§5.6 del napkin).
    const restricted = caller.scope !== 'completo';
    const isPatient = caller.role === 'patient';

    const profile = await this.accounts.readProfile({
      owner: ownerOf(caller),
      restricted,
      // La lista de doctoras es de una paciente. «Para una cuenta de equipo sale siempre
      // vacía, incluso si esa misma persona es paciente de otra consulta» (28 de octubre):
      // servir el `rol` exige `app_practitioner`, que lee `patient_link` por `practice_id`,
      // y preguntarle por ella devolvería las fichas de la consulta en vez de las suyas.
      withLinks: isPatient,
    });
    if (profile === null) {
      // El token apunta a una cuenta que no tiene fila que servir. No se inventa una
      // respuesta: es una inconsistencia del servidor y va a `service_failure` con su causa.
      throw new ServiceFailure(
        FAILURE_PHRASES.readOwnAccount,
        new Error(`la cuenta ${caller.accountId} no tiene fila que servir`),
      );
    }

    const facts = isPatient || restricted ? null : await this.facts.nextStepFacts(ownerOf(caller));
    const rol = this.roleOf(caller, facts);

    return {
      cuenta_id: caller.accountId,
      rol,
      nombre: profile.firstName,
      apellido: profile.lastName,
      correo: profile.email,
      celular: profile.phone,
      estado: profile.status,
      contrasena_es_temporal: profile.passwordIsTemporary,
      // «Mientras la contraseña siga siendo la temporal, no se abre ninguna otra pantalla»:
      // el orden lo decide la misma función que lo decide al entrar, y no una copia.
      siguiente_paso: resolveNextStep(rol, {
        passwordIsTemporary: profile.passwordIsTemporary,
        licenseStatus: facts?.licenseStatus ?? null,
        firstDayDone: facts?.firstDayDone ?? true,
      }),
      region: profile.region,
      doctoras: profile.doctoras.map(toResponse),
    };
  }

  /**
   * El `rol` de la respuesta. Con alcance completo sale de la fila de `practitioner` de esta
   * consulta; con una sesión restringida sale de la reclamación del token, que es la ÚNICA
   * vía: `app_account` no tiene política en `practitioner` y no la va a tener por una
   * pantalla que solo sirve para ir a «Crea tu contraseña». Ese valor no lo escribió el
   * cliente —lo firmó este servidor al entrar, leyéndolo de esa misma fila—.
   */
  private roleOf(caller: Caller, facts: NextStepFacts | null): Role {
    if (facts === null) return caller.role;
    const rol = resolveRole('doctor', facts.practitionerRole);
    if (rol === null) {
      throw new ServiceFailure(
        FAILURE_PHRASES.readOwnAccount,
        new Error(`la cuenta ${caller.accountId} no tiene fila de consulta activa que dé rol`),
      );
    }
    return rol;
  }
}

function toResponse(link: LinkedPractice): LinkedPracticeResponse {
  return {
    practice_id: link.practiceId,
    nombre: link.practitionerName,
    consulta: link.practiceName,
    desde: link.since,
    vinculo: link.status,
  };
}

function ownerOf(caller: Caller): AccountOwner {
  return {
    accountId: caller.accountId,
    practiceId: caller.practiceId,
    accountRole: caller.accountRole,
    sessionId: caller.sessionId,
  };
}
