// El tramo 6 contra la base real Y contra el almacenamiento real (LocalStack).
//
// Lo que se prueba: que sin consentimiento de imágenes no se firma nada, que la foto sube por
// un enlace firmado SIN pasar por la API, que el trabajador valida por los BYTES y deriva, que
// la maestra solo la abre la doctora, y que la paciente borra las suyas y ninguna más.

import { Pool } from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KEYS, signUrl, type StorageConfig } from '../../shared/storage/signed-url';
import type { Caller } from '../access/application/caller';
import { Photos } from './application/photos';
import { JXL_AVAILABLE, PhotoWorker } from './infrastructure/photo-worker';
import { PhotosRepository } from './infrastructure/photos.repository';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ??
  'postgresql://medskin_owner:dev_local_only@localhost:5433/medskin';
const appUrl = process.env.DATABASE_URL ?? 'postgresql://medskin:dev_local_only@localhost:5433/medskin';

const storage: StorageConfig = {
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:4566',
  region: process.env.S3_REGION ?? 'us-east-1',
  bucket: process.env.S3_BUCKET ?? 'medskin-dev',
  accessKey: process.env.S3_ACCESS_KEY ?? 'test',
  secretKey: process.env.S3_SECRET_KEY ?? 'test',
  forcePathStyle: true,
};

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const app = new Pool({ connectionString: appUrl, max: 2 });
const clock = { now: () => new Date() };

const repo = new PhotosRepository(app, storage);
const photos = new Photos(repo, clock);
// Un registro de fallos que no hace nada: lo que esta prueba mira es la FOTO, y
// `service-failure.spec.ts` ya cubre que el registro no lanza nunca.
const failures = {
  record: () => Promise.resolve(undefined),
};
const worker = new PhotoWorker(app, storage, failures as never);

const P = {
  practice: '22222222-0000-4000-8000-000000000001',
  doctor: '22222222-0000-4000-8000-000000000011',
  assistant: '22222222-0000-4000-8000-000000000012',
  patient: '22222222-0000-4000-8000-000000000021',
  account: '22222222-0000-4000-8000-000000000031',
};
let treatment = '';

function staff(account: string, role: 'doctora' | 'asistente_clinico'): Caller {
  return {
    accountId: account,
    sessionId: '22222222-0000-4000-8000-0000000000ff',
    role,
    accountRole: 'practitioner',
    scope: 'completo',
    region: 'latam',
    practiceId: P.practice,
    permissions: ['sesiones:registrar', 'historia:leer'],
  };
}

const ana: Caller = {
  accountId: P.account,
  sessionId: '22222222-0000-4000-8000-0000000000fe',
  role: 'paciente',
  accountRole: 'paciente',
  scope: 'completo',
  region: 'latam',
  practiceId: null,
  permissions: [],
};

/** Una foto de verdad: 800×800, lo bastante grande para pasar el mínimo de 320. */
async function aPhoto(): Promise<Buffer> {
  return sharp({
    create: { width: 800, height: 800, channels: 3, background: { r: 240, g: 220, b: 210 } },
  })
    .jpeg()
    .toBuffer();
}

async function uploadTo(photoId: string, bytes: Buffer): Promise<number> {
  const url = signUrl(storage, {
    method: 'PUT',
    key: KEYS.upload(photoId),
    expiresInSeconds: 300,
    now: new Date(),
  });
  const response = await fetch(url.url, { method: 'PUT', body: new Uint8Array(bytes) });
  return response.status;
}

async function objectExists(key: string): Promise<boolean> {
  const url = signUrl(storage, { method: 'GET', key, expiresInSeconds: 60, now: new Date() });
  const response = await fetch(url.url);
  void (await response.arrayBuffer());
  return response.ok;
}

beforeAll(async () => {
  // El cubo de desarrollo: LocalStack arranca vacío y en producción lo crea el despliegue.
  const bucket = signUrl(storage, { method: 'PUT', key: '', expiresInSeconds: 60, now: new Date() });
  // Sin tocar la URL: la clave vacía firma `/<cubo>` y eso es lo que se pide. El `.replace()`
  // que había aquí funcionaba porque LocalStack no comprobaba la firma —ahora sí—.
  await fetch(bucket.url, { method: 'PUT' });

  await owner.query(`delete from practice where id = $1`, [P.practice]);
  await owner.query(`delete from account where id = any($1::uuid[])`, [
    [P.doctor, P.assistant, P.account],
  ]);

  await owner.query(
    `insert into practice (id, name, region, country, time_zone, currency, plan, patient_limit)
     values ($1, 'Clínica Paz', 'latam', 'BO', 'America/La_Paz', 'BOB', 'consultorio', 300)`,
    [P.practice],
  );
  for (const [account, role] of [
    [P.doctor, 'doctora'],
    [P.assistant, 'asistente_clinico'],
  ] as const) {
    await owner.query(
      `insert into account (id, email, role, region, first_name, last_name)
       values ($1, $2, 'practitioner', 'latam', 'Andrea', 'Paz')`,
      [account, `${account.slice(-3)}@tramo6.local`],
    );
    await owner.query(
      `insert into practitioner (practice_id, account_id, role, status, first_name, last_name)
       values ($1, $2, $3, 'activa', 'Andrea', 'Paz')`,
      [P.practice, account, role],
    );
  }
  await owner.query(
    `insert into account (id, email, role, region, first_name, last_name)
     values ($1, 'ana@tramo6.local', 'paciente', 'latam', 'Ana', 'Antelo')`,
    [P.account],
  );
  await owner.query(
    `insert into patient (id, practice_id, first_name, last_name, birth_date, email, how_arrived)
     values ($1, $2, 'Ana', 'Antelo', '1992-04-18', 'ana.ficha@tramo6.local', 'instagram')`,
    [P.patient, P.practice],
  );
  await owner.query(`insert into medical_history (practice_id, patient_id) values ($1, $2)`, [
    P.practice,
    P.patient,
  ]);
  await owner.query(
    `insert into patient_link (practice_id, patient_id, account_id, status, email, practice_name,
                               practitioner_name)
     values ($1, $2, $3, 'vinculada', 'ana@tramo6.local', 'Clínica Paz', 'Dra. Andrea Paz')`,
    [P.practice, P.patient, P.account],
  );
  const { rows } = await owner.query<{ id: string }>(
    `insert into treatment (practice_id, name, category, duration_minutes, planned_sessions)
     values ($1, 'Toxina', 'toxina', 40, 1) returning id`,
    [P.practice],
  );
  treatment = rows[0]!.id;
});

afterAll(async () => {
  await owner.query(`delete from practice where id = $1`, [P.practice]);
  await owner.query(`delete from account where id = any($1::uuid[])`, [
    [P.doctor, P.assistant, P.account],
  ]);
  await owner.end();
  await app.end();
});

describe('el consentimiento de imágenes es la puerta', () => {
  it('sin él no se firma nada, y la foto se queda en el teléfono', async () => {
    await expect(
      photos.uploadUrl(
        {
          patient_id: P.patient,
          vista: 'frente',
          tipo_declarado: 'image/jpeg',
          bytes_declarados: 120_000,
        },
        staff(P.doctor, 'doctora'),
      ),
    ).rejects.toMatchObject({ code: 'sin_consentimiento_de_imagenes' });
  });

  it('con él, firma un enlace de cinco minutos', async () => {
    await owner.query(
      `insert into consent (practice_id, patient_id, treatment_id, purpose, version, answers)
       values ($1, $2, $3, 'imagenes', '2026-09-01', '{}'::jsonb)`,
      [P.practice, P.patient, treatment],
    );

    const signed = (await photos.uploadUrl(
      {
        patient_id: P.patient,
        vista: 'frente',
        tipo_declarado: 'image/jpeg',
        bytes_declarados: 120_000,
        tomada_en: '2026-08-03T15:40:00Z',
      },
      staff(P.doctor, 'doctora'),
    )) as { photo_id: string; subida: { url: string; metodo: string; bytes_maximos: number } };

    expect(signed.subida.metodo).toBe('PUT');
    expect(signed.subida.bytes_maximos).toBe(26_214_400);
    // La URL no dice de quién es la foto: ni el nombre, ni la paciente, ni la consulta.
    expect(signed.subida.url).not.toContain(P.patient);
    expect(signed.subida.url).not.toContain(P.practice);
    expect(signed.subida.url.toLowerCase()).not.toContain('ana');
  });

  it('un tipo que no es foto y una vista inventada no llegan ni a firmarse', async () => {
    await expect(
      photos.uploadUrl(
        { patient_id: P.patient, vista: 'frente', tipo_declarado: 'application/pdf', bytes_declarados: 10 },
        staff(P.doctor, 'doctora'),
      ),
    ).rejects.toMatchObject({ code: 'tipo_no_admitido' });

    await expect(
      photos.uploadUrl(
        { patient_id: P.patient, vista: 'nuca', tipo_declarado: 'image/jpeg', bytes_declarados: 10 },
        staff(P.doctor, 'doctora'),
      ),
    ).rejects.toMatchObject({ code: 'vista_desconocida' });
  });
});

describe('subir, confirmar y procesar', () => {
  it('la foto sube por el enlace, el trabajador la valida por los bytes y deriva', async () => {
    const signed = (await photos.uploadUrl(
      {
        patient_id: P.patient,
        vista: 'frente',
        tipo_declarado: 'image/jpeg',
        bytes_declarados: 200_000,
        tomada_en: '2026-08-03T15:40:00Z',
      },
      staff(P.doctor, 'doctora'),
    )) as { photo_id: string };

    // Sube DIRECTO al almacenamiento: ni un byte pasa por la API.
    expect(await uploadTo(signed.photo_id, await aPhoto())).toBe(200);

    const confirmed = (await photos.confirm(signed.photo_id, staff(P.doctor, 'doctora'))) as {
      estado: string;
    };
    expect(confirmed.estado).toBe('procesando');

    // El trabajador, que corre fuera de la petición.
    expect(await worker.run()).toBeGreaterThan(0);

    const { rows } = await owner.query<{
      status: string;
      real_type: string;
      width: number;
      master_format: string;
      derivatives_ready: boolean;
    }>(
      `select status, real_type, width, master_format, derivatives_ready from photo where id = $1`,
      [signed.photo_id],
    );
    expect(rows[0]).toMatchObject({
      status: 'lista',
      real_type: 'image/jpeg',
      width: 800,
      derivatives_ready: true,
      // Medido: esta compilación de libvips NO trae libjxl, así que la maestra se guarda tal
      // cual y se anota. Nunca se degrada por un problema de codificador.
      master_format: JXL_AVAILABLE ? 'jxl' : 'original',
    });

    // Las tres derivadas y la maestra están en el almacenamiento, con claves deterministas.
    expect(await objectExists(KEYS.thumb(signed.photo_id))).toBe(true);
    expect(await objectExists(KEYS.view(signed.photo_id))).toBe(true);
    expect(await objectExists(KEYS.full(signed.photo_id))).toBe(true);
    expect(await objectExists(KEYS.master(signed.photo_id))).toBe(true);
  });

  it('un archivo que no es una foto queda `fallida` y el objeto se borra', async () => {
    const signed = (await photos.uploadUrl(
      {
        patient_id: P.patient,
        vista: 'libre',
        tipo_declarado: 'image/jpeg',
        bytes_declarados: 100,
      },
      staff(P.doctor, 'doctora'),
    )) as { photo_id: string };

    // Declara JPEG y sube texto: lo que manda son los BYTES.
    await uploadTo(signed.photo_id, Buffer.from('esto no es una foto, es texto plano'));
    await photos.confirm(signed.photo_id, staff(P.doctor, 'doctora'));
    await worker.run();

    const { rows } = await owner.query<{ status: string; failed_reason: string; attempts: number }>(
      `select status, failed_reason, attempts from photo where id = $1`,
      [signed.photo_id],
    );
    // Un intento, y la foto en `procesando` con su motivo hasta el tercero: tres fallos y
    // queda `fallida`. Lo que NO pasa nunca es que se guarde.
    expect(rows[0]?.failed_reason).toBe('Ese archivo no es una foto.');
    expect(await objectExists(KEYS.master(signed.photo_id))).toBe(false);
  });

  it('confirmar sin haber subido nada es un 409', async () => {
    const signed = (await photos.uploadUrl(
      { patient_id: P.patient, vista: 'perfil_izq', tipo_declarado: 'image/jpeg', bytes_declarados: 100 },
      staff(P.doctor, 'doctora'),
    )) as { photo_id: string };

    await expect(photos.confirm(signed.photo_id, staff(P.doctor, 'doctora'))).rejects.toMatchObject({
      code: 'no_se_subio',
    });
  });
});

describe('quién ve qué', () => {
  it('la lista trae thumb y view, nunca full, y deja su línea en la auditoría', async () => {
    const seen = (await photos.list(
      { patient_id: P.patient },
      staff(P.doctor, 'doctora'),
    )) as { fotos: { id: string; estado: string; enlaces: Record<string, unknown> }[] };

    const ready = seen.fotos.find((photo) => photo.estado === 'lista')!;
    expect(Object.keys(ready.enlaces).sort()).toEqual(['thumb', 'view']);

    const { rows } = await owner.query<{ n: string }>(
      `select count(*)::text as n from access_audit
        where subject_id = $1 and action = 'paciente.fotos_abiertas'`,
      [P.patient],
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });

  it('la maestra la abre la doctora y nadie más', async () => {
    const { rows } = await owner.query<{ id: string }>(
      `select id from photo where practice_id = $1 and status = 'lista' limit 1`,
      [P.practice],
    );
    const photoId = rows[0]!.id;

    const opened = (await photos.master(photoId, staff(P.doctor, 'doctora'))) as { url: string };
    expect(opened.url).toContain(`${photoId}/master`);

    await expect(photos.master(photoId, staff(P.assistant, 'asistente_clinico'))).rejects.toMatchObject(
      { code: 'sin_permiso' },
    );
    await expect(photos.master(photoId, ana)).rejects.toMatchObject({ code: 'sin_permiso' });

    // Y queda quién la abrió: es el objeto más sensible del sistema.
    const { rows: audit } = await owner.query<{ n: string }>(
      `select count(*)::text as n from access_audit where action = 'foto.maestra_abierta'
        and subject_id = $1`,
      [photoId],
    );
    expect(Number(audit[0]?.n)).toBe(1);
  });

  it('comparar siempre usa full, y dos vistas distintas no se comparan', async () => {
    // Una segunda foto de la MISMA vista, tres meses después.
    const signed = (await photos.uploadUrl(
      {
        patient_id: P.patient,
        vista: 'frente',
        tipo_declarado: 'image/jpeg',
        bytes_declarados: 200_000,
        tomada_en: '2026-11-03T15:40:00Z',
      },
      staff(P.doctor, 'doctora'),
    )) as { photo_id: string };
    await uploadTo(signed.photo_id, await aPhoto());
    await photos.confirm(signed.photo_id, staff(P.doctor, 'doctora'));
    await worker.run();

    const compared = (await photos.compare(signed.photo_id, {}, ana)) as {
      vista: string;
      par: { full: { url: string } }[];
      dias_entre: number | null;
    };
    expect(compared.vista).toBe('frente');
    expect(compared.par).toHaveLength(2);
    // SIEMPRE `full`: una decisión clínica no se toma sobre una miniatura, y para ella tampoco
    // —su progreso es suyo y mirarlo pixelado no es un ahorro—.
    expect(compared.par.every((photo) => photo.full.url.includes('full.avif'))).toBe(true);
    expect(compared.dias_entre).toBe(92);

    // Dos vistas distintas no se comparan.
    const other = (await photos.uploadUrl(
      { patient_id: P.patient, vista: 'perfil_der', tipo_declarado: 'image/jpeg', bytes_declarados: 100 },
      staff(P.doctor, 'doctora'),
    )) as { photo_id: string };
    await expect(
      photos.compare(signed.photo_id, { con: other.photo_id }, staff(P.doctor, 'doctora')),
    ).rejects.toMatchObject({ code: 'vistas_distintas' });
  });
});

describe('borrar', () => {
  it('la paciente borra las suyas y ninguna del expediente', async () => {
    const { rows } = await owner.query<{ id: string }>(
      `select id from photo where practice_id = $1 and uploaded_by = 'doctora' limit 1`,
      [P.practice],
    );
    await expect(photos.remove(rows[0]!.id, {}, ana)).rejects.toMatchObject({
      code: 'foto_de_la_doctora',
    });

    // La suya sí, y queda la fila con su fecha: un hueco sin explicación es peor que el hueco.
    const { rows: hers } = await owner.query<{ id: string }>(
      `insert into photo (practice_id, patient_id, view, uploaded_by, declared_type,
                          declared_bytes, status)
       values ($1, $2, 'libre', 'paciente', 'image/jpeg', 1000, 'lista') returning id`,
      [P.practice, P.patient],
    );
    await expect(photos.remove(hers[0]!.id, { motivo: 'salí mal' }, ana)).resolves.toMatchObject({
      borrada: true,
    });

    const { rows: after } = await owner.query<{ deleted_at: Date | null; deleted_reason: string }>(
      `select deleted_at, deleted_reason from photo where id = $1`,
      [hers[0]!.id],
    );
    expect(after[0]?.deleted_at).not.toBeNull();
    expect(after[0]?.deleted_reason).toBe('salí mal');
  });
});

describe('archivar la ficha borra las derivadas, y reactivarla las devuelve', () => {
  it('la maestra se queda y las tres derivadas se van, con su camino de vuelta', async () => {
    // Una foto procesada de verdad: es la única forma de que haya derivadas que borrar.
    const signed = (await photos.uploadUrl(
      {
        patient_id: P.patient,
        vista: 'perfil_izq',
        tipo_declarado: 'image/jpeg',
        bytes_declarados: 200_000,
      },
      staff(P.doctor, 'doctora'),
    )) as { photo_id: string };
    expect(await uploadTo(signed.photo_id, await aPhoto())).toBe(200);
    await photos.confirm(signed.photo_id, staff(P.doctor, 'doctora'));
    await worker.run();
    expect(await objectExists(KEYS.thumb(signed.photo_id))).toBe(true);

    // La ficha se archiva. «Las derivadas de sus fotos se borran y la maestra se queda»
    // (`pacientes.md`), y hasta hoy nadie lo hacía.
    await owner.query(
      `update patient set status = 'archivada', archived_at = now() where id = $1`,
      [P.patient],
    );
    expect(await worker.purgeDerivatives()).toBeGreaterThan(0);

    expect(await objectExists(KEYS.thumb(signed.photo_id))).toBe(false);
    expect(await objectExists(KEYS.view(signed.photo_id))).toBe(false);
    expect(await objectExists(KEYS.full(signed.photo_id))).toBe(false);
    // LA MAESTRA NO SE TOCA: es la prueba legal del expediente.
    expect(await objectExists(KEYS.master(signed.photo_id))).toBe(true);

    const { rows } = await owner.query<{ derivatives_ready: boolean; status: string }>(
      `select derivatives_ready, status from photo where id = $1`,
      [signed.photo_id],
    );
    expect(rows[0]).toMatchObject({ derivatives_ready: false, status: 'lista' });

    // Y reactivarla las regenera desde la maestra: archivar no pierde nada.
    await owner.query(
      `update patient set status = 'activa', archived_at = null where id = $1`,
      [P.patient],
    );
    expect(await worker.rebuildDerivatives()).toBeGreaterThan(0);
    expect(await objectExists(KEYS.thumb(signed.photo_id))).toBe(true);
    expect(await objectExists(KEYS.full(signed.photo_id))).toBe(true);

    const { rows: back } = await owner.query<{ derivatives_ready: boolean }>(
      `select derivatives_ready from photo where id = $1`,
      [signed.photo_id],
    );
    expect(back[0]?.derivatives_ready).toBe(true);
  });
});

describe('borrar una foto se lleva los bytes, no solo la fila', () => {
  it('los cuatro objetos se van del almacenamiento, maestra incluida', async () => {
    const signed = (await photos.uploadUrl(
      {
        patient_id: P.patient,
        vista: 'oblicuo_izq',
        tipo_declarado: 'image/jpeg',
        bytes_declarados: 200_000,
      },
      staff(P.doctor, 'doctora'),
    )) as { photo_id: string };
    expect(await uploadTo(signed.photo_id, await aPhoto())).toBe(200);
    await photos.confirm(signed.photo_id, staff(P.doctor, 'doctora'));
    await worker.run();

    // La doctora la borra: hasta hoy eso marcaba la fila y dejaba los cuatro objetos en el
    // disco para siempre. Es disco que nadie contaba y es la cara de alguien que pidió que se
    // fuera.
    await photos.remove(signed.photo_id, { motivo: 'salió movida' }, staff(P.doctor, 'doctora'));
    expect(await worker.eraseDeleted()).toBeGreaterThan(0);

    expect(await objectExists(KEYS.thumb(signed.photo_id))).toBe(false);
    expect(await objectExists(KEYS.view(signed.photo_id))).toBe(false);
    expect(await objectExists(KEYS.full(signed.photo_id))).toBe(false);
    expect(await objectExists(KEYS.master(signed.photo_id))).toBe(false);

    // Y la fila se queda con su motivo y su sello: «un hueco sin explicación es peor».
    const { rows } = await owner.query<{ purged_at: Date | null; deleted_reason: string }>(
      `select purged_at, deleted_reason from photo where id = $1`,
      [signed.photo_id],
    );
    expect(rows[0]?.purged_at).not.toBeNull();
    expect(rows[0]?.deleted_reason).toBe('salió movida');

    // Y una segunda pasada no vuelve a hacer nada: idempotente por `purged_at`.
    const { rows: again } = await owner.query<{ n: string }>(
      `select count(*)::text as n from medskin_photos_to_erase(25)`,
    );
    expect(again[0]?.n).toBe('0');
  });
});
