import type { INestApplication, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AppConfig } from '@platform/config/app-config';
import { ApiModule } from './api.module';
import { configureHttpApplication } from './http-application';

export interface ApplicationOptions {
  logger?: false | LogLevel[];
}

export async function createApiApplication(
  config: AppConfig,
  options: ApplicationOptions = {},
): Promise<INestApplication> {
  const app = await NestFactory.create(ApiModule.forRoot(config), {
    logger: options.logger ?? ['error', 'warn'],
  });
  return configureHttpApplication(app);
}
