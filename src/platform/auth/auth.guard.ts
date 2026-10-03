import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LOGGER, TOKEN_VERIFIER } from '@platform/tokens';
import type { Logger } from '@shared/application/logger';
import {
  AuthenticationRequiredError,
  IdentityProviderUnavailableError,
  InvalidTokenError,
} from './auth-errors';
import type { Principal } from './principal';
import type { TokenVerifier } from './token-verifier';

const IS_PUBLIC = 'wagering:public';
const BEARER_SCHEME = /^bearer(?:\s|$)/i;
const BEARER_CREDENTIALS = /^bearer +([\w\-.~+/]+=*) *$/i;

export const Public = () => SetMetadata(IS_PUBLIC, true);

interface IncomingRequest {
  headers: Record<string, string | string[] | undefined>;
}

const principals = new WeakMap<object, Principal>();

export function principalOf(request: object): Principal {
  const principal = principals.get(request);
  if (principal === undefined) {
    throw new Error('The request has no authenticated principal');
  }
  return principal;
}

export function bearerTokenOf(header: unknown): string {
  if (typeof header !== 'string' || !BEARER_SCHEME.test(header)) {
    throw new AuthenticationRequiredError();
  }
  const token = BEARER_CREDENTIALS.exec(header)?.[1];
  if (token === undefined) {
    throw new InvalidTokenError();
  }
  return token;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }
    const request = context.switchToHttp().getRequest<IncomingRequest>();
    const token = bearerTokenOf(request.headers.authorization);
    try {
      principals.set(request, await this.verifier.verify(token));
    } catch (error) {
      if (error instanceof IdentityProviderUnavailableError) {
        this.logger.warn('identity provider unavailable', {
          error:
            error.cause instanceof Error
              ? error.cause.message
              : String(error.cause),
        });
      }
      throw error;
    }
    return true;
  }
}
