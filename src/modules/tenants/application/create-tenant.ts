// POST /v1/platform/tenants · «MedSkin da de alta una consulta y, en el mismo acto, la
// cuenta de su doctora dueña».
//
// ES LA ÚNICA PUERTA DE ENTRADA DE UNA DOCTORA AL SISTEMA. «Nadie se registra solo» (estado
// del diseño, «Acceso · 27 oct»), y la cuenta que se crea aquí es la única del sistema que no
// crea nadie desde dentro.
//
// TRES REGLAS QUE SE CUMPLEN AQUÍ Y EN NINGÚN OTRO SITIO:
//   1. `limite_pacientes` sale del PLAN y nunca del cuerpo.
//   2. La doctora nace con `licencia.estado = "sin_enviar"` y sin poder invitar pacientes, y
//      esa fila la crea la función del alta (0015): aquí no se inserta.
//   3. `contrasena_temporal` se devuelve UNA SOLA VEZ y solo a la consola, «porque quien da
//      el alta es una persona de MedSkin que tiene que poder leerla si el correo no llega».
//      Ninguna lectura posterior la trae.

import {
  ContractError,
  FAILURE_PHRASES,
  ServiceFailure,
} from '../../../shared/contract/error-catalog';
import type { Region } from '../../../shared/contract/session';
import type { PasswordHasher } from '../../access/domain/ports';
import { readEmail } from '../../recovery/domain/code';
import {
  mintTemporaryPassword,
  temporaryPasswordExpiry,
} from '../../accounts/domain/temporary-password';
import { readAdmission } from '../domain/admission';
import type {
  CreatedTenant,
  IdempotencyRecord,
  PlatformActor,
  Served,
  TenantAdmissionPort,
  WelcomeMailPort,
} from '../domain/platform-ports';

export type CreatedTenantResponse = {
  id: string;
  nombre: string;
  region: string;
  plan: { clave: string; limite_pacientes: number; pacientes: number };
  licencia: { estado: string };
  creado_en: string;
  doctora: {
    cuenta_id: string;
    correo: string;
    contrasena_temporal: string;
    contrasena_temporal_caduca_en: string;
  };
};

/** El reloj que hace falta: la hora y la frase de caducidad del correo. */
export interface AdmissionClock {
  now(): Date;
  localLongWhen(moment: Date): string;
}

/** Lo que el fallo del correo del alta necesita registrar. Nunca la contraseña. */
export interface AdmissionFailureLog {
  record(p: {
    cause: unknown;
    accountId: string;
    practiceId: string;
    region: Region;
    operation: string;
    traceId: string;
    requestId: string;
  }): Promise<void>;
}

/** La traza de la petición, para que la fila del fallo se pueda cruzar con su llamada. */
export type Trace = { traceId: string; requestId: string };

export class CreateTenant {
  constructor(
    private readonly tenants: TenantAdmissionPort,
    private readonly passwords: PasswordHasher,
    private readonly clock: AdmissionClock,
    private readonly mail: WelcomeMailPort,
    private readonly failures: AdmissionFailureLog,
    /** La región del despliegue: una base sirve una región y el cuerpo no la elige. */
    private readonly region: Region,
  ) {}

  async run(
    input: unknown,
    actor: PlatformActor,
    idempotency: IdempotencyRecord,
    trace: Trace,
  ): Promise<Served<CreatedTenantResponse>> {
    const form = readAdmission(input, this.region, readEmail);
    const now = this.clock.now();
    const expiresAt = temporaryPasswordExpiry(now);
    const temporary = mintTemporaryPassword();

    const admission = await this.tenants.create({
      actor,
      idempotency,
      practice: form.practice,
      // Lo que la consola recogió del formulario, o `null`. No cambia el estado de la
      // licencia: la manda a revisar la doctora, desde su app, con su credencial.
      license: form.license,
      owner: { ...form.owner, hash: await this.passwords.hash(temporary), expiresAt },
      // Se ejecuta DENTRO de la transacción del alta: la respuesta que se guarda para el
      // reintento es la MISMA que se devuelve, contraseña temporal incluida.
      respond: (created: CreatedTenant) =>
        this.view(created, form.practice, form.owner.email, temporary, expiresAt),
    });

    switch (admission.verdict) {
      case 'created':
        break;
      // La clave natural de refuerzo del contrato, `(correo_doctora, region)`. Este 409 SÍ
      // revela que el correo existe y está bien: «aquí quien llama es MedSkin sobre su propio
      // padrón, no un desconocido sobre el de una clínica de estética».
      case 'email_taken':
        throw new ContractError('correo_ya_tiene_cuenta');
      // Los dos que la base distingue y el contrato no nombra: no se les inventa un error.
      // `practice_has_owner` solo puede salir de un `INSERT` de `practice` que acabó con
      // dueña puesta —imposible en esta transacción— y `practice_not_found`, de una consulta
      // que esta misma transacción acaba de insertar.
      default:
        throw new ServiceFailure(
          FAILURE_PHRASES.createTenant,
          new Error(`medskin_create_practice_owner devolvió ${admission.verdict}`),
        );
    }

    const served = admission.served;
    if (!served.replayed) {
      await this.sendWelcome({
        response: served.response,
        practiceName: form.practice.name,
        firstName: form.owner.firstName,
        temporaryPassword: temporary,
        expiresAt,
        trace,
      });
    }
    return served;
  }

  /**
   * «El correo del alta sale en el mismo acto. Si el envío falla, la consulta **queda
   * creado** y el fallo va a `service_failure`: la consola tiene "Reenviar la contraseña
   * temporal" para eso.»
   *
   * Por eso este fallo NO se convierte en 500: la frase del 500 de este endpoint promete «no
   * se creó nada», y decirlo cuando la consulta ya existe sería mentirle a quien da el alta.
   * La salida que tiene es la contraseña del 201, que puede leer y dictar.
   *
   * En el reintento idempotente no se vuelve a mandar: el alta ya ocurrió y el correo ya
   * salió, igual que en el alta del equipo.
   */
  private async sendWelcome(p: {
    response: CreatedTenantResponse;
    practiceName: string;
    firstName: string;
    temporaryPassword: string;
    expiresAt: Date;
    trace: Trace;
  }): Promise<void> {
    try {
      await this.mail.sendOwnerWelcome({
        firstName: p.firstName,
        email: p.response.doctora.correo,
        practiceName: p.practiceName,
        temporaryPassword: p.temporaryPassword,
        expiryText: `Caduca el ${this.clock.localLongWhen(p.expiresAt)}`,
      });
    } catch (cause) {
      // Ni el correo ni la contraseña entran en la causa: solo los identificadores (§10.3).
      await this.failures.record({
        cause: new Error('no se pudo mandar el correo del alta de la consulta', { cause }),
        accountId: p.response.doctora.cuenta_id,
        practiceId: p.response.id,
        region: this.region,
        operation: 'POST /v1/platform/tenants',
        traceId: p.trace.traceId,
        requestId: p.trace.requestId,
      });
    }
  }

  private view(
    created: CreatedTenant,
    practice: { name: string; region: string; plan: string; patientLimit: number },
    email: string,
    temporary: string,
    expiresAt: Date,
  ): CreatedTenantResponse {
    return {
      id: created.practiceId,
      nombre: practice.name,
      region: practice.region,
      // `pacientes: 0` no se consulta: una consulta que acaba de nacer no tiene ninguna, y
      // `app_platform` no puede leer `patient` ni para contar.
      plan: { clave: practice.plan, limite_pacientes: practice.patientLimit, pacientes: 0 },
      licencia: { estado: 'sin_enviar' },
      creado_en: created.createdAt.toISOString(),
      doctora: {
        cuenta_id: created.accountId,
        correo: email,
        contrasena_temporal: temporary,
        contrasena_temporal_caduca_en: expiresAt.toISOString(),
      },
    };
  }
}
