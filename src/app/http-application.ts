import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { correlationMiddleware } from '@platform/http/correlation';
import { ProblemDetailsFilter } from '@platform/http/problem-details.filter';
import { SchemaValidationPipe } from '@platform/http/schema-validation.pipe';
import { ID_GENERATOR } from '@platform/tokens';
import type { IdGenerator } from '@shared/application/id-generator';

export function configureHttpApplication(app: INestApplication): INestApplication {
  const ids = app.get<IdGenerator>(ID_GENERATOR);
  app.use(correlationMiddleware(ids));
  app.useGlobalPipes(new SchemaValidationPipe());
  app.useGlobalFilters(new ProblemDetailsFilter(app.get(HttpAdapterHost), ids));
  app.enableShutdownHooks();
  return app;
}
