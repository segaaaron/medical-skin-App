// URLs FIRMADAS PARA EL ALMACENAMIENTO DE OBJETOS · SigV4 escrito a mano.
//
// NINGÚN BYTE DE IMAGEN PASA POR LA API (§7.1): la app sube directo al almacenamiento con un
// enlace firmado de vida corta, y lo lee igual. Eso es lo único que esta pieza hace.
//
// POR QUÉ A MANO Y NO CON EL SDK DE AWS: firmar una URL es un HMAC sobre una cadena con un
// formato fijo, y son sesenta líneas. El SDK son tres paquetes, su propio cargador de
// credenciales, su reintentador y su telemetría, para no usar nada de eso: el almacenamiento de
// producción es **Garage** —S3 compatible, autoalojado— y lo que se necesita de él es
// exactamente esto. `docs/diseno/servicios.md` nombra Garage y no nombra ningún SDK.
//
// Y LA CLAVE NO DICE DE QUIÉN ES LA FOTO: `<photo_id>/<derivada>`, con un `photo_id` opaco. Ni
// el nombre de la paciente, ni su identificador, ni el de la consulta. Una URL reenviada no
// revela a quién pertenece, y caduca en minutos.

import { createHash, createHmac } from 'node:crypto';

export type StorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  /** LocalStack y Garage sirven por ruta; S3 de verdad, por subdominio. */
  forcePathStyle: boolean;
};

export type SignedUrl = { url: string; expiresAt: Date };

const ALGORITHM = 'AWS4-HMAC-SHA256';
/** Lo que el contrato fija para cada uso. Cinco minutos para subir, dos para la maestra. */
export const EXPIRY = {
  upload: 5 * 60,
  derivative: 15 * 60,
  master: 2 * 60,
} as const;

/**
 * Un enlace firmado para `GET`, `PUT` o `DELETE`. La firma va en la query (`presigned URL`),
 * que es lo que permite que el teléfono suba sin cabeceras de autorización.
 *
 * **EL MÉTODO ENTRA EN LA FIRMA**, y es la primera línea del `canonicalRequest` de aquí abajo:
 * un enlace firmado para `GET` usado con `DELETE` da otra cadena, y el almacenamiento responde
 * `SignatureDoesNotMatch`. Hasta el 29 de octubre de 2026 los tres sitios que borran objetos
 * firmaban un `GET` y llamaban con `DELETE`, con un `.catch()` que se comía el 403: **en
 * producción no borraban nada y la fila decía que sí**. No se vio porque LocalStack **no
 * comprueba firmas** —medido: acepta un `DELETE` con una firma de 64 ceros y borra el
 * objeto—, así que la prueba de integración pasaba en verde contra un almacenamiento que no
 * valida lo que se estaba probando. Es la lección de «verde no es prueba» en su forma más
 * incómoda: la prueba era real, el almacenamiento no.
 */
export function signUrl(
  config: StorageConfig,
  p: {
    method: 'GET' | 'PUT' | 'DELETE';
    key: string;
    expiresInSeconds: number;
    now: Date;
    contentType?: string;
  },
): SignedUrl {
  const host = hostOf(config);
  // LA CLAVE VACÍA ES EL CUBO, y no lleva barra al final: `PUT /medskin-dev` crea el cubo y
  // `PUT /medskin-dev/` es otra ruta, así que otra firma. Firmar una y pedir la otra daba
  // `SignatureDoesNotMatch`, y las pruebas lo tapaban con un `.replace()` sobre la URL porque
  // LocalStack no comprobaba firmas. Ahora las comprueba y esto tiene que cuadrar.
  const path = config.forcePathStyle
    ? p.key === ''
      ? `/${config.bucket}`
      : `/${config.bucket}/${p.key}`
    : `/${p.key}`;

  const amzDate = stamp(p.now);
  const dateOnly = amzDate.slice(0, 8);
  const credentialScope = `${dateOnly}/${config.region}/s3/aws4_request`;

  const query: [string, string][] = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${config.accessKey}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(p.expiresInSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  // Las dos listas van ORDENADAS y codificadas igual que en la firma: un orden distinto da
  // otra cadena y el almacenamiento responde `SignatureDoesNotMatch` sin decir por qué.
  const canonicalQuery = query
    .map(([key, value]) => [encode(key), encode(value)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const canonicalRequest = [
    p.method,
    path.split('/').map(encodePathSegment).join('/'),
    canonicalQuery,
    `host:${host}\n`,
    'host',
    // `UNSIGNED-PAYLOAD`: el cuerpo lo manda el teléfono y no lo vemos, así que no se puede
    // firmar su hash. Es lo que hace posible subir sin que el archivo pase por aquí.
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const signature = hmac(signingKey(config, dateOnly), stringToSign).toString('hex');

  return {
    url: `${config.endpoint.replace(/\/$/, '')}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    expiresAt: new Date(p.now.getTime() + p.expiresInSeconds * 1000),
  };
}

/** La llave derivada del día, la región y el servicio. Es la cadena de cuatro HMAC de SigV4. */
function signingKey(config: StorageConfig, dateOnly: string): Buffer {
  const first = hmac(Buffer.from(`AWS4${config.secretKey}`, 'utf8'), dateOnly);
  const second = hmac(first, config.region);
  const third = hmac(second, 's3');
  return hmac(third, 'aws4_request');
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function hostOf(config: StorageConfig): string {
  const url = new URL(config.endpoint);
  return config.forcePathStyle ? url.host : `${config.bucket}.${url.host}`;
}

/** El codificado de SigV4: todo menos `A-Za-z0-9-_.~`, y la barra TAMBIÉN en la query. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** En la ruta, la barra separa y no se codifica; lo demás, igual que en la query. */
function encodePathSegment(segment: string): string {
  return encode(segment);
}

function stamp(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}

/**
 * LAS CLAVES SON DETERMINISTAS Y OPACAS, y las dos cosas importan: deterministas para que
 * reprocesar escriba exactamente donde estaba —así reintentar es gratis y seguro (§8.4)— y
 * opacas para que la URL no diga de quién es la foto.
 */
export const KEYS = {
  master: (photoId: string) => `${photoId}/master`,
  thumb: (photoId: string) => `${photoId}/thumb.avif`,
  view: (photoId: string) => `${photoId}/view.avif`,
  full: (photoId: string) => `${photoId}/full.avif`,
  upload: (photoId: string) => `${photoId}/upload`,
} as const;
