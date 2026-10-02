import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import { IdempotencyKeyRequiredError } from './request-errors';

const VALID_IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

export const IdempotencyKey = createParamDecorator(
  (_: unknown, context: ExecutionContext): string => {
    const value = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>().headers[
      'idempotency-key'
    ];
    if (typeof value !== 'string' || !VALID_IDEMPOTENCY_KEY.test(value)) {
      throw new IdempotencyKeyRequiredError();
    }
    return value;
  },
);
