import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from './api.module';

const app = await NestFactory.create(ApiModule, { logger: ['error', 'warn'] });
app.enableShutdownHooks();
await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
