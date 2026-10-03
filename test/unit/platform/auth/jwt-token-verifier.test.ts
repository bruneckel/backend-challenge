import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SignJWT, UnsecuredJWT } from 'jose';
import {
  IdentityProviderUnavailableError,
  InvalidTokenError,
} from '@platform/auth/auth-errors';
import {
  type JwtVerifierSettings,
  JwtTokenVerifier,
} from '@platform/auth/jwt-token-verifier';
import { TransientFailure } from '@shared/application/transient-failure';
import {
  LocalIdentityProvider,
  TEST_AUDIENCE,
  createSigningKey,
} from '@test/support/identity';

let identity: LocalIdentityProvider;

beforeAll(async () => {
  identity = await LocalIdentityProvider.start();
});

afterAll(() => identity.stop());

function verifierFor(
  provider: LocalIdentityProvider,
  overrides: Partial<JwtVerifierSettings> = {},
): JwtTokenVerifier {
  return new JwtTokenVerifier({
    issuer: provider.issuer,
    audience: TEST_AUDIENCE,
    jwksUrl: provider.jwksUrl,
    jwksTimeoutMs: 500,
    clockSkewSeconds: 5,
    ...overrides,
  });
}

async function withProvider(
  run: (provider: LocalIdentityProvider) => Promise<void>,
): Promise<void> {
  const provider = await LocalIdentityProvider.start();
  try {
    await run(provider);
  } finally {
    provider.stop();
  }
}

describe('JwtTokenVerifier', () => {
  test('returns the principal of a provider token', async () => {
    const token = await identity.sign({ providerId: 'provider-a' });

    expect(await verifierFor(identity).verify(token)).toEqual({
      subject: 'service-account-provider-a',
      providerId: 'provider-a',
      roles: [],
    });
  });

  test('returns the roles of an operator token', async () => {
    const token = await identity.sign({ roles: ['operator'] });

    expect(await verifierFor(identity).verify(token)).toEqual({
      subject: 'service-account-wagering',
      providerId: undefined,
      roles: ['operator'],
    });
  });

  test('accepts an audience list that contains the api', async () => {
    const token = await identity.sign({
      providerId: 'provider-a',
      audience: ['account', TEST_AUDIENCE],
    });

    expect(await verifierFor(identity).verify(token)).toMatchObject({
      providerId: 'provider-a',
    });
  });

  test('accepts a token that expired within the clock skew', async () => {
    const token = await identity.sign({
      providerId: 'provider-a',
      expiresInSeconds: -2,
    });

    expect(await verifierFor(identity).verify(token)).toMatchObject({
      providerId: 'provider-a',
    });
  });

  const invalidTokens: [string, () => Promise<string>][] = [
    [
      'an expired token',
      () => identity.sign({ providerId: 'p', expiresInSeconds: -60 }),
    ],
    [
      'a token that is not valid yet',
      () => identity.sign({ providerId: 'p', notBeforeInSeconds: 60 }),
    ],
    [
      'a token from another issuer',
      () =>
        identity.sign({
          providerId: 'p',
          issuer: 'http://elsewhere.test/realms/wagering',
        }),
    ],
    [
      'a token for another audience',
      () => identity.sign({ providerId: 'p', audience: 'account' }),
    ],
    [
      'a token without expiration',
      () => identity.sign({ providerId: 'p', withoutExpiration: true }),
    ],
    [
      'a token without subject',
      () => identity.sign({ providerId: 'p', withoutSubject: true }),
    ],
    [
      'a token signed by an unknown key',
      async () =>
        identity.sign({ providerId: 'p', key: await createSigningKey() }),
    ],
    [
      'a token forged under a known key id',
      async () =>
        identity.sign({
          providerId: 'p',
          key: await createSigningKey(),
          kid: identity.kid,
        }),
    ],
    [
      'an unsigned token',
      async () =>
        new UnsecuredJWT({ provider_id: 'p' })
          .setSubject('service-account-p')
          .setIssuer(identity.issuer)
          .setAudience(TEST_AUDIENCE)
          .setExpirationTime('1h')
          .encode(),
    ],
    [
      'a token signed with a shared secret',
      () =>
        new SignJWT({ provider_id: 'p' })
          .setProtectedHeader({ alg: 'HS256' })
          .setSubject('service-account-p')
          .setIssuer(identity.issuer)
          .setAudience(TEST_AUDIENCE)
          .setExpirationTime('1h')
          .sign(
            new TextEncoder().encode('a-shared-secret-long-enough-for-hs256'),
          ),
    ],
    ['a malformed token', async () => 'not-a-jwt'],
    [
      'a token whose provider id is not a string',
      () => identity.sign({ claims: { provider_id: 42 } }),
    ],
    [
      'a token with an empty provider id',
      () => identity.sign({ claims: { provider_id: '' } }),
    ],
    [
      'a token whose roles are not strings',
      () => identity.sign({ claims: { roles: [1] } }),
    ],
    [
      'a token whose roles are not a list',
      () => identity.sign({ claims: { roles: 'operator' } }),
    ],
  ];

  test.each(invalidTokens)('rejects %s', async (_, make) => {
    const token = await make();

    await expect(verifierFor(identity).verify(token)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  test('fetches the key set again when a token names a new key', async () => {
    await withProvider(async (provider) => {
      const verifier = verifierFor(provider, { jwksCooldownMs: 0 });
      await verifier.verify(await provider.sign({ providerId: 'p' }));
      await provider.rotate();

      const principal = await verifier.verify(
        await provider.sign({ providerId: 'p' }),
      );

      expect(principal.providerId).toBe('p');
      expect(provider.jwksRequests).toBe(2);
    });
  });

  test('keeps verifying with cached keys while the key set is down', async () => {
    await withProvider(async (provider) => {
      const verifier = verifierFor(provider);
      await verifier.verify(await provider.sign({ providerId: 'p' }));
      provider.setJwks('failing');

      const principal = await verifier.verify(
        await provider.sign({ providerId: 'p' }),
      );

      expect(principal.providerId).toBe('p');
      expect(provider.jwksRequests).toBe(1);
    });
  });

  test('reports a transient failure when the key set answers an error', async () => {
    await withProvider(async (provider) => {
      provider.setJwks('failing');
      const token = await provider.sign({ providerId: 'p' });

      const failure = await verifierFor(provider)
        .verify(token)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(IdentityProviderUnavailableError);
      expect(failure).toBeInstanceOf(TransientFailure);
    });
  });

  test('reports a transient failure when the key set times out', async () => {
    await withProvider(async (provider) => {
      provider.setJwks('slow');
      const token = await provider.sign({ providerId: 'p' });

      await expect(
        verifierFor(provider, { jwksTimeoutMs: 100 }).verify(token),
      ).rejects.toBeInstanceOf(IdentityProviderUnavailableError);
    });
  });

  test('reports a transient failure when the key set is unreachable', async () => {
    const provider = await LocalIdentityProvider.start();
    const token = await provider.sign({ providerId: 'p' });
    const verifier = verifierFor(provider);
    provider.stop();

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(
      IdentityProviderUnavailableError,
    );
  });

  test('rejects a malformed token without fetching the key set', async () => {
    await withProvider(async (provider) => {
      await expect(
        verifierFor(provider).verify('not-a-jwt'),
      ).rejects.toBeInstanceOf(InvalidTokenError);
      expect(provider.jwksRequests).toBe(0);
    });
  });
});
