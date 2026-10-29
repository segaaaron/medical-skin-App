// EL REMITENTE DE iOS · APNs con el `http2` de Node y un token JWT. CERO DEPENDENCIAS, y es lo
// que manda `servicios.md:72`: APNs es HTTP/2 con una cabecera de autorización, y eso ya está
// en la biblioteca estándar. Una dependencia para firmar un JWT no hace falta cuando `jose` ya
// está en el proyecto para los tokens de sesión.
//
// LO QUE EL PUSH LLEVA, y nada más: `alert.title`, `alert.body` —las dos frases neutras de
// `SUBJECTS`— y los identificadores de `data`. Ni un dato clínico (§11.1).
//
// LA CONEXIÓN SE REUSA. APNs penaliza al remitente que abre una conexión por mensaje, y los
// lotes de 500 del contrato no tendrían sentido con una conexión nueva cada vez: se guarda la
// sesión HTTP/2 y se reabre sola cuando el proveedor la cierra.
//
// EL TOKEN DE AUTORIZACIÓN SE REUSA UNA HORA. Apple admite hasta 60 minutos y rechaza al
// remitente que acuña uno por mensaje (`TooManyProviderTokenUpdates`), que es el error que más
// desconcierta la primera vez.

import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { readFileSync } from 'node:fs';

import { SignJWT, importPKCS8 } from 'jose';

import type { DeviceRow, PushPort, PushResult } from '../domain/ports';

export type ApnsConfig = {
  /** El `.p8` que descarga Apple. En producción lo pone el servicio de llaves, nunca el repo. */
  keyPath: string;
  keyId: string;
  teamId: string;
  /** El identificador del paquete de la app. Es el `apns-topic`. */
  topic: string;
  /** `api.push.apple.com` en producción, `api.sandbox.push.apple.com` en desarrollo. */
  host: string;
};

const TOKEN_LIFE_MS = 50 * 60 * 1000;

export class ApnsPush implements PushPort {
  readonly platform = 'ios' as const;

  private session: ClientHttp2Session | null = null;
  private token: { value: string; until: number } | null = null;
  private key: Awaited<ReturnType<typeof importPKCS8>> | null = null;

  constructor(private readonly cfg: ApnsConfig) {}

  async send(
    device: DeviceRow,
    message: { title: string; body: string; data: Record<string, unknown> },
  ): Promise<PushResult> {
    let session: ClientHttp2Session;
    try {
      session = this.open();
    } catch (cause) {
      return { outcome: 'failed', reason: `apns sin conexión: ${reasonOf(cause)}` };
    }

    const payload = JSON.stringify({
      aps: {
        alert: { title: message.title, body: message.body },
        sound: 'default',
        // `mutable-content` para que la app pueda pedir el contenido real antes de mostrarlo:
        // es el mecanismo que hace posible que el push no lleve nada clínico.
        'mutable-content': 1,
      },
      ...message.data,
    });

    let authorization: string;
    try {
      authorization = await this.authorization();
    } catch (cause) {
      return { outcome: 'failed', reason: `apns sin token: ${reasonOf(cause)}` };
    }

    return new Promise<PushResult>((resolve) => {
      const request = session.request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${device.token}`,
        [constants.HTTP2_HEADER_AUTHORIZATION]: `bearer ${authorization}`,
        'apns-topic': this.cfg.topic,
        'apns-push-type': 'alert',
        // Un recordatorio no es urgente a costa de la batería; un hueco libre tampoco pasa de
        // aquí. `5` es «entrégalo cuando puedas», que es lo correcto para todo lo que mandamos.
        'apns-priority': '5',
        [constants.HTTP2_HEADER_CONTENT_TYPE]: 'application/json',
      });

      let status = 0;
      let body = '';
      request.setTimeout(10_000, () => {
        request.close();
        resolve({ outcome: 'failed', reason: 'apns no respondió en 10 s' });
      });
      request.on('response', (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      request.on('error', (cause) => resolve({ outcome: 'failed', reason: reasonOf(cause) }));
      request.on('end', () => {
        if (status === 200) return resolve({ outcome: 'ok' });
        // 410 es «ese token ya no existe». 400 con `BadDeviceToken` es lo mismo con otra
        // puerta: un token de otra app o uno del entorno equivocado. Las dos se borran.
        if (status === 410 || body.includes('BadDeviceToken') || body.includes('Unregistered')) {
          return resolve({ outcome: 'gone', reason: `apns ${status}` });
        }
        resolve({ outcome: 'failed', reason: `apns ${status} ${body.slice(0, 200)}` });
      });
      request.end(payload);
    });
  }

  close(): void {
    this.session?.close();
    this.session = null;
  }

  private open(): ClientHttp2Session {
    if (this.session !== null && !this.session.closed && !this.session.destroyed) {
      return this.session;
    }
    const session = connect(`https://${this.cfg.host}`);
    // Sin esto, un error de la sesión —el proveedor la cierra cada cierto tiempo— sería un
    // rechazo sin dueño que tumba el proceso.
    session.on('error', () => {
      this.session = null;
    });
    session.on('close', () => {
      this.session = null;
    });
    this.session = session;
    return session;
  }

  /** El JWT ES256 de Apple, acuñado una vez cada 50 minutos. */
  private async authorization(): Promise<string> {
    const now = Date.now();
    if (this.token !== null && this.token.until > now) return this.token.value;

    if (this.key === null) {
      this.key = await importPKCS8(readFileSync(this.cfg.keyPath, 'utf8'), 'ES256');
    }
    const value = await new SignJWT({ iss: this.cfg.teamId })
      .setProtectedHeader({ alg: 'ES256', kid: this.cfg.keyId })
      .setIssuedAt()
      .sign(this.key);

    this.token = { value, until: now + TOKEN_LIFE_MS };
    return value;
  }
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
