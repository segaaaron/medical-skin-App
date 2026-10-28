// POST /v1/plataforma/inquilinos/{id}/licencia/decision · «Aprobar o rechazar la licencia
// revisada a mano».
//
// LA REVISIÓN ES A MANO Y ESTE ENDPOINT ES SU ÚNICA SALIDA: no hay aprobación automática, ni
// por un proveedor, ni por una heurística (`Licencia.dc.html` · 1: «Sin esto cualquiera se
// registra como médico»).
//
// Rechazar NO borra nada ni cierra la sesión: la doctora sigue con su catálogo y sus horarios
// y puede volver a enviar, porque `rechazada` es uno de los dos estados desde los que su
// política le deja escribir el formulario otra vez.

import { ContractError } from '../../../shared/contract/error-catalog';
import { readDecision } from '../domain/admission';
import type {
  DecidedLicense,
  IdempotencyRecord,
  LicenseDecisionPort,
  PlatformActor,
  Served,
} from '../domain/platform-ports';
import { capabilities, hasRoomForPatients, type Capabilities } from '../domain/rules';

export type DecidedLicenseResponse = {
  estado: string;
  decidida_en: string;
  puede: Capabilities;
};

export class DecideLicense {
  constructor(private readonly licenses: LicenseDecisionPort) {}

  async run(
    input: unknown,
    practiceId: string,
    actor: PlatformActor,
    idempotency: IdempotencyRecord,
  ): Promise<Served<DecidedLicenseResponse>> {
    // `revisada_por` se ignora si viene: lo pone el servidor desde el token.
    const decision = readDecision(input);

    const result = await this.licenses.decide({
      actor,
      practiceId,
      decision,
      idempotency,
      // DENTRO de la transacción, con lo que la base acaba de escribir: la respuesta que se
      // guarda para el reintento es la misma que se devuelve.
      respond: (decided: DecidedLicense) => view(decided),
    });

    switch (result.outcome) {
      case 'decided':
        return result.served;
      // Los tres `4xx` que la base distingue. El primero cubre también «esa consulta no
      // existe»: sin fila de licencia no hay nada que decidir, y no se le dice a quien
      // pregunta si el inquilino existe o no.
      case 'no_license':
        throw new ContractError('licencia_no_existe');
      case 'not_submitted':
        throw new ContractError('licencia_sin_enviar');
      default:
        throw new ContractError('licencia_ya_decidida');
    }
  }
}

function view(decided: DecidedLicense): DecidedLicenseResponse {
  return {
    estado: decided.status,
    decidida_en: decided.decidedAt.toISOString(),
    // La MISMA función que las dos pantallas de la doctora, con el estado que acaba de
    // quedar escrito: verificar abre invitar y registrar, y rechazar las deja cerradas.
    // Viajan las cuatro claves —el contrato escribe dos aquí— porque dos formas del mismo
    // campo obligan a la app a llevar dos decodificadores (decisión 46).
    //
    // Y el cupo entra también aquí: una consulta que ya está en su tope recibe
    // `invitar_pacientes: false` el mismo día que se le verifica la licencia, que es la
    // verdad. Decirle `true` haría que la consola le prometiera a la doctora algo que su
    // primera alta de paciente le va a negar.
    puede: capabilities(
      decided.status,
      hasRoomForPatients(decided.activePatients, decided.patientLimit),
    ),
  };
}
