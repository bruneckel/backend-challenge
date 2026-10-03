import { type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';

export const TEST_AUDIENCE = 'wagering-api';
export const OPERATOR = 'operator';
export const METRICS_READER = 'metrics-reader';

export interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly jwk: JWK;
}

export interface TokenOptions {
  subject?: string;
  providerId?: string;
  roles?: readonly string[];
  claims?: Record<string, unknown>;
  issuer?: string;
  audience?: string | string[];
  expiresInSeconds?: number;
  notBeforeInSeconds?: number;
  withoutExpiration?: boolean;
  withoutSubject?: boolean;
  key?: SigningKey;
  kid?: string;
}

export interface Grant {
  providerId?: string;
  roles?: readonly string[];
}

type JwksMode = 'up' | 'failing' | 'slow';

export async function createSigningKey(
  kid = `key-${Bun.randomUUIDv7()}`,
): Promise<SigningKey> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid,
    alg: 'RS256',
    use: 'sig',
  };
  return { kid, privateKey, jwk };
}

const TOKEN_LIFETIME_SECONDS = 3600;
const TOKEN_REUSE_MS = 600_000;

export class LocalIdentityProvider {
  private readonly keys: SigningKey[];
  private readonly tokens = new Map<
    string,
    { token: Promise<string>; until: number }
  >();
  private mode: JwksMode = 'up';
  private requests = 0;
  private server: ReturnType<typeof Bun.serve> | undefined;

  private constructor(key: SigningKey) {
    this.keys = [key];
  }

  static async start(): Promise<LocalIdentityProvider> {
    const provider = new LocalIdentityProvider(await createSigningKey());
    provider.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => provider.respond(request),
    });
    provider.server.unref();
    return provider;
  }

  get issuer(): string {
    return `http://127.0.0.1:${this.server?.port}/realms/wagering`;
  }

  get jwksUrl(): string {
    return `${this.issuer}/protocol/openid-connect/certs`;
  }

  get environment(): Record<string, string> {
    return {
      AUTH_ISSUER: this.issuer,
      AUTH_AUDIENCE: TEST_AUDIENCE,
      AUTH_JWKS_URL: this.jwksUrl,
    };
  }

  get jwksRequests(): number {
    return this.requests;
  }

  get kid(): string {
    return this.keys.at(-1)!.kid;
  }

  async rotate(): Promise<SigningKey> {
    const key = await createSigningKey();
    this.keys.push(key);
    return key;
  }

  setJwks(mode: JwksMode): void {
    this.mode = mode;
  }

  async sign(options: TokenOptions = {}): Promise<string> {
    const key = options.key ?? this.keys.at(-1)!;
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      ...(options.providerId === undefined
        ? {}
        : { provider_id: options.providerId }),
      ...(options.roles === undefined ? {} : { roles: options.roles }),
      ...options.claims,
    };
    let jwt = new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? key.kid })
      .setIssuer(options.issuer ?? this.issuer)
      .setAudience(options.audience ?? TEST_AUDIENCE)
      .setIssuedAt(now);
    if (options.withoutSubject !== true) {
      jwt = jwt.setSubject(
        options.subject ??
          `service-account-${options.providerId ?? 'wagering'}`,
      );
    }
    if (options.withoutExpiration !== true) {
      jwt = jwt.setExpirationTime(
        now + (options.expiresInSeconds ?? TOKEN_LIFETIME_SECONDS),
      );
    }
    if (options.notBeforeInSeconds !== undefined) {
      jwt = jwt.setNotBefore(now + options.notBeforeInSeconds);
    }
    return jwt.sign(key.privateKey);
  }

  token(grant: Grant): Promise<string> {
    const cacheKey = JSON.stringify([grant.providerId, grant.roles]);
    const cached = this.tokens.get(cacheKey);
    if (cached !== undefined && cached.until > Date.now()) {
      return cached.token;
    }
    const token = this.sign(grant);
    this.tokens.set(cacheKey, { token, until: Date.now() + TOKEN_REUSE_MS });
    return token;
  }

  stop(): void {
    this.server?.stop(true);
  }

  private async respond(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== new URL(this.jwksUrl).pathname) {
      return new Response(null, { status: 404 });
    }
    this.requests += 1;
    if (this.mode === 'failing') {
      return new Response('unavailable', { status: 503 });
    }
    if (this.mode === 'slow') {
      await Bun.sleep(2000);
    }
    return Response.json({ keys: this.keys.map((key) => key.jwk) });
  }
}

let shared: Promise<LocalIdentityProvider> | undefined;

export function testIdentity(): Promise<LocalIdentityProvider> {
  shared ??= LocalIdentityProvider.start();
  return shared;
}

export async function bearerFor(grant: Grant): Promise<string> {
  return `Bearer ${await (await testIdentity()).token(grant)}`;
}
