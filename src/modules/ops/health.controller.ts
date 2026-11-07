// `GET /health`: el contenedor está vivo y la base responde. Lo lee el HEALTHCHECK de la imagen
// y el despliegue: un contenedor que no puede hablar con la base no debe recibir tráfico ni
// reemplazar al anterior. No devuelve versión, configuración ni datos.

import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';

import { withTenantContext } from '../../shared/db/tenant-context';
import { POOL } from '../../shared/shared.module';

@Controller('health')
export class HealthController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Get()
  @HttpCode(200)
  async check(): Promise<{ estado: 'ok' }> {
    try {
      await withTenantContext(this.pool, { role: 'app_anonymous' }, (c) => c.query('select 1'));
    } catch {
      throw new ServiceUnavailableException();
    }
    return { estado: 'ok' };
  }
}
