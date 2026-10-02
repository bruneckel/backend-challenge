import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestLoggerAdapter } from '@observability/logger/nest-logger';
import type { AppConfig } from '@platform/config/app-config';
import { type ApplicationOptions, compositionFor } from './api-application';
import { configureHttpApplication } from './http-application';
import { WorkerModule } from './worker.module';

export async function createWorkerApplication(
  config: AppConfig,
  options: ApplicationOptions = {},
): Promise<INestApplication> {
  const composition = compositionFor('worker', config, options);
  const app = await NestFactory.create(WorkerModule.forRoot(composition), {
    logger: new NestLoggerAdapter(composition.logger),
  });
  return configureHttpApplication(app);
}
