import type { INestApplication, LogLevel } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import type { AppConfig } from '@platform/config/app-config';
import { correlationMiddleware } from '@platform/http/correlation';
import { ProblemDetailsFilter } from '@platform/http/problem-details.filter';
import { SchemaValidationPipe } from '@platform/http/schema-validation.pipe';
import { ID_GENERATOR } from '@platform/tokens';
import type { IdGenerator } from '@shared/application/id-generator';
import { ApiModule } from './api.module';

export interface ApiApplicationOptions {
  logger?: false | LogLevel[];
}

export async function createApiApplication(config: AppConfig, options: ApiApplicationOptions = {}): Promise<INestApplication> {
  const app = await NestFactory.create(ApiModule.forRoot(config), { logger: options.logger ?? ['error', 'warn'] });
  const ids = app.get<IdGenerator>(ID_GENERATOR);
  app.use(correlationMiddleware(ids));
  app.useGlobalPipes(new SchemaValidationPipe());
  app.useGlobalFilters(new ProblemDetailsFilter(app.get(HttpAdapterHost), ids));
  app.enableShutdownHooks();
  return app;
}
