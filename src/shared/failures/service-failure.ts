// `service_failure` · todo 500 se registra con LA CAUSA REAL DEL MOTOR, y la respuesta
// lleva la frase que el contrato del endpoint tiene escrita. Dos cosas distintas: lo que
// se guarda es para arreglarlo, lo que se devuelve es para la persona.
//
// §10.3 y el punto 9 de OWASP: NUNCA se registra una contraseña, un token, un código, una
// foto ni una nota clínica. Lo que entra aquí son identificadores y el mensaje del motor.

import type { Pool } from 'pg';

import type { AccountRole } from '../contract/session';
import { withTenantContext, type TenantContext } from '../db/tenant-context';

export type FailureContext = {
  accountId: string;
  practiceId: string | null;
  accountRole: AccountRole;
};

export type Failure = {
  service: string;
  operation: string;
  severity: 'warning' | 'error' | 'critical';
  errorCode: string;
  cause: unknown;
  traceId: string;
  requestId: string;
  appVersion: string | null;
  platform: string | null;
  region: string | null;
  /** Nulo en las peticiones sin sesión: todavía no se sabe quién llama. */
  context: FailureContext | null;
};

type CauseLink = { name: string; message: string };

function causeChain(cause: unknown): CauseLink[] {
  const chain: CauseLink[] = [];
  let current: unknown = cause;
  // Tope de cinco: una cadena circular no cuelga el registro del fallo.
  for (let i = 0; i < 5 && current instanceof Error; i += 1) {
    chain.push({ name: current.name, message: current.message });
    current = current.cause;
  }
  if (chain.length === 0) chain.push({ name: 'Desconocido', message: String(cause) });
  return chain;
}

export class FailureLog {
  constructor(private readonly pool: Pool) {}

  /**
   * Nunca lanza: §10.3, regla 6 — el registro de fallos no puede ser el punto único de
   * falla, y un fallo al registrar un fallo no convierte un 500 en dos.
   */
  async record(failure: Failure): Promise<void> {
    const chain = causeChain(failure.cause);
    const first = chain[0] ?? { name: 'Desconocido', message: 'sin causa' };

    if (failure.context === null) {
      // LÍMITE CONOCIDO: `app_anonymous` no tiene `INSERT` sobre `service_failure` —su
      // único privilegio es `EXECUTE` de las funciones del acceso— y `withTenantContext()`
      // exige `accountId` para los otros tres roles. Así que un 500 de una petición SIN
      // sesión (`POST /v1/acceso`, los dos de recuperación, el refresco) no tiene fila
      // donde ir todavía. Va a la salida de error del proceso, que es lo que el recolector
      // de registros del despliegue ya lee, y queda reportado a `datos-senior`: hace falta
      // un `GRANT INSERT ON service_failure TO app_anonymous` con su política, o una
      // función `SECURITY DEFINER` que escriba la fila. No se inventa un `account_id`
      // falso para colarla.
      process.stderr.write(
        `${JSON.stringify({
          nivel: failure.severity,
          service: failure.service,
          operation: failure.operation,
          error_code: failure.errorCode,
          error_message: first.message,
          cause_chain: chain,
          trace_id: failure.traceId,
          request_id: failure.requestId,
          sin_contexto: 'app_anonymous no puede escribir en service_failure',
        })}\n`,
      );
      return;
    }

    const where = failure.context;
    const ctx: TenantContext =
      where.accountRole === 'paciente'
        ? { role: 'app_patient', accountId: where.accountId }
        : {
            role: 'app_practitioner',
            accountId: where.accountId,
            practiceId: where.practiceId,
          };

    try {
      await withTenantContext(this.pool, ctx, (c) =>
        c.query(
          `insert into service_failure (service, operation, severity, error_code, error_message,
                                        cause_chain, stack, practice_id, actor_id, trace_id,
                                        request_id, app_version, platform, region, will_retry)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, false)`,
          [
            failure.service,
            failure.operation,
            failure.severity,
            failure.errorCode,
            first.message,
            JSON.stringify(chain),
            failure.cause instanceof Error ? (failure.cause.stack ?? null) : null,
            where.practiceId,
            where.accountId,
            failure.traceId,
            failure.requestId,
            failure.appVersion,
            failure.platform,
            failure.region,
          ],
        ),
      );
    } catch (whileRecording) {
      process.stderr.write(
        `${JSON.stringify({
          nivel: 'critical',
          mensaje: 'no se pudo registrar el fallo en service_failure',
          error_message: first.message,
          al_registrar:
            whileRecording instanceof Error ? whileRecording.message : String(whileRecording),
          trace_id: failure.traceId,
        })}\n`,
      );
    }
  }
}
