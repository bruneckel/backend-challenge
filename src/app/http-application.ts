import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { correlationMiddleware } from '@platform/http/correlation';
import { httpObservability } from '@platform/http/http-observability';
import { ProblemDetailsFilter } from '@platform/http/problem-details.filter';
import { SchemaValidationPipe } from '@platform/http/schema-validation.pipe';
import { ID_GENERATOR, LOGGER, METRICS } from '@platform/tokens';
import type { IdGenerator } from '@shared/application/id-generator';
import type { Logger } from '@shared/application/logger';
import type { Metrics } from '@shared/application/metrics';

export function configureHttpApplication(
  app: INestApplication,
): INestApplication {
  const ids = app.get<IdGenerator>(ID_GENERATOR);
  const logger = app.get<Logger>(LOGGER);
  app.use(correlationMiddleware(ids));
  app.use(httpObservability(app.get<Metrics>(METRICS), logger));
  app.useGlobalPipes(new SchemaValidationPipe());
  app.useGlobalFilters(
    new ProblemDetailsFilter(app.get(HttpAdapterHost), ids, logger),
  );
  app.enableShutdownHooks();
  return app;
}
