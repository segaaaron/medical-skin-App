// EL REMITENTE DE ANDROID · FCM HTTP v1.
//
// `servicios.md:73` prescribía `google-auth-library`, y NO SE AÑADE: lo único que esa
// biblioteca hace aquí es acuñar un JWT y cambiarlo por un token de acceso, y las dos cosas ya
// están en el proyecto —`jose` firma los tokens de sesión y `fetch` es de Node—. Son treinta
// líneas contra una dependencia con su propio árbol, y la decisión queda anotada en
// `servicios.md`. Si algún día hace falta algo más de Google (Cloud Storage, Pub/Sub), esa es
// la conversación para traerla.
//
// El flujo es el estándar de una cuenta de servicio: se firma un JWT con el `scope` de FCM, se
// cambia en `oauth2.googleapis.com/token` por un token de acceso de una hora, y ese token va
// en la cabecera de cada envío. El token se reusa; acuñar uno por mensaje es gastar una ida y
// vuelta a Google por push.

import { readFileSync } from 'node:fs';

import { SignJWT, importPKCS8 } from 'jose';

import type { DeviceRow, PushPort, PushResult } from '../domain/ports';

export type FcmConfig = {
  /** El JSON de la cuenta de servicio que descarga la consola de Firebase. */
  serviceAccountPath: string;
};

type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_LIFE_MS = 50 * 60 * 1000;

export class FcmPush implements PushPort {
  readonly platform = 'android' as const;

  private account: ServiceAccount | null = null;
  private token: { value: string; until: number } | null = null;

  constructor(private readonly cfg: FcmConfig) {}

  async send(
    device: DeviceRow,
    message: { title: string; body: string; data: Record<string, unknown> },
  ): Promise<PushResult> {
    let access: string;
    let account: ServiceAccount;
    try {
      account = this.credentials();
      access = await this.accessToken();
    } catch (cause) {
      return { outcome: 'failed', reason: `fcm sin credencial: ${reasonOf(cause)}` };
    }

    const body = JSON.stringify({
      message: {
        token: device.token,
        notification: { title: message.title, body: message.body },
        // FCM exige que `data` sea de cadena a cadena. Son identificadores, así que caben.
        data: stringMap(message.data),
        android: { priority: 'normal' },
      },
    });

    let response: Response;
    try {
      response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch (cause) {
      return { outcome: 'failed', reason: `fcm sin respuesta: ${reasonOf(cause)}` };
    }

    if (response.ok) return { outcome: 'ok' };

    const text = await response.text().catch(() => '');
    // `UNREGISTERED` y `INVALID_ARGUMENT` sobre el token son «ese token ya no existe». Las dos
    // llegan como 404 y 400, y las dos se borran.
    if (text.includes('UNREGISTERED') || text.includes('registration-token-not-registered')) {
      return { outcome: 'gone', reason: `fcm ${response.status}` };
    }
    return { outcome: 'failed', reason: `fcm ${response.status} ${text.slice(0, 200)}` };
  }

  private credentials(): ServiceAccount {
    if (this.account !== null) return this.account;
    const parsed = JSON.parse(readFileSync(this.cfg.serviceAccountPath, 'utf8')) as ServiceAccount;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      throw new Error('la cuenta de servicio de FCM no trae project_id, client_email y private_key');
    }
    this.account = parsed;
    return parsed;
  }

  /** El token de acceso de Google, reusado 50 minutos. */
  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token !== null && this.token.until > now) return this.token.value;

    const account = this.credentials();
    const key = await importPKCS8(account.private_key, 'RS256');
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(account.client_email)
      .setAudience('https://oauth2.googleapis.com/token')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`google no dio token de acceso: ${response.status}`);
    }
    const granted = (await response.json()) as { access_token?: string };
    if (typeof granted.access_token !== 'string') {
      throw new Error('google devolvió un token de acceso que no es una cadena');
    }
    this.token = { value: granted.access_token, until: now + TOKEN_LIFE_MS };
    return granted.access_token;
  }
}

function stringMap(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    // Solo lo que es un valor simple: los identificadores lo son. Un objeto se convertiría en
    // `[object Object]`, que no es un dato, y aquí no hay nada anidado que mandar.
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
