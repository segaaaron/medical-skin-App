// La prueba de lo que añade la 0019: `POST /v1/equipo/{miembro_id}/acceso` ·
// `medskin_resend_team_access()`.
//
// Mismas reglas que sus hermanas: contra la base real en Docker, sin un solo doble, RLS
// nunca se desactiva, siembra el DUEÑO del esquema —que es quien migra— y todo lo que se
// COMPRUEBA pasa por los roles de aplicación y por `withTenantContext()`.
//
// Lo que esta función cierra es una frontera por FIRMA, no por fila: `app_practitioner`
// tiene el `EXECUTE` (un privilegio es por rol, no por endpoint, §1.15), y lo que sostiene
// el límite es que la función no recibe ni la cuenta ni la consulta —las saca del contexto—
// y que comprueba ser la dueña aquí dentro.

import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantContext, type TenantContext } from './tenant-context';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ?? 'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

const HASH = '$argon2id$v=19$m=65536,p=4,t=3$c2VtaWxsYWRlcHJ1ZWJh$BcVqHhiTZ4RrQZ4kYgVvxCuUAneDdfTxZ6qz6hUwcLY';
const NEW_TEMP = '$argon2id$v=19$m=65536,p=4,t=3$b3RyYXNlbWlsbGFhcQ$GVnsaFqlkimVX8dDYgVvxCuUAneDdfTxZ6qz6hUwcLY';
const NOBODY = '1b1b1b1b-9999-4000-8000-999999999999';

const A = {
  practice: '1b1b1b1b-0000-4000-8000-00000000000a',
  // La dueña, y una segunda doctora de la MISMA consulta que no es la dueña.
  owner: { account: '1b1b1b1b-0000-4000-8000-00000000001a', practitioner: '1b1b1b1b-0000-4000-8000-00000000002a' },
  second: { account: '1b1b1b1b-0000-4000-8000-00000000003a', practitioner: '1b1b1b1b-0000-4000-8000-00000000004a' },
  // Recepción: sigue con su temporal, y ya la estrenó (ahí se mira la 0017).
  desk: { account: '1b1b1b1b-0000-4000-8000-00000000005a', practitioner: '1b1b1b1b-0000-4000-8000-00000000006a' },
  // Asistente que ya eligió su contraseña definitiva.
  chosen: { account: '1b1b1b1b-0000-4000-8000-00000000007a', practitioner: '1b1b1b1b-0000-4000-8000-00000000008a' },
  // Retirada del equipo, y una con la cuenta borrada: la fila de `practitioner` sobrevive
  // al borrado de la cuenta, así que el veredicto tiene que mirar `account.deleted_at`.
  retired: { account: '1b1b1b1b-0000-4000-8000-00000000009a', practitioner: '1b1b1b1b-0000-4000-8000-0000000000aa' },
  deleted: { account: '1b1b1b1b-0000-4000-8000-0000000000ba', practitioner: '1b1b1b1b-0000-4000-8000-0000000000ca' },
};
const B = {
  practice: '1b1b1b1b-0000-4000-8000-00000000000b',
  owner: { account: '1b1b1b1b-0000-4000-8000-00000000001b', practitioner: '1b1b1b1b-0000-4000-8000-00000000002b' },
  desk: { account: '1b1b1b1b-0000-4000-8000-00000000003b', practitioner: '1b1b1b1b-0000-4000-8000-00000000004b' },
};

const ctxOwnerA: TenantContext = { role: 'app_practitioner', practiceId: A.practice, accountId: A.owner.account };
const ctxSecondA: TenantContext = { role: 'app_practitioner', practiceId: A.practice, accountId: A.second.account };
const ctxOwnerB: TenantContext = { role: 'app_practitioner', practiceId: B.practice, accountId: B.owner.account };
const ctxPlatform: TenantContext = { role: 'app_platform', accountId: '1b1b1b1b-0000-4000-8000-00000000000d' };
const ctxPatient: TenantContext = { role: 'app_patient', accountId: '1b1b1b1b-0000-4000-8000-00000000000e' };
const ctxAnonymous: TenantContext = { role: 'app_anonymous' };

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 1 });

async function read<T extends QueryResultRow>(ctx: TenantContext, sql: string, params: unknown[] = []): Promise<T[]> {
  return withTenantContext(app, ctx, async (client: PoolClient) => (await client.query<T>(sql, params)).rows);
}

type Verdict = { outcome: string; email: string | null; expires_at: Date | null };

const resend = (ctx: TenantContext, practitionerId: string, hash = NEW_TEMP) =>
  read<Verdict>(
    ctx,
    `select outcome, email, expires_at
       from medskin_resend_team_access($1, $2, now() + interval '72 hours')`,
    [practitionerId, hash],
  );

/** Lo que solo el dueño del esquema puede mirar: el hash y las marcas de la temporal. */
async function credentialOf(accountId: string) {
  const { rows } = await owner.query<{
    hash: string;
    is_temporary: boolean;
    temp_first_used_at: Date | null;
  }>('select hash, is_temporary, temp_first_used_at from credential where account_id = $1', [accountId]);
  return rows[0];
}

async function clean() {
  await owner.query('delete from practice where id = any($1::uuid[])', [[A.practice, B.practice]]);
  await owner.query(`delete from account where email like '%@equipo.local'`);
}

beforeAll(async () => {
  await clean();

  const member = async (
    practice: string,
    who: { account: string; practitioner: string },
    label: string,
    role: string,
    options: { chosen?: boolean; retired?: boolean; deleted?: boolean; firstUsed?: boolean } = {},
  ) => {
    await owner.query(
      `insert into account (id, email, role, region, first_name, last_name, deleted_at)
       values ($1, $2, 'practitioner', 'latam', $3, 'Paz', $4)`,
      [who.account, `${label}@equipo.local`, label, options.deleted === true ? new Date() : null],
    );
    if (options.chosen === true) {
      await owner.query(
        `insert into credential (account_id, hash, is_temporary, set_at, temp_used_at)
         values ($1, $2, false, now(), now())`,
        [who.account, HASH],
      );
    } else {
      await owner.query(
        `insert into credential (account_id, hash, is_temporary, temp_expires_at, temp_first_used_at)
         values ($1, $2, true, now() + interval '72 hours', $3)`,
        [who.account, HASH, options.firstUsed === true ? new Date(Date.now() - 3_600_000) : null],
      );
    }
    await owner.query(
      `insert into practitioner (id, practice_id, account_id, first_name, last_name, role, status)
       values ($1, $2, $3, $4, 'Paz', $5, $6)`,
      [
        who.practitioner,
        practice,
        who.account,
        label,
        role,
        options.retired === true ? 'retirada' : 'activa',
      ],
    );
  };

  for (const [id, name] of [
    [A.practice, 'Clínica Equipo A'],
    [B.practice, 'Clínica Equipo B'],
  ] as const) {
    await owner.query(
      `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit)
       values ($1, $2, 'latam', 'BO', 'America/La_Paz', 'BOB', 'clinica', 1000)`,
      [id, name],
    );
  }

  await member(A.practice, A.owner, 'duena.a', 'doctora', { chosen: true });
  await member(A.practice, A.second, 'segunda.a', 'doctora', { chosen: true });
  // La recepcionista ya estrenó su temporal: su marca tiene que seguir ahí después del
  // reenvío (0017), o se queda sin «Olvidé mi contraseña».
  await member(A.practice, A.desk, 'recepcion.a', 'recepcion', { firstUsed: true });
  await member(A.practice, A.chosen, 'asistente.a', 'asistente_clinico', { chosen: true });
  await member(A.practice, A.retired, 'retirada.a', 'recepcion', { retired: true });
  await member(A.practice, A.deleted, 'borrada.a', 'recepcion', { deleted: true });
  await owner.query('update practice set owner_account_id = $1 where id = $2', [A.owner.account, A.practice]);

  await member(B.practice, B.owner, 'duena.b', 'doctora', { chosen: true });
  await member(B.practice, B.desk, 'recepcion.b', 'recepcion', {});
  await owner.query('update practice set owner_account_id = $1 where id = $2', [B.owner.account, B.practice]);
});

afterAll(async () => {
  await clean();
  await owner.end();
  await app.end();
});

describe('el reenvío de acceso del equipo · medskin_resend_team_access (0019)', () => {
  it('la dueña reenvía el acceso de su recepcionista, y recibe el correo al que mandarlo', async () => {
    const before = await credentialOf(A.desk.account);
    const [out] = await resend(ctxOwnerA, A.desk.practitioner);

    expect(out?.outcome).toBe('acceso_renovado');
    // El correo, que es lo que `app_practitioner` no puede leer de `account` por su cuenta.
    expect(out?.email).toBe('recepcion.a@equipo.local');
    expect(out?.expires_at).not.toBeNull();

    const after = await credentialOf(A.desk.account);
    expect(after?.hash).toBe(NEW_TEMP);
    expect(after?.is_temporary).toBe(true);
    // La 0017 también aquí: ya probó que tiene su correo y eso no se des-ocurre.
    expect(after?.temp_first_used_at).toEqual(before?.temp_first_used_at);
    expect(after?.temp_first_used_at).not.toBeNull();
  });

  it('la función no devuelve el hash ni nada más que el veredicto, el correo y la caducidad', async () => {
    const [out] = await read<Record<string, unknown>>(
      ctxOwnerA,
      `select * from medskin_resend_team_access($1, $2, now() + interval '72 hours')`,
      [A.desk.practitioner, NEW_TEMP],
    );
    expect(Object.keys(out ?? {}).sort()).toEqual(['email', 'expires_at', 'outcome']);
  });

  it('el miembro de otra consulta es «member_not_found», igual que un id inventado', async () => {
    // El aislamiento de esta función: el inquilino A no alcanza la credencial del B ni
    // nombrando su `practitioner_id`, y no puede distinguir que existe.
    expect(await Promise.all([resend(ctxOwnerA, B.desk.practitioner), resend(ctxOwnerA, NOBODY)])).toEqual([
      [{ outcome: 'member_not_found', email: null, expires_at: null }],
      [{ outcome: 'member_not_found', email: null, expires_at: null }],
    ]);
    // Y la credencial del B sigue intacta.
    expect((await credentialOf(B.desk.account))?.hash).toBe(HASH);
  });

  it('retirada, cuenta borrada y la propia fila de quien llama dan el mismo veredicto', async () => {
    const outcomes = await Promise.all([
      resend(ctxOwnerA, A.retired.practitioner),
      resend(ctxOwnerA, A.deleted.practitioner),
      // La dueña no se reenvía el acceso a sí misma: su salida es «Olvidé mi contraseña».
      // Si esto se permitiera, podría acuñarse credenciales sin saber su contraseña actual,
      // que es lo que `PATCH /v1/cuentas/mia/contrasena` exige.
      resend(ctxOwnerA, A.owner.practitioner),
    ]);
    expect(outcomes.map((rows) => rows[0]?.outcome)).toEqual([
      'member_not_found',
      'member_not_found',
      'member_not_found',
    ]);
  });

  it('quien no es la dueña no reenvía nada, ni de un miembro que sí existe', async () => {
    // La segunda doctora de la MISMA consulta: tiene contexto de inquilino válido y el
    // `EXECUTE` de su rol. Lo que no tiene es la fila de `practice.owner_account_id`.
    expect(await resend(ctxSecondA, A.desk.practitioner)).toEqual([
      { outcome: 'not_owner', email: null, expires_at: null },
    ]);
    // Y la dueña de B tampoco llega a un miembro de A: para ella es `member_not_found`,
    // porque en SU consulta esa fila no existe.
    expect((await resend(ctxOwnerB, A.desk.practitioner))[0]?.outcome).toBe('member_not_found');
  });

  it('a quien ya eligió su contraseña no se la resetea la dueña', async () => {
    expect(await resend(ctxOwnerA, A.chosen.practitioner)).toEqual([
      { outcome: 'ya_eligio_su_contrasena', email: null, expires_at: null },
    ]);
    const after = await credentialOf(A.chosen.account);
    expect({ hash: after?.hash, temporary: after?.is_temporary }).toEqual({ hash: HASH, temporary: false });
  });

  it('valida sus argumentos y no la ejecuta ningún otro rol', async () => {
    await expect(
      read(ctxOwnerA, `select * from medskin_resend_team_access($1, 'no-es-argon2', now() + interval '1 hour')`, [
        A.desk.practitioner,
      ]),
    ).rejects.toThrow(/no viene hasheada con Argon2id/);
    await expect(
      read(ctxOwnerA, `select * from medskin_resend_team_access($1, $2, now() + interval '80 hours')`, [
        A.desk.practitioner,
        NEW_TEMP,
      ]),
    ).rejects.toThrow(/la temporal vive 72 h/);

    for (const ctx of [ctxPlatform, ctxPatient, ctxAnonymous]) {
      await expect(
        read(ctx, `select * from medskin_resend_team_access($1, $2, now() + interval '72 hours')`, [
          A.desk.practitioner,
          NEW_TEMP,
        ]),
      ).rejects.toThrow(/permission denied for function/i);
    }
  });
});
