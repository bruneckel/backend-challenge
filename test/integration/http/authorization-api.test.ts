import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { type ApiHarness, startApi } from '@test/support/api';
import { METRICS_READER, OPERATOR, testIdentity } from '@test/support/identity';
import { inconsistentWallets } from '@test/support/invariants';

let api: ApiHarness;
let providerA: string;
let providerB: string;
let operator: string;
let metricsReader: string;
let wallet: { id: string; playerId: string };
let transactionOfA: string;

const brl = (amount: string) => ({ amount, currency: 'BRL' });

function bet(providerId: string) {
  const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
  return {
    key: `${providerId}:${externalTransactionId}`,
    body: {
      providerId,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: brl('1.00'),
    },
  };
}

const submit = (operation: ReturnType<typeof bet>, token: string) =>
  api.request('POST', '/wagering/transactions', {
    headers: { 'idempotency-key': operation.key },
    body: operation.body,
    token,
  });

beforeAll(async () => {
  api = await startApi();
  const identity = await testIdentity();
  providerA = await identity.token({ providerId: 'provider-a' });
  providerB = await identity.token({ providerId: 'provider-b' });
  operator = await identity.token({ roles: [OPERATOR] });
  metricsReader = await identity.token({ roles: [METRICS_READER] });
  const opened = await api.request('POST', '/wallets', {
    body: { playerId: Bun.randomUUIDv7(), initialBalance: brl('100.00') },
    token: operator,
  });
  expect(opened.status).toBe(201);
  wallet = opened.body;
  const placed = await submit(bet('provider-a'), providerA);
  expect(placed.status).toBe(200);
  transactionOfA = placed.body.transactionId;
});

afterEach(async () => {
  expect(await inconsistentWallets(api.database.sql)).toEqual([]);
});

afterAll(async () => {
  await api.close();
});

function expectDenied(response: { status: number; body: any }): void {
  expect(response.status).toBe(403);
  expect(response.body).toMatchObject({
    status: 403,
    code: 'ACCESS_DENIED',
    retryable: false,
  });
}

describe('wallet management', () => {
  const routes = (): [string, string][] => [
    ['POST', '/wallets'],
    ['GET', `/wallets/${wallet.id}`],
    ['GET', `/wallets/${wallet.id}/ledger`],
    ['POST', `/wallets/${wallet.id}/reconciliation`],
  ];

  test('is denied to providers', async () => {
    for (const [method, path] of routes()) {
      expectDenied(
        await api.request(method, path, {
          body:
            method === 'POST' && path === '/wallets'
              ? { playerId: Bun.randomUUIDv7(), initialBalance: brl('1.00') }
              : undefined,
          token: providerA,
        }),
      );
    }
  });

  test('is denied to the metrics reader', async () => {
    for (const [method, path] of routes()) {
      expectDenied(await api.request(method, path, { token: metricsReader }));
    }
  });

  test('is open to the operator', async () => {
    const shown = await api.request('GET', `/wallets/${wallet.id}`, {
      token: operator,
    });
    const ledger = await api.request('GET', `/wallets/${wallet.id}/ledger`, {
      token: operator,
    });
    const reconciled = await api.request(
      'POST',
      `/wallets/${wallet.id}/reconciliation`,
      { token: operator },
    );

    expect([shown.status, ledger.status, reconciled.status]).toEqual([
      200, 200, 200,
    ]);
    expect(shown.body.balance).toEqual(brl('99.00'));
  });
});

describe('submitting transactions', () => {
  test('lets a provider act as itself', async () => {
    const response = await submit(bet('provider-b'), providerB);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('PROCESSED');
  });

  test('denies a provider acting for another one and records nothing', async () => {
    const operation = bet('provider-b');

    const response = await submit(operation, providerA);

    expectDenied(response);
    const [row] = await api.database
      .sql`select count(*)::int as count from wager_transactions where external_transaction_id = ${operation.body.externalTransactionId}`;
    expect(row.count).toBe(0);
  });

  test('denies the operator, which is not a provider', async () => {
    expectDenied(await submit(bet('provider-a'), operator));
  });

  test('validates the request before checking the provider', async () => {
    const response = await api.request('POST', '/wagering/transactions', {
      headers: { 'idempotency-key': 'provider-b:ext-invalid' },
      body: { providerId: 'provider-b', kind: 'JACKPOT' },
      token: providerA,
    });

    expect(response.status).toBe(400);
  });
});

describe('reading transactions', () => {
  test('shows a provider its own transaction', async () => {
    const response = await api.request(
      'GET',
      `/wagering/transactions/${transactionOfA}`,
      { token: providerA },
    );

    expect(response.status).toBe(200);
    expect(response.body.providerId).toBe('provider-a');
  });

  test("hides another provider's transaction as not found", async () => {
    const response = await api.request(
      'GET',
      `/wagering/transactions/${transactionOfA}`,
      { token: providerB },
    );

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('TRANSACTION_NOT_FOUND');
  });

  test('shows the operator any transaction', async () => {
    const response = await api.request(
      'GET',
      `/wagering/transactions/${transactionOfA}`,
      { token: operator },
    );

    expect(response.status).toBe(200);
  });

  test('looks up external ids only under the caller provider', async () => {
    const operation = bet('provider-a');
    await submit(operation, providerA);
    const path = `/providers/provider-a/wagering/transactions/${operation.body.externalTransactionId}`;

    const own = await api.request('GET', path, { token: providerA });
    const other = await api.request('GET', path, { token: providerB });
    const byOperator = await api.request('GET', path, { token: operator });

    expect(own.status).toBe(200);
    expectDenied(other);
    expect(byOperator.status).toBe(200);
  });
});

describe('metrics', () => {
  test('need the metrics reader role', async () => {
    const reader = await api.request('GET', '/metrics', {
      token: metricsReader,
    });

    expect(reader.status).toBe(200);
    expectDenied(await api.request('GET', '/metrics', { token: operator }));
    expectDenied(await api.request('GET', '/metrics', { token: providerA }));
  });

  test('need a token', async () => {
    const response = await api.request('GET', '/metrics', { token: null });

    expect(response.status).toBe(401);
  });
});
