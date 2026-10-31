// GET /v1/session · «Comprobar la sesión al arrancar y saber qué pantalla toca».
//
// Es la llamada de `Arranque.dc.html` · 1, así que tiene una obligación de rendimiento y
// no solo de forma: UNA transacción, UNA lectura, y **nada clínico** — ni pacientes, ni
// citas, ni nada que haya que buscar.
//
// Dos reglas del contrato que se cumplen aquí y en ningún otro sitio:
//
//   1. Devuelve SIEMPRE la lista de permisos resuelta, NUNCA el rol a secas. «La app no
//      deduce permisos del rol», y por eso quien resuelve es el servidor: la lista
//      explícita de `practitioner.permissions` si la hay, y la de su rol si es nula —que
//      es el 100 % de las filas de la primera entrega.
//   2. Dice la verdad sobre el ALCANCE DEL TOKEN que llegó, no sobre el de la fila. Con la
//      contraseña todavía temporal el alcance es restringido y de aquí saca la app que
//      tiene que abrir «Crea tu contraseña». Si devolviera el alcance de la fila —que
//      `contrasena-nueva` asciende a `completo` en su propia transacción— la app abriría
//      el inicio con un token que el guardia sigue rechazando por restringido.

import {
  ContractError,
  FAILURE_PHRASES,
  ServiceFailure,
} from '../../../shared/contract/error-catalog';
import type { NextStep, Region, Role, Scope } from '../../../shared/contract/session';
import type { Caller } from '../../access/application/caller';
import { resolveNextStep } from '../../access/domain/next-step';
import { resolvePermissions } from '../../access/domain/role';
import type { SessionSnapshotPort } from '../domain/ports';

export type SessionView = {
  sesion_id: string;
  cuenta_id: string;
  rol: Role;
  alcance: Scope;
  region: Region;
  siguiente_paso: NextStep;
  /** Nulo para una paciente: su cuenta no pertenece a ninguna consulta. */
  consulta: { id: string; nombre: string } | null;
  permisos: readonly string[];
  segundo_factor: { activo: boolean; obligatorio_desde: string | null };
  token_caduca_en: string;
  /** Nulo cuando la sesión no tiene refresco, que es el alcance restringido. */
  refresco_caduca_en: string | null;
};

export class ReadSession {
  constructor(private readonly snapshots: SessionSnapshotPort) {}

  /**
   * `tokenExpiresAt` es el `exp` del token que llegó, y entra como argumento porque es del
   * borde: el caso de uso no verifica firmas.
   */
  async run(caller: Caller, tokenExpiresAt: Date): Promise<SessionView> {
    const snapshot = await this.snapshots.read({
      accountId: caller.accountId,
      sessionId: caller.sessionId,
      practiceId: caller.practiceId,
      accountRole: caller.accountRole,
    });

    // Un `sid` sin fila es una cadena rota, que es lo que `token_no_valido` cubre: la app
    // borra lo local y va a «Entra a MedSkin». No se distingue de una firma mala a
    // propósito, igual que el 404 de cerrar una sesión ajena no se distingue de una
    // inventada.
    if (snapshot === null) throw new ContractError('token_no_valido');

    // Revocada antes que suspendida: la pregunta que la app hizo es «¿sigue viva esta
    // sesión?», y la respuesta es que no. La suspensión la vuelve a encontrar al entrar,
    // que es donde el 403 tiene pantalla. Y es el único sitio del tramo donde
    // `session.revoked_at` se mira: el guardia no lo consulta a propósito, porque el token
    // vive 15 min y eso es la cota que `sesion.md` eligió en vez de un viaje a la base por
    // petición.
    if (snapshot.revokedAt !== null) throw new ContractError('sesion_revocada');
    if (snapshot.accountStatus !== 'activa') throw new ContractError('cuenta_suspendida');

    // Un token que dice consulta y una consulta que no se puede leer es una
    // inconsistencia del servidor, no una sesión inválida: va a `service_failure` con su
    // causa real y la app se queda en el splash. Inventar `consulta: null` para una
    // doctora sería devolverle una respuesta que su pantalla no sabe pintar.
    if (caller.accountRole === 'doctor' && snapshot.practice === null) {
      throw new ServiceFailure(
        FAILURE_PHRASES.readSession,
        new Error(`la sesión ${caller.sessionId} dice consulta y no hay consulta que leer`),
      );
    }

    return {
      sesion_id: caller.sessionId,
      cuenta_id: caller.accountId,
      rol: caller.role,
      alcance: caller.scope,
      region: caller.region,
      siguiente_paso: this.nextStep(caller, snapshot.licenseDeclared, snapshot.firstDayDone),
      consulta:
        snapshot.practice === null
          ? null
          : { id: snapshot.practice.id, nombre: snapshot.practice.name },
      permisos: resolvePermissions(caller.role, snapshot.permissions ?? null),
      // Apagado en la primera entrega, y escrito así a propósito: `sesion.md` deja
      // `POST /v1/session/segundo-factor` en `propuesto` —«el segundo factor existe en el
      // contrato y está apagado», `segundo_factor.activo = false`— y el campo viaja igual
      // para que la app pueda recibirlo el día que se encienda sin cambiar de forma.
      segundo_factor: { activo: false, obligatorio_desde: null },
      token_caduca_en: tokenExpiresAt.toISOString(),
      refresco_caduca_en: snapshot.refreshExpiresAt?.toISOString() ?? null,
    };
  }

  /**
   * El MISMO campo y la misma lista que `POST /v1/access`, y por eso la misma función: «la
   * app lo lee en cada arranque, no solo al entrar», así que la matrícula declarada desde
   * otro teléfono mueve a la doctora de `licencia` sin que haga nada en este.
   *
   * «La contraseña sigue siendo la temporal» se lee del ALCANCE y no de la credencial: el
   * alcance restringido ES esa situación, y leer `credential` otra vez sería una consulta
   * más en la llamada que tiene presupuesto de 3 s.
   */
  private nextStep(caller: Caller, licenseDeclared: boolean, firstDayDone: boolean): NextStep {
    return resolveNextStep(caller.role, {
      passwordIsTemporary: caller.scope === 'contrasena_temporal',
      licenseDeclared,
      firstDayDone,
    });
  }
}
