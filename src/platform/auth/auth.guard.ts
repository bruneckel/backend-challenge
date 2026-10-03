import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LOGGER, TOKEN_VERIFIER } from '@platform/tokens';
import type { Logger } from '@shared/application/logger';
import {
  AccessDeniedError,
  AuthenticationRequiredError,
  IdentityProviderUnavailableError,
  InvalidTokenError,
} from './auth-errors';
import type { Principal, Role } from './principal';
import type { TokenVerifier } from './token-verifier';

const IS_PUBLIC = 'wagering:public';
const REQUIRED_ROLE = 'wagering:required-role';
const BEARER_SCHEME = /^bearer(?:\s|$)/i;
const BEARER_CREDENTIALS = /^bearer +([\w\-.~+/]+=*) *$/i;

export const Public = () => SetMetadata(IS_PUBLIC, true);

export const RequiresRole = (role: Role) => SetMetadata(REQUIRED_ROLE, role);

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

export const CurrentPrincipal = createParamDecorator(
  (_: unknown, context: ExecutionContext): Principal =>
    principalOf(context.switchToHttp().getRequest<object>()),
);

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
    let principal: Principal;
    try {
      principal = await this.verifier.verify(token);
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
    const role = this.reflector.getAllAndOverride<Role | undefined>(
      REQUIRED_ROLE,
      [context.getHandler(), context.getClass()],
    );
    if (role !== undefined && !principal.roles.includes(role)) {
      throw new AccessDeniedError();
    }
    principals.set(request, principal);
    return true;
  }
}
