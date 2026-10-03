import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ApiHarness, startApi } from '@test/support/api';

const ISSUER = 'http://localhost:8080/realms/wagering';

let api: ApiHarness;
const tokens: Record<string, string> = {};

async function clientToken(clientId: string): Promise<string> {
  const response = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: `${clientId}-secret`,
    }),
  }).catch((error: unknown) => {
    throw new Error(
      'Keycloak is not reachable on localhost:8080; start it with docker compose up -d --wait keycloak',
      { cause: error },
    );
  });
  expect(response.status).toBe(200);
  const { access_token: token } = (await response.json()) as {
    access_token: string;
  };
  return token;
}

beforeAll(async () => {
  for (const client of [
    'provider-a',
    'provider-b',
    'wagering-operator',
    'wagering-metrics',
  ]) {
    tokens[client] = await clientToken(client);
  }
  api = await startApi({
    AUTH_ISSUER: ISSUER,
    AUTH_AUDIENCE: 'wagering-api',
    AUTH_JWKS_URL: `${ISSUER}/protocol/openid-connect/certs`,
  });
});

afterAll(async () => {
  await api?.close();
});

function bet(providerId: string, wallet: { id: string; playerId: string }) {
  const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
  return {
    headers: { 'idempotency-key': `${providerId}:${externalTransactionId}` },
    body: {
      providerId,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    },
  };
}

describe('Keycloak realm', () => {
  test('lets the operator open a wallet and a provider bet on it', async () => {
    const opened = await api.request('POST', '/wallets', {
      body: {
        playerId: Bun.randomUUIDv7(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
      },
      token: tokens['wagering-operator'],
    });
    expect(opened.status).toBe(201);

    const placed = await api.request('POST', '/wagering/transactions', {
      ...bet('provider-a', opened.body),
      token: tokens['provider-a'],
    });

    expect(placed.status).toBe(200);
    expect(placed.body.balance).toEqual({ amount: '9.00', currency: 'BRL' });
  });

  test('binds each provider client to its own provider id', async () => {
    const opened = await api.request('POST', '/wallets', {
      body: {
        playerId: Bun.randomUUIDv7(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
      },
      token: tokens['wagering-operator'],
    });

    const response = await api.request('POST', '/wagering/transactions', {
      ...bet('provider-a', opened.body),
      token: tokens['provider-b'],
    });

    expect(response.status).toBe(403);
  });

  test('grants the metrics only to the scraper client', async () => {
    const scraper = await api.request('GET', '/metrics', {
      token: tokens['wagering-metrics'],
    });
    const operator = await api.request('GET', '/metrics', {
      token: tokens['wagering-operator'],
    });

    expect(scraper.status).toBe(200);
    expect(operator.status).toBe(403);
  });

  test('rejects a realm token whose claims were altered', async () => {
    const [header, payload, signature] = tokens['provider-b']!.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    const forged = Buffer.from(
      JSON.stringify({ ...claims, provider_id: 'provider-a' }),
    ).toString('base64url');

    const response = await api.request('GET', '/wagering/transactions/x', {
      token: `${header}.${forged}.${signature}`,
    });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('INVALID_TOKEN');
  });
});
