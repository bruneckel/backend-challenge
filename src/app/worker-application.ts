import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AppConfig } from '@platform/config/app-config';
import type { ApplicationOptions } from './api-application';
import { configureHttpApplication } from './http-application';
import { WorkerModule } from './worker.module';

export async function createWorkerApplication(
  config: AppConfig,
  options: ApplicationOptions = {},
): Promise<INestApplication> {
  const app = await NestFactory.create(WorkerModule.forRoot(config), { logger: options.logger ?? ['error', 'warn'] });
  return configureHttpApplication(app);
}
