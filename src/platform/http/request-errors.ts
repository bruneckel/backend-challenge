import { ApplicationError } from '@shared/application/application-error';

export interface ValidationIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

export class RequestValidationError extends ApplicationError {
  override readonly code: 'INVALID_PAYLOAD' | 'INVALID_REQUEST';

  constructor(
    readonly location: string,
    readonly issues: readonly ValidationIssue[],
  ) {
    super(location === 'body' ? 'The request body is invalid' : 'The request is invalid');
    this.code = location === 'body' ? 'INVALID_PAYLOAD' : 'INVALID_REQUEST';
  }
}

export class IdempotencyKeyRequiredError extends ApplicationError {
  override readonly code = 'IDEMPOTENCY_KEY_REQUIRED';

  constructor() {
    super('A valid Idempotency-Key header (1 to 255 visible ASCII characters) is required');
  }
}
