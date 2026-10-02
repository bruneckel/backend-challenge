import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { ApplicationError } from '@shared/application/application-error';
import type { IdGenerator } from '@shared/application/id-generator';
import { DomainError } from '@shared/domain/domain-error';
import { ensureCorrelationId } from './correlation';
import { problemFor } from './problem';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly ids: IdGenerator,
  ) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const http = host.switchToHttp();
    const response = http.getResponse();
    const correlationId = ensureCorrelationId(http.getRequest(), response, this.ids);
    const problem = problemFor(error);
    if (problem.code === 'INTERNAL_ERROR') {
      reportUnexpected(error, correlationId);
    }
    for (const [name, value] of Object.entries(problem.headers ?? {})) {
      httpAdapter.setHeader(response, name, value);
    }
    httpAdapter.setHeader(response, 'content-type', 'application/problem+json');
    httpAdapter.reply(
      response,
      {
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
}

function reportUnexpected(error: unknown, correlationId: string): void {
  const ours = error instanceof DomainError || error instanceof ApplicationError;
  const name = error instanceof Error ? error.name : typeof error;
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      msg: 'unexpected error while handling a request',
      correlationId,
      errorName: name,
      ...(typeof code === 'string' ? { errorCode: code } : {}),
      ...(ours ? { errorMessage: (error as Error).message } : {}),
    })}\n`,
  );
}
