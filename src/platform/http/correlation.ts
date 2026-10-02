import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import { withLogContext } from '@observability/logger/log-context';
import type { IdGenerator } from '@shared/application/id-generator';

export const CORRELATION_HEADER = 'x-correlation-id';

const VALID_CORRELATION_ID = /^[\x21-\x7e]{1,128}$/;

interface CorrelatedRequest {
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
}

interface HeaderWriter {
  setHeader(name: string, value: string): unknown;
}

export function correlationMiddleware(ids: IdGenerator) {
  return (
    request: CorrelatedRequest,
    response: HeaderWriter,
    next: () => void,
  ): void => {
    const correlationId = ensureCorrelationId(request, response, ids);
    withLogContext({ correlationId }, next);
  };
}

export function ensureCorrelationId(
  request: CorrelatedRequest,
  response: HeaderWriter,
  ids: IdGenerator,
): string {
  if (request.correlationId === undefined) {
    const received = request.headers[CORRELATION_HEADER];
    request.correlationId =
      typeof received === 'string' && VALID_CORRELATION_ID.test(received)
        ? received
        : ids.next();
    response.setHeader('X-Correlation-Id', request.correlationId);
  }
  return request.correlationId;
}

export const CorrelationId = createParamDecorator(
  (_: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<CorrelatedRequest>();
    if (request.correlationId === undefined) {
      throw new Error(
        'The correlation middleware did not run for this request',
      );
    }
    return request.correlationId;
  },
);
