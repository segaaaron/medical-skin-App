import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

// Los módulos de recurso se cuelgan aquí, uno por tramo del roadmap.
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, cache: true })],
})
export class AppModule {}
