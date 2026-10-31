// POST /v1/patients · la doctora da de alta a una paciente: su ficha y su cuenta, en un
// solo acto. ES LA ÚNICA PUERTA DE UNA PACIENTE AL SISTEMA («nadie se registra solo»).
//
// Lo contratan dos archivos a la vez y ninguno cambia la forma del otro: `cuentas.md` pone
// la cuenta, el acceso y la idempotencia; `pacientes.md` pone lo que lleva dentro
// `antes_de_atenderla`, que es clínico y se guarda con `fuente: doctora`.
//
// EL ORDEN DE LAS COMPROBACIONES ES PARTE DEL ENDPOINT, y lo es por una razón concreta:
// todos los 400 se contestan ANTES de tocar la base, así que un cuerpo mal escrito no crea
// nada, no gasta el límite de altas y no puede usarse para medir si un correo existe. El
// `celular_necesario_para_whatsapp` va con ellos por lo mismo que en el reenvío: crear la
// ficha para después devolver un 400 le cobraría a la doctora un error corregible.
//
// EL INVARIANTE DEL ACCESO, el mismo de `send-patient-access.ts`: para cada vía, o se
// entregó un mensaje, o la contraseña viaja en la respuesta. Nunca ninguna de las dos.
//   · `correo`   → lo manda MedSkin aquí mismo y `contrasena_temporal` va en nulo;
//   · `whatsapp` → MedSkin no manda nada por ella (`enviado: false`) y devuelve el `wa.me`
//                  armado con la temporal dentro, que es la concesión escrita del contrato;
//   · `ninguna`  → la doctora eligió dárselo en persona, así que la temporal viaja;
//   · `ya_tiene_cuenta` → no se acuñó ninguna temporal porque ella ya tiene la suya, así
//                  que no hay nada que entregar ni nada que caducar.

import {
  ContractError,
  FAILURE_PHRASES,
  ServiceFailure,
} from '../../../shared/contract/error-catalog';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import type { Caller } from '../../access/application/caller';
import type { PasswordHasher } from '../../access/domain/ports';
import {
  temporaryTravelsTo,
  whatsappText,
  whatsappTextForExistingAccount,
  whatsappUrl,
  type DeliveryChannel,
  type DeliveryFacts,
} from '../domain/access-delivery';
import {
  PATIENT_CREATE_PERMISSION,
  ageOn,
  calendarDay,
  readRegistration,
  writtenFields,
  type PatientFicha,
} from '../domain/patient-registration';
import type {
  AccountOwner,
  DuplicatePatient,
  IdempotencyCompletionPort,
  PatientAccessMailPort,
  PatientLinkNoticeMailPort,
  PatientCreationLimitPort,
  PatientRegistration,
  PatientRegistrationPort,
} from '../domain/ports';
import { mintTemporaryPassword, temporaryPasswordExpiry } from '../domain/temporary-password';
import type { DeliveryClock } from './send-patient-access';

/** El reloj del acceso más el día en palabras, que es lo que la frase del duplicado lleva. */
export interface RegistrationClock extends DeliveryClock {
  /** «3 de agosto», en la zona del despliegue. */
  localDay(moment: Date): string;
}

/**
 * El bloque `acceso` del 201. Es el de `cuentas.md` con dos campos que pueden ser nulos, y
 * lo son en un solo caso: `ya_tiene_cuenta`, donde no se acuñó ninguna temporal y por lo
 * tanto no hay nada que caduque. Devolver una fecha ahí sería inventarse una caducidad.
 */
export type PatientAccessBlock = {
  via: DeliveryChannel | 'ya_tiene_cuenta';
  enviado: boolean;
  contrasena_temporal: string | null;
  caduca_en: string | null;
  caduca_en_texto: string | null;
  whatsapp?: { numero: string; texto: string; url: string };
};

export type PatientRegisteredResponse = {
  paciente_id: string;
  cuenta_id: string;
  nombre_completo: string;
  edad: number;
  vinculo: { estado: string; correo: string };
  acceso: PatientAccessBlock;
};

export class RegisterPatient {
  constructor(
    private readonly patients: PatientRegistrationPort,
    private readonly passwords: PasswordHasher,
    private readonly limit: PatientCreationLimitPort,
    private readonly idempotency: IdempotencyCompletionPort,
    private readonly clock: RegistrationClock,
    // LOS DOS PUERTOS DEL CORREO, que `PatientAccessMail` implementa en una sola clase: el
    // del acceso con contraseña y el del aviso sin ninguna. Pequeños y separados porque el
    // reenvío solo necesita el primero y nunca puede mandar el segundo.
    private readonly mail: PatientAccessMailPort & PatientLinkNoticeMailPort,
  ) {}

  async run(
    input: unknown,
    caller: Caller,
    /** La clave de la petición. Obligatoria: la pantalla es una carga que bloquea. */
    record: IdempotencyRecord,
  ): Promise<PatientRegisteredResponse> {
    // Autorización por RECURSO y no solo por rol: el permiso sale de la lista resuelta que
    // viaja en el token, nunca de un `rol` que diga el cliente (OWASP A01). Recepción no
    // tiene `pacientes:crear` y por eso no llega de aquí para adentro.
    if (!caller.permissions.includes(PATIENT_CREATE_PERMISSION)) throw this.noPermission();

    const now = this.clock.now();
    const request = readRegistration(input, now);
    const owner = this.ownerOf(caller);

    // El límite se cuenta después de los 400 —un cuerpo mal escrito no gasta cuota— y
    // antes de crear nada. Va por consulta: lo que el contrato acota son las altas de una
    // consulta en una hora, no las de una persona del equipo.
    //
    // UNA REPETICIÓN GASTA UNA DE LAS 60, y es a propósito: el límite cuenta peticiones y
    // una repetición es una petición. Adelantar la comprobación de la clave para ahorrarla
    // exigiría una transacción más por alta, y 60 por hora es holgado para los reintentos
    // de una pantalla que bloquea.
    if ((await this.limit.count(this.practiceOf(caller))).tooMany) {
      throw new ContractError('demasiadas_altas');
    }

    const expiresAt = temporaryPasswordExpiry(now);
    const temporary = mintTemporaryPassword();

    // La temporal se hashea SIEMPRE, incluso cuando la cuenta ya existe y no se va a acuñar
    // ninguna: la función no puede decirnos si existe sin recibir el hash, y pagar Argon2id
    // en los dos caminos es lo que hace que el tiempo de respuesta no diga si ese correo
    // tenía cuenta. Lo que la respuesta revela —`ya_tiene_cuenta`— es una decisión escrita
    // del contrato; lo que no puede revelar es nada más, y menos con un cronómetro.
    const created = await this.patients.register({
      owner,
      idempotency: record,
      ficha: request.ficha,
      history: request.history,
      written: writtenFields(request.history),
      hash: await this.passwords.hash(temporary),
      expiresAt,
      confirmDuplicate: request.confirmDuplicate,
      via: request.via,
    });

    // La respuesta original de esta misma petición: no se creó una segunda ficha y no se manda un
    // segundo correo. Lo decidió la misma transacción que habría creado.
    if (created.verdict === 'replayed' && created.replay !== null) {
      return created.replay.response as PatientRegisteredResponse;
    }

    this.checkVerdict(created);
    const { patientId, accountId, practitionerName } = this.readCreated(created);

    const facts: DeliveryFacts = {
      patientFirstName: request.ficha.firstName,
      patientEmail: request.ficha.email,
      practitionerName,
      temporaryPassword: temporary,
      expiryText: `Caduca el ${this.clock.localLongWhen(expiresAt)}`,
    };

    const sent = await this.deliver(owner, patientId, request.via, created, facts);

    const response: PatientRegisteredResponse = {
      paciente_id: patientId,
      cuenta_id: accountId,
      nombre_completo: `${request.ficha.firstName} ${request.ficha.lastName}`,
      edad: ageOn(request.ficha.birthDate, calendarDay(now)),
      // «"Invitada" es un estado normal, no un error»: la ficha existe antes de que ella
      // instale nada. El correo es el del vínculo, el del acceso.
      vinculo: { estado: 'invitada', correo: request.ficha.email },
      acceso: this.block(request, created, facts, sent, expiresAt),
    };

    // La clave se cierra con la respuesta ya verdadera. Si esto falla, la ficha existe y el
    // acceso salió: el reintento NO puede volver a crearla —la reserva está escrita— y recibe
    // esta misma frase, que es la única que no miente en ese estado.
    try {
      await this.idempotency.complete({ owner, record, status: 201, response });
    } catch (cause) {
      throw new ServiceFailure(FAILURE_PHRASES.createPatientMail, cause);
    }

    return response;
  }

  /**
   * Los `409` y el `404` de la base, en el orden en que los devuelve. Cada uno sale de la
   * consulta del contexto: ni el plan, ni el duplicado, ni quien la refirió se preguntan con un
   * identificador que venga del cliente.
   *
   * **`license_unverified` ya no está**: era el `409 licencia_sin_verificar` de «tu licencia
   * todavía no está verificada», y se fue el 30 de octubre de 2026 con la revisión manual.
   * MedSkin no verifica licencias, así que una consulta invita pacientes desde el alta.
   */
  private checkVerdict(created: PatientRegistration): void {
    switch (created.verdict) {
      case 'plan_limit':
        throw new ContractError('limite_del_plan', undefined, this.planPhrase(created.patientLimit));
      case 'duplicate_email':
        throw this.duplicate(created.duplicate);
      case 'referrer_not_found':
        throw new ContractError('referida_no_existe');
      // «Ese correo no se puede usar», Y NO POR QUÉ (migración 0021). La frase no nombra la
      // causa a propósito: si dijera que ese correo es de una practicante, el alta sería un
      // directorio del personal de MedSkin consultable de uno en uno, que es el mismo
      // oráculo del padrón que §12.2.1 cierra en la otra dirección. Es el mismo código y la
      // misma opacidad que el `409` del alta de equipo.
      case 'email_unavailable':
        throw new ContractError(
          'correo_no_disponible',
          undefined,
          'Ese correo no se puede usar para el alta. Dale de alta con otro correo suyo, o escríbenos a hola@medskin.app.',
        );
      default:
        return;
    }
  }

  private readCreated(created: PatientRegistration): {
    patientId: string;
    accountId: string;
    practitionerName: string;
  } {
    if (
      created.patientId === null ||
      created.accountId === null ||
      created.practitionerName === null
    ) {
      // Sin los dos identificadores no hay respuesta, y sin el nombre con el que la doctora
      // se presenta no hay mensaje que escribir: no se inventa un «tu doctora» para tapar
      // una lectura que falló. Es una inconsistencia del servidor, y va con su causa.
      throw new ServiceFailure(
        FAILURE_PHRASES.createPatient,
        new Error('el alta de la paciente devolvió `created` incompleto'),
      );
    }
    return {
      patientId: created.patientId,
      accountId: created.accountId,
      practitionerName: created.practitionerName,
    };
  }

  /**
   * La entrega. La única que MedSkin hace es el correo, y hace DOS correos distintos:
   *   · cuenta nueva  → el acceso, con la temporal dentro;
   *   · cuenta reusada → el AVISO, sin contraseña porque no se acuñó ninguna. Y se manda
   *     igual, porque esa persona tiene que enterarse de que una consulta la dio de alta:
   *     es su identidad la que queda vinculada, y enterarse es lo único que le permite
   *     reaccionar (decisión del dueño, 28 de octubre de 2026).
   * Por WhatsApp manda la doctora con el dedo y en persona manda ella: ahí `enviado` es
   * `false` porque MedSkin no entrega nada.
   *
   * EN LÍNEA Y NO POR COLA, por lo mismo que el reenvío: por aquí la temporal ya está
   * acuñada, así que encolar obligaría a meterla EN CLARO en Redis para que el trabajador
   * la escriba. Y en línea `enviado` puede decir la verdad en la misma respuesta.
   */
  private async deliver(
    owner: AccountOwner,
    patientId: string,
    via: DeliveryChannel,
    created: PatientRegistration,
    facts: DeliveryFacts,
  ): Promise<boolean> {
    if (via !== 'correo') return false;
    const existing = created.accountAlreadyExisted;
    try {
      if (existing) {
        await this.mail.sendLinkNotice({
          patientEmail: facts.patientEmail,
          patientFirstName: facts.patientFirstName,
          practitionerName: facts.practitionerName,
        });
      } else {
        await this.mail.sendAccess(facts);
      }
      return true;
    } catch (cause) {
      await this.undoSentMark(owner, patientId);
      // Dos frases porque son dos casos: con cuenta nueva la temporal existe y nadie la
      // recibió; con cuenta reusada no hay contraseña ninguna que perder y lo que se perdió
      // es el aviso —ella verá «¿Es esta tu doctora?» la próxima vez que abra la app—. Las
      // dos dicen lo mismo de lo único que importa: la ficha ya está, no la crees otra vez.
      //
      // Ni el correo de la paciente ni la contraseña entran en la causa: solo la ficha. La
      // causa real del relé viaja encadenada y acaba en `service_failure` (§10.3).
      // CON LOS IDENTIFICADORES DE LO QUE YA ESTÁ CREADO. El reenvío
      // —`POST /v1/accounts/{account_id}/access`— pedía un identificador que solo viajaba en
      // el 201 que nunca llegó: la doctora leía «vuelve a mandárselo» y no tenía con qué.
      // Ahora viaja en el 500, y `GET /v1/patients` (tramo 2) es la otra salida.
      throw new ServiceFailure(
        existing ? FAILURE_PHRASES.createPatientNotice : FAILURE_PHRASES.createPatientMail,
        new Error(`no se pudo mandar el acceso de la ficha ${patientId}`, { cause }),
        { paciente_id: patientId, cuenta_id: created.accountId },
      );
    }
  }

  /**
   * `patient_link.access_sent_at` SE ESCRIBE AL CREAR el vínculo cuando la vía es el correo,
   * y el envío pasa después: con el relé caído la base afirmaría «ya se le mandó» siendo
   * falso, y es la columna que la consola lee para decidir si hay que reenviar. Aquí el
   * vínculo acaba de nacer, así que lo que esta llamada escribió es TODO lo que hay y
   * deshacerlo es dejarlo en nulo: no hay historia que borrar, al contrario que en el
   * reenvío. El intento no se pierde: vive en `access_audit`.
   */
  private async undoSentMark(owner: AccountOwner, patientId: string): Promise<void> {
    try {
      await this.patients.markAccessSent(owner, patientId, null);
    } catch (whileUndoing) {
      // Lo mismo para quien lo lee —el acceso no salió y la ficha ya existe—, pero la fila
      // de `service_failure` dice que ADEMÁS la marca quedó puesta, que es lo que alguien
      // tiene que ir a corregir. Un fallo que no se puede compensar se registra.
      throw new ServiceFailure(
        FAILURE_PHRASES.createPatientMail,
        new Error(
          `el acceso de la ficha ${patientId} no se mandó y la marca de envío quedó puesta`,
          { cause: whileUndoing },
        ),
      );
    }
  }

  private block(
    request: { ficha: PatientFicha; via: DeliveryChannel },
    created: PatientRegistration,
    facts: DeliveryFacts,
    sent: boolean,
    expiresAt: Date,
  ): PatientAccessBlock {
    const existing = created.accountAlreadyExisted;
    const block: PatientAccessBlock = {
      via: existing ? 'ya_tiene_cuenta' : request.via,
      enviado: sent,
      contrasena_temporal: !existing && temporaryTravelsTo(request.via) ? facts.temporaryPassword : null,
      caduca_en: existing ? null : expiresAt.toISOString(),
      caduca_en_texto: existing ? null : facts.expiryText,
    };

    const phone = request.ficha.phone;
    if (request.via !== 'whatsapp' || phone === null) return block;

    // El texto de quien ya tiene cuenta NO lleva contraseña, porque no se acuñó ninguna.
    const texto = existing
      ? whatsappTextForExistingAccount({
          patientFirstName: facts.patientFirstName,
          practitionerName: facts.practitionerName,
        })
      : whatsappText(facts);
    // `texto` Y `url` a propósito: `url` para abrir el chat, `texto` para que la app pueda
    // ofrecer «copiar el mensaje» cuando WhatsApp no esté instalado, sin desescaparlo.
    return { ...block, whatsapp: { numero: phone, texto, url: whatsappUrl(phone, texto) } };
  }


  /** «Llegaste a las 300 pacientes de tu plan», con el número del plan dentro. */
  private planPhrase(limit: number | null): string | undefined {
    if (limit === null) return undefined;
    return `Llegaste a las ${limit} pacientes de tu plan. Amplíalo para dar de alta más.`;
  }

  /**
   * El duplicado no es un muro: aviso sobre el campo con el nombre y la fecha dentro, y
   * `datos` para que la app pueda abrir esa ficha. «Es otra persona» repite la petición con
   * `confirmar_duplicado: true` y este 409 no vuelve.
   */
  private duplicate(duplicate: DuplicatePatient | null): ContractError {
    if (duplicate === null) {
      throw new ServiceFailure(
        FAILURE_PHRASES.createPatient,
        new Error('el alta devolvió `duplicate_email` sin la ficha duplicada'),
      );
    }
    const day = this.clock.localDay(duplicate.createdAt);
    return new ContractError(
      'correo_duplicado_en_la_consulta',
      {
        paciente_id: duplicate.patientId,
        nombre_completo: duplicate.fullName,
        alta_en: duplicate.createdAt.toISOString(),
      },
      `Ya tienes a ${duplicate.fullName} con este correo, de alta el ${day}. Revisa antes de crear otra ficha.`,
    );
  }

  /** La frase es la de ESTE endpoint, con las palabras de su «Quién puede». */
  private noPermission(): ContractError {
    return new ContractError(
      'sin_permiso',
      undefined,
      'Recepción no puede dar de alta pacientes.',
    );
  }

  private ownerOf(caller: Caller): AccountOwner {
    return {
      accountId: caller.accountId,
      practiceId: this.practiceOf(caller),
      accountRole: caller.accountRole,
      sessionId: caller.sessionId,
    };
  }

  /**
   * La consulta del token. Un token con `pacientes:crear` sale de una fila de
   * `practitioner`, que siempre tiene consulta; sin ella no hay consulta que fijar y la
   * base fallaría cerrada, así que se dice aquí con su causa en vez de dejar que reviente
   * dentro de una transacción.
   */
  private practiceOf(caller: Caller): string {
    if (caller.practiceId === null) {
      throw new ServiceFailure(
        FAILURE_PHRASES.createPatient,
        new Error('el token trae `pacientes:crear` y no trae consulta'),
      );
    }
    return caller.practiceId;
  }
}
