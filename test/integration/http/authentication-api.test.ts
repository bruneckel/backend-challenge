import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ApiHarness, startApi } from '@test/support/api';
import { LocalIdentityProvider, testIdentity } from '@test/support/identity';

let api: ApiHarness;

beforeAll(async () => {
  api = await startApi();
});

afterAll(async () => {
  await api.close();
});

const SOME_ID = '01900000-0000-7000-8000-000000000000';

const PROTECTED: [string, string][] = [
  ['POST', '/wallets'],
  ['GET', `/wallets/${SOME_ID}`],
  ['GET', `/wallets/${SOME_ID}/ledger`],
  ['POST', `/wallets/${SOME_ID}/reconciliation`],
  ['POST', '/wagering/transactions'],
  ['GET', `/wagering/transactions/${SOME_ID}`],
  ['GET', '/providers/provider-a/wagering/transactions/ext-1'],
  ['GET', '/metrics'],
];

function submission(): { key: string; body: Record<string, unknown> } {
  const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
  return {
    key: `provider-a:${externalTransactionId}`,
    body: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: Bun.randomUUIDv7(),
      walletId: SOME_ID,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    },
  };
}

describe('authentication', () => {
  test.each(PROTECTED)(
    '%s %s requires a bearer token',
    async (method, path) => {
      const response = await api.request(method, path, { token: null });

      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toContain(
        'application/problem+json',
      );
      expect(response.headers.get('www-authenticate')).toBe(
        'Bearer realm="wagering"',
      );
      expect(response.body).toMatchObject({
        status: 401,
        code: 'AUTHENTICATION_REQUIRED',
        retryable: false,
      });
      expect(response.body.correlationId).toBeString();
    },
  );

  test.each(PROTECTED)(
    '%s %s rejects an invalid token',
    async (method, path) => {
      const identity = await testIdentity();
      const expired = await identity.sign({
        providerId: 'provider-a',
        expiresInSeconds: -60,
      });

      const response = await api.request(method, path, { token: expired });

      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(
        'Bearer realm="wagering", error="invalid_token"',
      );
      expect(response.body).toMatchObject({
        status: 401,
        code: 'INVALID_TOKEN',
        retryable: false,
      });
    },
  );

  test('treats another scheme as a missing token', async () => {
    const response = await api.request('GET', `/wallets/${SOME_ID}`, {
      headers: { authorization: 'Basic d2FnZXJpbmc6c2VjcmV0' },
    });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  test.each(['Bearer', 'Bearer not a token', 'Bearer a.b.c'])(
    'rejects the malformed credentials %p',
    async (authorization) => {
      const response = await api.request('GET', `/wallets/${SOME_ID}`, {
        headers: { authorization },
      });

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('INVALID_TOKEN');
    },
  );

  test('authenticates before validating the request', async () => {
    const response = await api.request('POST', '/wagering/transactions', {
      body: { kind: 'JACKPOT' },
      token: null,
    });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  test('records nothing for a request without a token', async () => {
    const { key, body } = submission();

    const response = await api.request('POST', '/wagering/transactions', {
      body,
      headers: { 'idempotency-key': key },
      token: null,
    });

    expect(response.status).toBe(401);
    const [row] = await api.database
      .sql`select count(*)::int as count from wager_transactions where external_transaction_id = ${body.externalTransactionId}`;
    expect(row.count).toBe(0);
  });

  test('lets a valid token reach the endpoint', async () => {
    const response = await api.request('GET', `/wallets/${SOME_ID}`);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('WALLET_NOT_FOUND');
  });

  test.each(['/health/live', '/health/ready'])(
    'keeps %s public',
    async (path) => {
      const response = await api.request('GET', path, { token: null });

      expect(response.status).toBe(200);
    },
  );

  test('answers 503 while the identity provider cannot serve its keys', async () => {
    const unavailable = await LocalIdentityProvider.start();
    unavailable.setJwks('failing');
    const other = await startApi(unavailable.environment);
    try {
      const token = await unavailable.sign({ providerId: 'provider-a' });

      const response = await other.request('GET', `/wallets/${SOME_ID}`, {
        token,
      });

      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('1');
      expect(response.body).toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        retryable: true,
      });
    } finally {
      await other.close();
      unavailable.stop();
    }
  });
});
