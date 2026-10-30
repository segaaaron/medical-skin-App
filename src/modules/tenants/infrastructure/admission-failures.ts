// El fallo del correo del alta, registrado SIN convertirlo en un 500.
//
// `consultas.md`: «Si el envío falla, la consulta **queda creado** y el fallo va a
// `service_failure`: la consola tiene "Reenviar la contraseña temporal" para eso». Así que
// este es el único camino del módulo que escribe una fila de fallo sin que el filtro global
// lo haga: el filtro solo ve lo que se lanza, y aquí no se lanza nada.
//
// La fila se escribe con el contexto de la DOCTORA recién creada —su cuenta y su consulta—,
// que es de quien es el correo que no salió. La persona de plataforma no tiene fila en
// `account` y `service_failure.actor_id` es un `uuid` de esta región: poner ahí el `sub` del
// token sería un identificador que no apunta a nada, y el dato útil para arreglarlo es a
// quién no le llegó su contraseña.

import type { FailureLog } from '../../../shared/failures/service-failure';
import type { AdmissionFailureLog } from '../application/create-tenant';

/** Lo lee la consola, no las apps: no es un `codigo` del catálogo (decisión 35). */
const ERROR_CODE = 'correo_del_alta_no_salio';

export class AdmissionFailures implements AdmissionFailureLog {
  constructor(private readonly failures: FailureLog) {}

  async record(p: {
    cause: unknown;
    accountId: string;
    practiceId: string;
    region: 'eu' | 'us' | 'latam';
    operation: string;
    traceId: string;
    requestId: string;
  }): Promise<void> {
    // `FailureLog.record()` nunca lanza (§10.3, regla 6): un fallo al registrar un fallo no
    // puede tirar un alta que ya ocurrió.
    await this.failures.record({
      service: 'api',
      operation: p.operation,
      // `warning` y no `error`: la consulta está creada y la consola tiene la contraseña en
      // la mano para dictarla, así que esto se mira, no despierta a nadie.
      severity: 'warning',
      errorCode: ERROR_CODE,
      cause: p.cause,
      traceId: p.traceId,
      requestId: p.requestId,
      appVersion: null,
      platform: null,
      region: p.region,
      context: { accountId: p.accountId, practiceId: p.practiceId, accountRole: 'doctor' },
    });
  }
}
