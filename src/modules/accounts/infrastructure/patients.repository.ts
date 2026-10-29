// El alta de una paciente, contra la base. Única puerta: `withTenantContext()`.
//
// TODO EL ALTA EN UNA TRANSACCIÓN, y no es comodidad: es «su ficha y su cuenta, en un solo
// acto». Repartida en dos llamadas, un fallo entre ellas deja una cuenta sin ficha
// —invisible para la doctora, que no tiene política de `SELECT` sobre `account`— o una ficha
// sin vínculo, que es una paciente a la que nadie puede mandarle su acceso.
//
// NI UNA CONSULTA LLEVA UN IDENTIFICADOR DE INQUILINO DEL CLIENTE. El `practice_id` sale
// siempre de `medskin_current_practice()`, que lo fija `withTenantContext()` con el del
// token, y las políticas de `patient`, `patient_link` y `medical_history` lo exigen en el
// `WITH CHECK`: un alta no puede caer en otra consulta ni por error de programación. Lo que
// sí viene del cuerpo —`referida_por`— es criterio de búsqueda DENTRO del inquilino, y si no
// hay fila, la respuesta es la misma que la de un identificador inventado (OWASP A01).

import type { Pool, PoolClient } from 'pg';

import { FAILURE_PHRASES, ServiceFailure } from '../../../shared/contract/error-catalog';
import { withTenantContext, type TenantContext } from '../../../shared/db/tenant-context';
import type { IdempotencyRecord } from '../../../shared/idempotency/idempotency-key';
import { claim, complete, release } from '../../../shared/idempotency/idempotency-rows';
import type { HistoryDraft, HistoryField, PatientFicha } from '../domain/patient-registration';
import type {
  AccountOwner,
  IdempotencyCompletionPort,
  PatientRegistration,
  PatientRegistrationPort,
  PatientRegistrationVerdict,
} from '../domain/ports';

/**
 * Siempre `app_practitioner`: el alta es de la doctora y de su asistente clínico, y sus
 * políticas se leen por inquilino. Una paciente no llega aquí —no tiene `pacientes:crear`—
 * y si llegara, su contexto no fijaría `practice_id` y todo fallaría cerrado.
 */
function contextFor(owner: AccountOwner): TenantContext {
  return { role: 'app_practitioner', accountId: owner.accountId, practiceId: owner.practiceId };
}

/** La acción de la bitácora, la MISMA del reenvío: `acceso_pedido`, no `acceso_enviado`. */
const AUDIT_ACTION = 'cuenta.acceso_pedido';

type Preconditions = {
  licenseStatus: string;
  patientLimit: number;
  patients: number;
  /** Las dos copias que `patient_link` guarda de la consulta para la app de la paciente. */
  practiceName: string;
  city: string | null;
};

export class PatientsRepository implements PatientRegistrationPort, IdempotencyCompletionPort {
  constructor(private readonly pool: Pool) {}

  async register(p: {
    owner: AccountOwner;
    idempotency: IdempotencyRecord;
    ficha: PatientFicha;
    history: HistoryDraft;
    written: readonly HistoryField[];
    hash: string;
    expiresAt: Date;
    confirmDuplicate: boolean;
    via: string;
  }): Promise<PatientRegistration> {
    return withTenantContext(this.pool, contextFor(p.owner), async (c) => {
      // LO PRIMERO DE LA TRANSACCIÓN, Y ANTES DE ESCRIBIR NADA: reclamar la clave. La clave
      // primaria `(account_id, key)` es lo que serializa, así que de dos peticiones idénticas
      // a la vez una gana y la otra se entera AQUÍ, antes de crear ninguna ficha. Con la
      // reserva al final, las dos pasaban el `SELECT` vacío y creaban las dos: en el alta de
      // un correo que ya tiene cuenta no hay ninguna red natural que pare a la segunda.
      //
      // La respuesta original se repite tal como se guardó —contraseña temporal incluida, que es la
      // decisión escrita del 27 de octubre— y no se crea nada.
      const replay = await claim<unknown>(c, {
        record: p.idempotency,
        accountId: p.owner.accountId,
        practiceId: p.owner.practiceId,
        unfinished: FAILURE_PHRASES.createPatientMail,
      });
      if (replay !== null) {
        // «Cada repetición deja su propia línea en la auditoría, con quién la pidió y cuándo,
        // porque una contraseña entregada dos veces es un hecho que alguien puede querer
        // reconstruir» (`_convenciones.md`). En la misma transacción que la leyó.
        await this.audit(c, p.owner, accountOf(replay.response), {
          via: p.via,
          alta: true,
          repetida: true,
        });
        return { ...no('replayed'), replay };
      }

      const registration = await this.write(c, p);
      // Un veredicto que no creó nada SUELTA la clave: un `403`, un `409` o un `404` no son
      // una respuesta que repetir, y el reintento —cuando le aprueben la licencia, o cuando
      // confirme el duplicado— tiene que poder volver a intentarlo de verdad.
      if (registration.verdict !== 'created') {
        await release(c, { record: p.idempotency, accountId: p.owner.accountId });
      }
      return registration;
    });
  }

  /**
   * El alta en sí, con la clave ya reclamada: preconditions, cuenta, ficha, vínculo,
   * antecedentes y bitácora. Si algo lanza, la transacción entera se deshace y con ella la
   * reserva, que es lo correcto: no hubo alta y la clave queda libre.
   */
  private async write(
    c: PoolClient,
    p: {
      owner: AccountOwner;
      idempotency: IdempotencyRecord;
      ficha: PatientFicha;
      history: HistoryDraft;
      written: readonly HistoryField[];
      hash: string;
      expiresAt: Date;
      confirmDuplicate: boolean;
      via: string;
    },
  ): Promise<PatientRegistration> {
      const limits = await this.preconditions(c);
      // Los tres veredictos que se deciden ANTES de crear nada, en el orden del contrato.
      if (limits.licenseStatus !== 'verificada') return no('license_unverified');
      if (limits.patients >= limits.patientLimit) {
        return { ...no('plan_limit'), patientLimit: limits.patientLimit };
      }

      if (!p.confirmDuplicate) {
        const duplicate = await this.duplicateOf(c, p.ficha.email);
        if (duplicate !== null) return { ...no('duplicate_email'), duplicate };
      }
      if (p.ficha.referredBy !== null && !(await this.isPatientHere(c, p.ficha.referredBy))) {
        return no('referrer_not_found');
      }

      // Con qué nombre se presenta la doctora en el mensaje del acceso. Se lee antes de
      // escribir nada: sin él no hay `patient_link.practitioner_name` que poner, que es
      // `NOT NULL` porque la paciente no tiene política en `practitioner` y esa copia es lo
      // único que su app puede leer.
      const practitionerName = await this.practitionerName(c);

      // La cuenta, por la función `SECURITY DEFINER`. NO recibe `account_id` y es la
      // decisión de seguridad de esta ruta: con uno, una doctora podría acuñar una temporal
      // sobre la cuenta de cualquiera. Si ese correo ya tiene cuenta, la REUSA y no acuña
      // nada —«ya tiene la suya»—, y entonces `temp_first_used_at` tampoco se toca: es un
      // hecho del pasado y no se des-ocurre (0017).
      const account = await this.accountFor(c, p);
      // La cuenta de una practicante no se reusa (0021). Nada se ha escrito todavía: la
      // ficha va después, así que no hay nada que deshacer.
      if (account === null) return no('email_unavailable');

      // EL «vuelve_si», QUE HASTA HOY NADIE LEÍA. El borrado de cuenta suelta el vínculo y
      // conserva el correo a propósito —«es la llave del vuelve_si», 0014:247—, y el 200 de
      // ese borrado le promete a la paciente que su doctora puede traerla de vuelta con ese
      // mismo correo. Si hay un vínculo suelto con este correo en ESTA consulta, es la misma
      // persona: se reengancha su ficha y su expediente en vez de crear una segunda.
      const returned = await this.relink(c, p.ficha.email, account.accountId);

      const patientId = returned ?? (await this.insertFicha(c, p.ficha));
      if (returned !== null) {
        // Vuelve con los datos de contacto que la doctora acaba de escribir —son los de hoy— y
        // activa: lo que NO se toca es su expediente, que es la razón de reengancharla.
        await this.refreshFicha(c, returned, p.ficha);
      }
      if (returned === null) await this.insertLink(c, {
        patientId,
        accountId: account.accountId,
        email: p.ficha.email,
        practiceName: limits.practiceName,
        practitionerName,
        city: limits.city,
        // `access_sent_at` solo puede afirmar un envío que ocurrió, y el único que MedSkin
        // hace es el correo —el del acceso si la cuenta es nueva, el del aviso si se reusó—.
        // Por WhatsApp y en persona manda la doctora con el dedo: ahí nace en nulo, y si el
        // relé falla, quien llama lo devuelve a nulo.
        markSent: p.via === 'correo',
      });
      // Los antecedentes: una fila nueva en el alta normal, y en el regreso se MEZCLAN por
      // campo sobre los que ya estaban —solo los que la doctora nombró ahora—. Un alta que
      // pisara el expediente de vuelta sería peor que no reengancharlo (lección del `[]`).
      if (returned === null) await this.insertHistory(c, patientId, p.history, p.written);
      else await this.mergeHistory(c, patientId, p.history, p.written);
      await this.audit(c, p.owner, account.accountId, {
        via: p.via,
        alta: true,
        ya_tenia_cuenta: account.alreadyExisted,
      });

      // La clave ya está reservada desde el principio de la transacción; su respuesta se
      // escribe con `complete()` cuando sea verdad, porque `enviado` dice si el relé aceptó
      // el correo y eso pasa después del `COMMIT`.
      return {
        verdict: 'created',
        patientId,
        accountId: account.accountId,
        accountAlreadyExisted: account.alreadyExisted,
        patientLimit: null,
        duplicate: null,
        practitionerName,
        replay: null,
      };
  }

  /**
   * El cierre de la clave: la respuesta definitiva, cuando ya es verdad. En su propia
   * transacción, y no puede causar una segunda ejecución porque la reserva ya está escrita.
   */
  async complete(p: {
    owner: AccountOwner;
    record: IdempotencyRecord;
    status: number;
    response: unknown;
  }): Promise<void> {
    return withTenantContext(this.pool, contextFor(p.owner), (c) =>
      complete(c, {
        record: p.record,
        accountId: p.owner.accountId,
        status: p.status,
        response: p.response,
      }),
    );
  }

  async markAccessSent(
    owner: AccountOwner,
    patientId: string,
    sentAt: Date | null,
  ): Promise<void> {
    return withTenantContext(this.pool, contextFor(owner), async (c) => {
      // `practice_id` va escrito aunque la política ya lo ponga, por lo mismo que en el
      // reenvío: un `UPDATE` cuyo alcance depende solo de RLS deja de estar acotado el día
      // que algo corra con `BYPASSRLS`.
      const done = await c.query(
        `update patient_link set access_sent_at = $2, updated_at = now()
          where patient_id = $1 and practice_id = medskin_current_practice()`,
        [patientId, sentAt],
      );
      if (done.rowCount === 1) return;
      // Un fallo que no se puede compensar se registra, no se esconde: quien llama lo
      // convierte en el 500 del envío con las dos causas encadenadas.
      throw new Error(
        `la marca de envío de la ficha ${patientId} no se pudo escribir: ${done.rowCount ?? 0} filas`,
      );
    });
  }


  /**
   * La licencia, el plan y el recuento, de una sola lectura y las tres del CONTEXTO. El
   * recuento es de las fichas activas: una archivada «sale de la lista» y no ocupa plan
   * (anotado en la entrega; el contrato dice «pacientes >= limite_pacientes» y no cuáles).
   */
  private async preconditions(c: PoolClient): Promise<Preconditions> {
    const { rows } = await c.query<{
      license_status: string;
      patient_limit: number;
      patients: string;
      practice_name: string;
      city: string | null;
    }>(
      `select l.status as license_status, p.patient_limit, p.name as practice_name, p.city,
              (select count(*) from patient a
                where a.practice_id = p.id and a.status = 'activa') as patients
         from practice p
         join license l on l.practice_id = p.id
        where p.id = medskin_current_practice()`,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new ServiceFailure(
        FAILURE_PHRASES.createPatient,
        new Error('el inquilino del contexto no tiene consulta con licencia'),
      );
    }
    return {
      licenseStatus: row.license_status,
      patientLimit: row.patient_limit,
      patients: Number(row.patients),
      practiceName: row.practice_name,
      city: row.city,
    };
  }

  /**
   * El duplicado es POR CONSULTA y lo acota la política: «que ese correo tenga ficha en otra
   * clínica no es cosa de esta doctora ni se le dice» (§12.2.1). Sirve
   * `patient_practice_email_idx (practice_id, email)`.
   */
  private async duplicateOf(
    c: PoolClient,
    email: string,
  ): Promise<{ patientId: string; fullName: string; createdAt: Date } | null> {
    const { rows } = await c.query<{ id: string; full_name: string; created_at: Date }>(
      `select id, first_name || ' ' || last_name as full_name, created_at
         from patient
        where practice_id = medskin_current_practice() and email = $1
        order by created_at
        limit 1`,
      [email],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { patientId: row.id, fullName: row.full_name, createdAt: row.created_at };
  }

  /** Quien la refirió tiene que ser ficha de ESTA consulta. Si no, el 404 es indistinguible. */
  private async isPatientHere(c: PoolClient, patientId: string): Promise<boolean> {
    const { rows } = await c.query(
      `select 1 from patient
        where id = $1 and practice_id = medskin_current_practice()`,
      [patientId],
    );
    return rows.length === 1;
  }

  /**
   * «soy la Dra. Andrea Paz»: el nombre de la doctora de la consulta, no el de quien llama.
   * El alta la puede hacer su asistente clínico, y la paciente no está siendo dada de alta
   * por la asistente: la atiende la doctora, y es su nombre el que la paciente reconoce en
   * el mensaje y el que su app lee de la copia de `patient_link`. La dueña va primero
   * cuando hay más de una (anotado en la entrega: el contrato no lo dice).
   */
  private async practitionerName(c: PoolClient): Promise<string> {
    const { rows } = await c.query<{ name: string }>(
      `select pr.first_name || ' ' || pr.last_name as name
         from practitioner pr
         join practice p on p.id = pr.practice_id
        where p.id = medskin_current_practice()
          and pr.role = 'doctora' and pr.status = 'activa'
        order by (pr.account_id = p.owner_account_id) desc nulls last, pr.created_at
        limit 1`,
    );
    const name = rows[0]?.name;
    if (name === undefined) {
      throw new ServiceFailure(
        FAILURE_PHRASES.createPatient,
        new Error('la consulta del contexto no tiene doctora activa'),
      );
    }
    return name;
  }

  /**
   * La cuenta, por la función `SECURITY DEFINER`. `null` cuando el correo no se puede usar
   * para un alta, que desde la 0021 es un caso: **la cuenta de una practicante no se reusa**.
   *
   * LO QUE ESA MIGRACIÓN CIERRA ES EL MOTIVO, NO LA DIFERENCIA DE RESULTADO, y conviene
   * leerlo sin exagerarlo: un correo desconocido da 201, el de una paciente da 201 y el de
   * una practicante da 409, así que una doctora insistente todavía puede distinguir
   * «practicante» de «paciente o desconocido». No se puede quitar sin romper lo que el
   * contrato exige —el alta tiene que funcionar con el correo de una paciente de otra
   * consulta y tiene que fallar con el de una practicante—. Lo que sí se cierra es que la
   * respuesta NOMBRE la causa, que es lo que convertiría el alta en un directorio del
   * personal consultable de uno en uno.
   */
  private async accountFor(
    c: PoolClient,
    p: { ficha: PatientFicha; hash: string; expiresAt: Date },
  ): Promise<{ accountId: string; alreadyExisted: boolean } | null> {
    const { rows } = await c.query<{
      verdict: string;
      account_id: string | null;
      already_existed: boolean | null;
    }>(
      'select verdict, account_id, already_existed from medskin_create_patient_account($1, $2, $3, $4, $5, $6)',
      [
        p.ficha.email,
        p.ficha.firstName,
        p.ficha.lastName,
        p.ficha.phone,
        p.hash,
        p.expiresAt,
      ],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new ServiceFailure(
        FAILURE_PHRASES.createPatient,
        new Error('medskin_create_patient_account no devolvió veredicto'),
      );
    }
    if (row.verdict === 'email_unavailable') return null;
    if (row.account_id === null) {
      throw new ServiceFailure(
        FAILURE_PHRASES.createPatient,
        new Error(`medskin_create_patient_account devolvió '${row.verdict}' sin cuenta`),
      );
    }
    // `created` ↔ `false` y `ya_tiene_cuenta` ↔ `true`: el veredicto manda, y
    // `already_existed` se conservó para no romper lo que ya se leía.
    return { accountId: row.account_id, alreadyExisted: row.verdict === 'ya_tiene_cuenta' };
  }

  /** El vínculo suelto de esta consulta con ese correo, reenganchado. Nulo si no había. */
  private async relink(c: PoolClient, email: string, accountId: string): Promise<string | null> {
    const { rows } = await c.query<{ patient_id: string | null }>(
      'select medskin_relink_patient($1, $2) as patient_id',
      [email, accountId],
    );
    return rows[0]?.patient_id ?? null;
  }

  /** Los datos de CONTACTO del regreso, y nada más: el expediente no se toca. */
  private async refreshFicha(c: PoolClient, patientId: string, ficha: PatientFicha): Promise<void> {
    await c.query(
      `update patient
          set first_name = $2, last_name = $3, birth_date = $4, email = $5, phone = $6,
              has_whatsapp = $7, reminders_via = $8, status = 'activa', archived_at = null,
              updated_at = now()
        where id = $1`,
      [
        patientId,
        ficha.firstName,
        ficha.lastName,
        ficha.birthDate,
        ficha.email,
        ficha.phone,
        ficha.hasWhatsapp,
        ficha.remindersVia,
      ],
    );
  }

  /**
   * LA MEZCLA POR CAMPO de los antecedentes del regreso. Solo lo que la doctora NOMBRÓ en este
   * alta, con su fuente y su fecha; lo que no nombró se queda como estaba. Es la misma regla
   * del `PUT` de antecedentes, y la razón es la lección del 28 de octubre: un normalizador que
   * devuelve `[]` para un campo ausente BORRA.
   */
  private async mergeHistory(
    c: PoolClient,
    patientId: string,
    history: HistoryDraft,
    written: readonly HistoryField[],
  ): Promise<void> {
    const columns: Readonly<Record<string, unknown>> = {
      has_allergies: history.hasAllergies,
      allergies: history.allergies,
      takes_medication: history.takesMedication,
      medication: history.medication,
      pregnancy_or_lactation: history.pregnancyOrLactation,
      phototype: history.phototype,
      past_conditions: history.pastConditions,
      previous_treatments: history.previousTreatments,
      notes: history.notes,
    };
    /** El campo del dominio que manda la fuente de cada columna. */
    const sourceOf: Readonly<Record<string, HistoryField>> = {
      has_allergies: 'allergies',
      allergies: 'allergies',
      takes_medication: 'medication',
      medication: 'medication',
      pregnancy_or_lactation: 'pregnancy_or_lactation',
      phototype: 'phototype',
      past_conditions: 'past_conditions',
      previous_treatments: 'previous_treatments',
      notes: 'notes',
    };

    const sets: string[] = [];
    const values: unknown[] = [patientId];
    const sources = new Set<HistoryField>();
    for (const [column, value] of Object.entries(columns)) {
      const field = sourceOf[column]!;
      if (!written.includes(field)) continue;
      values.push(value);
      sets.push(`${column} = $${values.length}`);
      sources.add(field);
    }
    for (const field of sources) {
      sets.push(`${field}_source = 'doctora'`, `${field}_source_at = now()`);
    }
    if (sets.length === 0) return;

    await c.query(
      `update medical_history set ${sets.join(', ')}, updated_at = now() where patient_id = $1`,
      values,
    );
  }

  private async insertFicha(c: PoolClient, ficha: PatientFicha): Promise<string> {
    const { rows } = await c.query<{ id: string }>(
      `insert into patient (practice_id, first_name, last_name, birth_date, email, phone,
                            has_whatsapp, reminders_via, how_arrived, referred_by)
       values (medskin_current_practice(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        ficha.firstName,
        ficha.lastName,
        ficha.birthDate,
        ficha.email,
        ficha.phone,
        ficha.hasWhatsapp,
        ficha.remindersVia,
        ficha.howArrived,
        ficha.referredBy,
      ],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new ServiceFailure(
        FAILURE_PHRASES.createPatient,
        new Error('la ficha de la paciente no se creó'),
      );
    }
    return id;
  }

  /**
   * El vínculo, con las TRES COPIAS que la paciente lee desde su app —consulta, doctora y
   * ciudad—: `app_patient` no tiene política en `practice` ni en `practitioner`, y dárselas
   * para servir dos nombres abriría todos los inquilinos (pregunta 7, resuelta el 28 oct).
   */
  private async insertLink(
    c: PoolClient,
    link: {
      patientId: string;
      accountId: string;
      email: string;
      practiceName: string;
      practitionerName: string;
      city: string | null;
      markSent: boolean;
    },
  ): Promise<void> {
    await c.query(
      `insert into patient_link (practice_id, patient_id, account_id, status, email,
                                 access_sent_at, practice_name, practitioner_name, city)
       values (medskin_current_practice(), $1, $2, 'invitada', $3,
               case when $7::boolean then now() end, $4, $5, $6)`,
      [
        link.patientId,
        link.accountId,
        link.email,
        link.practiceName,
        link.practitionerName,
        link.city,
        link.markSent,
      ],
    );
  }

  /**
   * Los antecedentes, UNA FILA POR FICHA (§12.1), y cada campo con quién lo escribió. Lo que
   * la doctora no contestó queda sin `fuente` y en nulo, que es «nadie preguntó todavía» y
   * NO «no tiene»: es la distinción que hace que la paciente pueda llenarlo desde su app sin
   * sobrescribir nada (tramo 2).
   *
   * `now()` del motor y no del proceso: la fecha de la fuente es parte del mismo hecho que la
   * fila, y dos relojes para un hecho son dos hechos.
   */
  private async insertHistory(
    c: PoolClient,
    patientId: string,
    history: HistoryDraft,
    written: readonly HistoryField[],
  ): Promise<void> {
    const by = (field: HistoryField): string | null => (written.includes(field) ? 'doctora' : null);
    const when = (n: number): string =>
      `case when $${n}::medskin_history_source is null then null else now() end`;

    await c.query(
      `insert into medical_history (practice_id, patient_id,
         has_allergies, allergies, allergies_source, allergies_source_at,
         takes_medication, medication, medication_source, medication_source_at,
         pregnancy_or_lactation, pregnancy_or_lactation_source,
         pregnancy_or_lactation_source_at,
         phototype, phototype_source, phototype_source_at,
         past_conditions, past_conditions_source, past_conditions_source_at,
         previous_treatments, previous_treatments_source, previous_treatments_source_at,
         notes, notes_source, notes_source_at)
       values (medskin_current_practice(), $1,
         $2, $3, $4, ${when(4)},
         $5, $6, $7, ${when(7)},
         $8, $9, ${when(9)},
         $10, $11, ${when(11)},
         $12, $13, ${when(13)},
         $14, $15, ${when(15)},
         $16, $17, ${when(17)})`,
      [
        patientId,
        history.hasAllergies,
        history.allergies,
        by('allergies'),
        history.takesMedication,
        history.medication,
        by('medication'),
        history.pregnancyOrLactation,
        by('pregnancy_or_lactation'),
        history.phototype,
        by('phototype'),
        history.pastConditions,
        by('past_conditions'),
        history.previousTreatments,
        by('previous_treatments'),
        history.notes,
        by('notes'),
      ],
    );
  }

  /**
   * «La entrega de la contraseña temporal queda en `access_audit` con quién la pidió»
   * (`cuentas.md`). `acceso_pedido` Y NO `acceso_enviado`: la fila se escribe en la misma
   * transacción que acuña y el envío pasa después, así que lo único que puede afirmar es que
   * alguien pidió el acceso, cuándo y por dónde. NI LA CONTRASEÑA NI UN DATO CLÍNICO entran
   * en `data`: identificadores y etiquetas cerradas, nada más (§10.3).
   */
  private async audit(
    c: PoolClient,
    owner: AccountOwner,
    subjectAccountId: string | null,
    data: Record<string, unknown>,
  ): Promise<void> {
    await c.query(
      `insert into access_audit (practice_id, actor_account_id, action, subject_type,
                                 subject_id, data)
       values (medskin_current_practice(), $1, $2, 'cuenta', $3, $4)`,
      [owner.accountId, AUDIT_ACTION, subjectAccountId, JSON.stringify(data)],
    );
  }
}

/** Un veredicto que no creó nada. Los campos opcionales los pone quien lo necesita. */
function no(verdict: PatientRegistrationVerdict): PatientRegistration {
  return {
    verdict,
    patientId: null,
    accountId: null,
    accountAlreadyExisted: false,
    patientLimit: null,
    duplicate: null,
    practitionerName: null,
    replay: null,
  };
}

/**
 * La cuenta de la respuesta guardada, para la línea de bitácora de la repetición. Se lee de
 * la respuesta y no de una consulta nueva: es la cuenta a la que se entregó aquella vez.
 * Nulo si la respuesta guardada no la trae, que no puede pasar con un `201` de este endpoint
 * y aun así no se inventa un identificador.
 */
function accountOf(response: unknown): string | null {
  const body = response as { cuenta_id?: unknown } | null;
  return typeof body?.cuenta_id === 'string' ? body.cuenta_id : null;
}
