// POR QUÉ EXISTE ESTA PRUEBA · 3 de noviembre de 2026.
//
// `POST /v1/platform/tenants` contestaba con `@Res()` a secas y era la ÚNICA ruta de las 109
// que salía SIN `{datos, meta}`. A las apps se les dijo —con razón— que toda respuesta buena
// lleva sobre, así que la consola leía `datos.doctora` y recibía `undefined`: el cuadro de la
// contraseña temporal reventaba al dibujarse y el alta de un doctor terminaba en una pantalla
// en blanco. En producción, y encontrado por el dueño.
//
// Lo que se fija aquí es el mecanismo, no ese endpoint: con `@Res()` a secas el cuerpo sale
// por Fastify y el interceptor no lo toca; con `@Res({ passthrough: true })` se conserva el
// código de estado Y el cuerpo se envuelve. Si alguien vuelve a escribir `@Res()` a secas en
// un controlador, esta prueba le enseña lo que pasa.
import { Controller, Get, Module, Req, Res } from '@nestjs/common';
import { APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';

import { EnvelopeInterceptor } from './envelope.interceptor';

@Controller('p')
class Pruebas {
  @Get('normal')
  normal() {
    return { doctora: { correo: 'a@b.c' } };
  }

  @Get('con-res')
  conRes(@Req() _req: unknown, @Res() res: FastifyReply) {
    void res.status(201).send({ doctora: { correo: 'a@b.c' } });
  }

  @Get('passthrough')
  passthrough(@Res({ passthrough: true }) res: FastifyReply) {
    void res.status(201);
    return { doctora: { correo: 'a@b.c' } };
  }
}

@Module({
  controllers: [Pruebas],
  providers: [{ provide: APP_INTERCEPTOR, useFactory: () => new EnvelopeInterceptor('latam') }],
})
class M {}

describe('el sobre y @Res()', () => {
  it('con @Res() a secas no hay sobre; con passthrough si, y el 201 se mantiene', async () => {
    const app = await NestFactory.create<NestFastifyApplication>(M, new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const normal = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/p/normal' });
    const conRes = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/p/con-res' });

    const paso = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/p/passthrough' });
    await app.close();

    // La forma normal: envuelta.
    expect(JSON.parse(normal.body)).toHaveProperty('datos');
    // `@Res()` a secas: SIN sobre. Esto es el fallo, y se deja escrito para que se vea.
    expect(JSON.parse(conRes.body)).not.toHaveProperty('datos');
    // `passthrough`: el 201 se conserva y el sobre vuelve.
    expect(paso.statusCode).toBe(201);
    expect(JSON.parse(paso.body)).toHaveProperty('datos');
    expect(JSON.parse(paso.body)).toMatchObject({ datos: { doctora: { correo: 'a@b.c' } } });
  });
});
