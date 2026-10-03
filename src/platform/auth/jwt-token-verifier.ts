import { type JWTPayload, createRemoteJWKSet, errors, jwtVerify } from 'jose';
import {
  IdentityProviderUnavailableError,
  InvalidTokenError,
} from './auth-errors';
import type { Principal } from './principal';
import type { TokenVerifier } from './token-verifier';

export interface JwtVerifierSettings {
  issuer: string;
  audience: string;
  jwksUrl: string;
  jwksTimeoutMs: number;
  clockSkewSeconds: number;
  jwksCooldownMs?: number;
}

const TOKEN_FAULTS: ReadonlySet<string> = new Set([
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_INVALID',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
]);

export class JwtTokenVerifier implements TokenVerifier {
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly settings: JwtVerifierSettings) {
    this.keys = createRemoteJWKSet(new URL(settings.jwksUrl), {
      timeoutDuration: settings.jwksTimeoutMs,
      cooldownDuration: settings.jwksCooldownMs,
    });
  }

  async verify(token: string): Promise<Principal> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: this.settings.issuer,
        audience: this.settings.audience,
        algorithms: ['RS256'],
        clockTolerance: this.settings.clockSkewSeconds,
        requiredClaims: ['exp', 'sub'],
      }));
    } catch (error) {
      throw error instanceof errors.JOSEError && TOKEN_FAULTS.has(error.code)
        ? new InvalidTokenError({ cause: error })
        : new IdentityProviderUnavailableError({ cause: error });
    }
    return principalOf(payload);
  }
}

function principalOf(payload: JWTPayload): Principal {
  const { sub, exp, provider_id: providerId, roles = [] } = payload;
  if (typeof sub !== 'string' || sub === '' || typeof exp !== 'number') {
    throw new InvalidTokenError();
  }
  if (
    providerId !== undefined &&
    (typeof providerId !== 'string' || providerId === '')
  ) {
    throw new InvalidTokenError();
  }
  if (!Array.isArray(roles) || roles.some((role) => typeof role !== 'string')) {
    throw new InvalidTokenError();
  }
  return {
    subject: sub,
    providerId,
    roles: roles as string[],
    expiresAt: new Date(exp * 1000),
  };
}
