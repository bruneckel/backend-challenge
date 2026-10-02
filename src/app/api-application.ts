import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestLoggerAdapter } from '@observability/logger/nest-logger';
import { PinoLogger } from '@observability/logger/pino-logger';
import { PrometheusMetrics } from '@observability/metrics/prometheus-metrics';
import type { AppConfig } from '@platform/config/app-config';
import type { Logger } from '@shared/application/logger';
import { ApiModule, type CompositionOptions } from './api.module';
import { configureHttpApplication } from './http-application';

export interface ApplicationOptions {
  logger?: Logger;
}

export function compositionFor(
  role: 'api' | 'worker',
  config: AppConfig,
  options: ApplicationOptions,
): CompositionOptions {
  return {
    config,
    logger:
      options.logger ??
      new PinoLogger({
        role,
        instanceId: config.instanceId,
        level: config.observability.logLevel,
      }),
    metrics: new PrometheusMetrics({ role, instance: config.instanceId }),
  };
}

export async function createApiApplication(
  config: AppConfig,
  options: ApplicationOptions = {},
): Promise<INestApplication> {
  const composition = compositionFor('api', config, options);
  const app = await NestFactory.create(ApiModule.forRoot(composition), {
    logger: new NestLoggerAdapter(composition.logger),
  });
  return configureHttpApplication(app);
}
