// `/v1/photos…`. Ningún byte de imagen pasa por aquí: lo que se sirve son enlaces firmados.

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';

import { ContractError } from '../../shared/contract/error-catalog';
import type { RequestWithContext } from '../../shared/http/request-context';
import type { Caller } from '../access/application/caller';
import { Photos } from './application/photos';

@Controller('v1/photos')
export class PhotosController {
  constructor(@Inject(Photos) private readonly photos: Photos) {}

  @Post('upload-url')
  @HttpCode(200)
  async uploadUrl(@Req() req: RequestWithContext, @Body() body: unknown) {
    return this.photos.uploadUrl(body, callerOf(req));
  }

  @Post(':photo_id/confirm')
  @HttpCode(200)
  async confirm(@Req() req: RequestWithContext, @Param('photo_id') id: string) {
    return this.photos.confirm(id, callerOf(req));
  }

  @Get()
  @HttpCode(200)
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, unknown>) {
    return this.photos.list(query ?? {}, callerOf(req));
  }

  // La maestra: dos minutos, y su línea en la auditoría. Solo la doctora.
  @Get(':photo_id/master')
  @HttpCode(200)
  async master(@Req() req: RequestWithContext, @Param('photo_id') id: string) {
    return this.photos.master(id, callerOf(req));
  }

  @Get(':photo_id/compare')
  @HttpCode(200)
  async compare(
    @Req() req: RequestWithContext,
    @Param('photo_id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.photos.compare(id, query ?? {}, callerOf(req));
  }

  @Post(':photo_id/reprocess')
  @HttpCode(200)
  async reprocess(@Req() req: RequestWithContext, @Param('photo_id') id: string) {
    return this.photos.reprocess(id, callerOf(req));
  }

  @Delete(':photo_id')
  @HttpCode(200)
  async remove(@Req() req: RequestWithContext, @Param('photo_id') id: string, @Body() body: unknown) {
    return this.photos.remove(id, body, callerOf(req));
  }
}

function callerOf(req: RequestWithContext): Caller {
  const ctx = req.medskin;
  if (ctx === undefined) throw new Error('la petición no pasó por el guardia de alcance');
  if (ctx.caller === null) throw new ContractError('token_no_valido');
  return ctx.caller;
}
