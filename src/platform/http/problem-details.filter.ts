import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
} from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { ApplicationError } from '@shared/application/application-error';
import type { IdGenerator } from '@shared/application/id-generator';
import type { Logger } from '@shared/application/logger';
import { DomainError } from '@shared/domain/domain-error';
import { ensureCorrelationId } from './correlation';
import { problemFor } from './problem';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly ids: IdGenerator,
    private readonly logger: Logger,
  ) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const http = host.switchToHttp();
    const response = http.getResponse();
    const correlationId = ensureCorrelationId(
      http.getRequest(),
      response,
      this.ids,
    );
    const problem = problemFor(error);
    if (problem.code === 'INTERNAL_ERROR') {
      this.reportUnexpected(error);
    }
    for (const [name, value] of Object.entries(problem.headers ?? {})) {
      httpAdapter.setHeader(response, name, value);
    }
    httpAdapter.setHeader(response, 'content-type', 'application/problem+json');
    httpAdapter.reply(
      response,
      {
        ...problem.details,
        type: 'about:blank',
        title: problem.title,
        status: problem.status,
        code: problem.code,
        retryable: problem.retryable,
        correlationId,
        ...(problem.errors === undefined ? {} : { errors: problem.errors }),
      },
      problem.status,
    );
  }

  private reportUnexpected(error: unknown): void {
    const ours =
      error instanceof DomainError || error instanceof ApplicationError;
    const code =
      typeof error === 'object' && error !== null
        ? Reflect.get(error, 'code')
        : undefined;
    this.logger.error('unexpected error while handling a request', {
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: typeof code === 'string' ? code : undefined,
      errorMessage: ours ? (error as Error).message : undefined,
    });
  }
}
