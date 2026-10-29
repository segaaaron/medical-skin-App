import 'reflect-metadata';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';

import { AppModule } from './app.module';
import { pushSendersOf } from './modules/notifications/notifications.module';
import { config } from './shared/config/config';
import { assertDecoyParity } from './shared/security/decoy-parity';
import { POOL } from './shared/shared.module';

async function start() {
  // Lo primero: si falta una variable, el proceso no arranca y dice cuál.
  const cfg = config();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // trustProxy: el borde resuelve la región y reenvía; sin esto la IP real se pierde
    // y el límite de ritmo contaría todas las peticiones como una sola.
    // Ningún byte de imagen pasa por la API, así que el cuerpo nunca necesita ser grande.
    new FastifyAdapter({ trustProxy: true, bodyLimit: 1 * 1024 * 1024 }),
    // Sin stack traces al cliente: el filtro global es el único que contesta errores.
    { bufferLogs: true },
  );

  // `415 formato_no_admitido` DE VERDAD. Fastify trae parser propio de `text/plain`, así
  // que un cuerpo mandado con ese `Content-Type` se parseaba como cadena, no pasaba el
  // esquema del endpoint y se atendía como si viniera vacío: `POST /v1/access` respondía
  // `correo_vacio` con el correo escrito. Quitado el parser, Fastify responde 415 y el
  // filtro lo traduce. Esta API solo acepta JSON (_convenciones.md, 27 de octubre).
  app.getHttpAdapter().getInstance().removeContentTypeParser('text/plain');

  // Cabeceras de seguridad (OWASP A05). `contentSecurityPolicy` apagado: esta API no sirve
  // HTML ni scripts, y una CSP sobre JSON es ruido que nadie mantiene.
  await app.register(helmet, { contentSecurityPolicy: false });

  // CORS CERRADO: la lista sale de la configuración y una lista vacía no abre ningún
  // origen. Las dos apps nativas no mandan `Origin`, así que no necesitan ninguno.
  await app.register(cors, {
    origin: cfg.CORS_ORIGENES.length > 0 ? cfg.CORS_ORIGENES : false,
    credentials: false,
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'X-MedSkin-App',
      'X-MedSkin-Dispositivo',
      // Las dos del 27 de octubre (`_convenciones.md`). Opcionales, y por eso faltaban sin
      // romper nada: las apps nativas no mandan `Origin`. Un cliente de navegador que las
      // mande sin estar aquí ve la petición rechazada por el preflight, no una etiqueta
      // menos en «sesiones activas».
      'X-MedSkin-Modelo',
      'X-MedSkin-Sistema',
    ],
  });

  // Límite de ritmo por IP, la primera capa. El de acceso, recuperación y reenvío es el de
  // los contadores de Redis, que cuenta por correo y sobrevive a un cambio de IP: este de
  // aquí es contra el ruido, no contra el ataque dirigido (`diseño` · OWASP A04).
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  // Sin esto NO corre ningún `onApplicationShutdown`: ni el de `SharedModule` —que cierra
  // el pool y Redis— ni el de `RecoveryModule`, que cierra el trabajador de BullMQ y su
  // cola. En un despliegue rodante el trabajador moría con un trabajo a medias, y un
  // trabajo de correo a medias es una paciente esperando un código que nunca sale.
  app.enableShutdownHooks();

  // LA PARIDAD DEL SEÑUELO, antes de aceptar una sola petición: si el señuelo no cuesta lo
  // mismo que una contraseña real, el tiempo del `401 acceso_no_coincide` dice si un correo
  // tiene cuenta en MedSkin, y eso es dato de salud. El proceso no arranca y dice qué
  // difiere (migración 0007 · `medskin_access_decoy_params()`).
  await assertDecoyParity(app.get<Pool>(POOL));

  await app.listen(cfg.PORT, '0.0.0.0');

  // QUÉ CANALES DE PUSH HAY, DICHO AL ARRANCAR. Sin credencial no se construye el remitente y
  // los avisos se encolan y esperan —que es lo correcto, no se pierden—, pero eso no puede ser
  // un silencio: alguien tiene que poder ver de un vistazo que los push no están saliendo.
  // Sale el nombre del canal y nunca una ruta ni un identificador de llave.
  const canales = pushSendersOf(cfg).map((sender) => sender.platform);
  const push = canales.length === 0 ? 'push SIN CONFIGURAR' : `push: ${canales.join(' y ')}`;
  process.stdout.write(
    `medskin-api escuchando en ${cfg.PORT} · región ${cfg.REGION} · ${push}\n`,
  );
}

void start();
