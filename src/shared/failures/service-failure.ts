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
  /**
   * `plataforma` es el TERCER actor y no un `AccountRole`: quien llama desde la consola no
   * tiene fila en `account` —su identidad vive fuera de la región— y su `accountId` es el
   * `sub` del token, que es un `uuid` (decisión del 28 de octubre). Cabe en
   * `service_failure.actor_id` por lo mismo que en `license.reviewed_by` y en
   * `access_audit.actor_account_id`: esas columnas no tienen clave foránea, a propósito.
   *
   * Existe porque **un 500 de la consola tiene que decir quién lo pidió**: es soporte
   * actuando sobre la cuenta de una paciente, y la bitácora es lo único que hace revisable
   * lo que soporte hace. Sin esto el fallo entraba por el camino anónimo y la fila quedaba
   * sin actor, que es justamente el caso que alguien querría no dejar registrado.
   */
  accountRole: AccountRole | 'plataforma';
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

/**
 * EL CORREO SE TAPA EN LAS DOS RUTAS, no solo en la anónima. El mensaje del motor es la
 * causa real y por eso se guarda; lo que no puede guardarse es una dirección dentro de él, y
 * las hay en los dos lados: «Key (email)=(…) already exists» en la ruta sin sesión, y el
 * rechazo de un relé —«550 5.1.1 <carla@…> User unknown»— en la ruta CON sesión, que es la
 * del envío del acceso. El patrón es el MISMO que el de `medskin_record_anonymous_failure`
 * (migraciones 0004 y 0005), y se aplica donde se aplica allí: el mensaje, la cadena de
 * causas y la pila.
 *
 * Va como parámetro y no como literal en el SQL por la regla de siempre: lo que entra en una
 * consulta, entra parametrizado (OWASP A03).
 */
const EMAIL_PATTERN = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}';
const EMAIL_MASK = '[correo]';

/**
 * El rol de base con el que se escribe la fila, y es el de quien llama: cada uno entra por
 * su propia política y ninguno adopta el rol de otro para registrar un fallo. La consola es
 * `app_platform`, cuya política de `service_failure` es `FOR ALL` desde la 0001; la paciente
 * no fija consulta porque no pertenece a ninguno.
 */
function roleOf(where: FailureContext): TenantContext {
  if (where.accountRole === 'plataforma') {
    // Sin `practiceId`: la consola cruza consultas y sus políticas no son por consulta. La
    // columna `practice_id` de la fila queda nula, que es la verdad — el fallo es de una
    // petición de soporte, no de la consulta sobre la que miraba.
    return { role: 'app_platform', accountId: where.accountId };
  }
  if (where.accountRole === 'patient') {
    return { role: 'app_patient', accountId: where.accountId };
  }
  return { role: 'app_practitioner', accountId: where.accountId, practiceId: where.practiceId };
}

type CauseLink = { name: string; message: string };

function causeChain(cause: unknown): CauseLink[] {
  const chain: CauseLink[] = [];
  let current: unknown = cause;
  // Tope de cinco: una cadena circular no cuelga el registro del fallo.
  for (let i = 0; i < 5 && current instanceof Error; i += 1) {
    chain.push({ name: current.name, message: messageOf(current) });
    current = current.cause;
  }
  if (chain.length === 0) chain.push({ name: 'Desconocido', message: String(cause) });
  return chain;
}

/**
 * UN `Error` CON MENSAJE VACÍO EXISTE, y hacía invisible el fallo entero: `AggregateError`
 * —el que lanza Node cuando fallan todas las direcciones de una conexión, así que el que da
 * un Postgres o un Redis caídos— trae `message: ''`, y
 * `medskin_record_anonymous_failure()` rechaza la causa vacía («operacion, codigo, causa y
 * traza son obligatorios»). Resultado: la fila no se escribía y el fallo salía solo por la
 * salida de error. Encontrado el 28 de octubre probando el barrido contra un puerto muerto.
 *
 * El nombre no es gran cosa, pero es verdad y es suficiente para que la fila exista: la pila
 * y el resto de la cadena viajan igual.
 */
function messageOf(error: Error): string {
  return error.message === '' ? error.name : error.message;
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
      // Un 500 de una petición SIN sesión —`POST /v1/access`, los dos de recuperación, el
      // refresco— no tiene consulta ni actor que escribir, y `app_anonymous` no tiene
      // `INSERT` sobre `service_failure`. Va por `medskin_record_anonymous_failure()`,
      // que es `SECURITY DEFINER`, escribe las doce columnas que no necesitan contexto y
      // TAPA LA DIRECCIÓN DE CORREO del mensaje del motor: «Key (email)=(…) already
      // exists» es el único dato personal que una petición sin sesión tiene en la mano.
      // Cierra la pregunta 18 de `preguntas-abiertas.md` (migraciones 0004 y 0005).
      await this.recordAnonymous(failure, chain, first);
      return;
    }

    const where = failure.context;
    const ctx: TenantContext = roleOf(where);

    try {
      await withTenantContext(this.pool, ctx, (c) =>
        c.query(
          // Los tres campos de texto libre pasan por el enmascarado; los demás son
          // identificadores y etiquetas cerradas, donde no cabe una dirección.
          `insert into service_failure (service, operation, severity, error_code, error_message,
                                        cause_chain, stack, practice_id, actor_id, trace_id,
                                        request_id, app_version, platform, region, will_retry)
           values ($1, $2, $3, $4,
                   regexp_replace($5, $15, $16, 'g'),
                   regexp_replace($6, $15, $16, 'g')::jsonb,
                   regexp_replace($7, $15, $16, 'g'),
                   $8, $9, $10, $11, $12, $13, $14, false)`,
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
            EMAIL_PATTERN,
            EMAIL_MASK,
          ],
        ),
      );
    } catch (whileRecording) {
      this.toStderr(failure, first, whileRecording);
    }
  }

  /**
   * El fallo de una petición sin sesión. `app_anonymous` NO fija ningún contexto —cuando
   * llega la petición no hay sesión— y su único privilegio es `EXECUTE`: aquí, de esta
   * función y nada más.
   */
  private async recordAnonymous(
    failure: Failure,
    chain: CauseLink[],
    first: CauseLink,
  ): Promise<void> {
    try {
      await withTenantContext(this.pool, { role: 'app_anonymous' }, (c) =>
        c.query(
          'select medskin_record_anonymous_failure($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [
            failure.operation,
            failure.errorCode,
            first.message,
            failure.traceId,
            JSON.stringify(chain),
            failure.cause instanceof Error ? (failure.cause.stack ?? null) : null,
            failure.requestId,
            failure.platform,
            failure.region,
          ],
        ),
      );
    } catch (whileRecording) {
      this.toStderr(failure, first, whileRecording);
    }
  }

  /**
   * La última red: si ni la tabla ni la función se pueden escribir, el fallo sale por la
   * salida de error del proceso, que es lo que el recolector de registros del despliegue
   * ya lee. Nunca se traga (§10.3, regla 5) y nunca lanza (regla 6): un fallo al registrar
   * un fallo no convierte un 500 en dos.
   */
  private toStderr(failure: Failure, first: CauseLink, whileRecording: unknown): void {
    process.stderr.write(
      `${JSON.stringify({
        nivel: 'critical',
        mensaje: 'no se pudo registrar el fallo en service_failure',
        operation: failure.operation,
        error_code: failure.errorCode,
        error_message: first.message,
        al_registrar:
          whileRecording instanceof Error ? whileRecording.message : String(whileRecording),
        trace_id: failure.traceId,
      })}\n`,
    );
  }
}
