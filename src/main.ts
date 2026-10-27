import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

async function arrancar() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // trustProxy: el borde resuelve la región y reenvía; sin esto la IP real se pierde
    // y el límite de ritmo contaría todas las peticiones como una sola.
    new FastifyAdapter({ trustProxy: true, bodyLimit: 1 * 1024 * 1024 }),
  );

  // Ningún byte de imagen pasa por la API, así que el cuerpo nunca necesita ser grande.
  // CORS cerrado: se abre por orígenes conocidos cuando exista el primer cliente web.
  const puerto = Number(process.env.PORT ?? 3000);
  await app.listen(puerto, '0.0.0.0');
  process.stdout.write(`medskin-api escuchando en ${puerto}\n`);
}

void arrancar();
