import { ApplicationError } from '@shared/application/application-error';
import { TransientFailure } from '@shared/application/transient-failure';

export class AuthenticationRequiredError extends ApplicationError {
  override readonly code = 'AUTHENTICATION_REQUIRED';

  constructor() {
    super('A bearer token is required');
  }
}

export class InvalidTokenError extends ApplicationError {
  override readonly code = 'INVALID_TOKEN';

  constructor(options?: ErrorOptions) {
    super('The bearer token is not valid', options);
  }
}

export class AccessDeniedError extends ApplicationError {
  override readonly code = 'ACCESS_DENIED';

  constructor() {
    super('The token does not grant access to this resource');
  }
}

export class IdentityProviderUnavailableError extends TransientFailure {
  constructor(options?: ErrorOptions) {
    super('identity_provider', options);
    this.name = 'IdentityProviderUnavailableError';
  }
}
