import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { PinoLogger } from '@observability/logger/pino-logger';
import { inconsistentWallets } from '@test/support/invariants';
import { type ApiHarness, startApi } from '@test/support/api';

let api: ApiHarness;
const corruptedOnPurpose: string[] = [];
const lines: Record<string, unknown>[] = [];
const raw: string[] = [];

beforeAll(async () => {
  const logger = new PinoLogger({
    role: 'api',
    instanceId: 'api-observed',
    destination: {
      write(chunk: string) {
        raw.push(chunk);
        lines.push(JSON.parse(chunk));
      },
    },
  });
  api = await startApi({ INSTANCE_ID: 'api-observed' }, logger);
});

afterEach(async () => {
  expect(
    await inconsistentWallets(api.database.sql, corruptedOnPurpose),
  ).toEqual([]);
});

afterAll(async () => {
  await api.close();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function openWallet(): Promise<{ id: string; playerId: string }> {
  const response = await api.request('POST', '/wallets', {
    body: { playerId: Bun.randomUUIDv7(), initialBalance: brl('100.00') },
  });
  return response.body;
}

function bet(wallet: { id: string; playerId: string }, amount = '25.00') {
  const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
  return {
    key: `provider-a:${externalTransactionId}`,
    body: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: brl(amount),
    },
  };
}

const submit = (
  request: ReturnType<typeof bet>,
  headers: Record<string, string> = {},
) =>
  api.request('POST', '/wagering/transactions', {
    headers: { 'idempotency-key': request.key, ...headers },
    body: request.body,
  });

async function metricsText(): Promise<string> {
  const response = await fetch(`${api.baseUrl}/metrics`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/plain');
  return response.text();
}

function sample(
  text: string,
  name: string,
  labels: Record<string, string>,
): number {
  const pairs = Object.entries(labels).map(
    ([key, value]) => `${key}="${value}"`,
  );
  const line = text
    .split('\n')
    .find(
      (candidate) =>
        candidate.startsWith(`${name}{`) &&
        pairs.every((pair) => candidate.includes(pair)),
    );
  return line === undefined ? 0 : Number(line.split(' ').at(-1));
}

describe('metrics endpoint', () => {
  test('counts settled transactions, replays and conflicts per channel', async () => {
    const wallet = await openWallet();
    const request = bet(wallet);
    await submit(request);
    await submit(request);
    await submit({
      ...request,
      body: { ...request.body, money: brl('26.00') },
    });

    const text = await metricsText();

    expect(
      sample(text, 'wager_transactions_total', {
        kind: 'BET',
        status: 'PROCESSED',
        channel: 'http',
      }),
    ).toBe(1);
    expect(sample(text, 'idempotency_replays_total', { channel: 'http' })).toBe(
      1,
    );
    expect(
      sample(text, 'idempotency_conflicts_total', {
        channel: 'http',
        type: 'idempotency_key',
      }),
    ).toBe(1);
    expect(
      sample(text, 'http_request_duration_seconds_count', {
        method: 'POST',
        route: '/wagering/transactions',
        status: '200',
      }),
    ).toBeGreaterThanOrEqual(2);
    expect(text).toContain('role="api",instance="api-observed"');
  });

  test('counts reconciliations and the divergences they find', async () => {
    const consistent = await openWallet();
    const drifted = await openWallet();
    corruptedOnPurpose.push(drifted.id);
    await api.database
      .sql`update wallets set balance_amount = '99.00' where id = ${drifted.id}`;

    await api.request('POST', `/wallets/${consistent.id}/reconciliation`);
    await api.request('POST', `/wallets/${drifted.id}/reconciliation`);

    const text = await metricsText();
    expect(
      sample(text, 'wallet_reconciliations_total', { result: 'consistent' }),
    ).toBe(1);
    expect(
      sample(text, 'wallet_reconciliations_total', { result: 'divergent' }),
    ).toBe(1);
    expect(
      sample(text, 'wallet_reconciliation_divergences_total', { role: 'api' }),
    ).toBe(1);
  });
});

describe('structured logs', () => {
  test('log each request and outcome with the correlation id and without money or player ids', async () => {
    const wallet = await openWallet();
    const request = bet(wallet, '37.45');

    await submit(request, { 'x-correlation-id': 'trace-logs' });

    const traced = lines.filter((line) => line.correlationId === 'trace-logs');
    expect(traced).toContainEqual(
      expect.objectContaining({
        msg: 'wager transaction settled',
        kind: 'BET',
        status: 'PROCESSED',
        walletId: wallet.id,
        providerId: 'provider-a',
        channel: 'http',
      }),
    );
    expect(traced).toContainEqual(
      expect.objectContaining({
        msg: 'http request completed',
        route: '/wagering/transactions',
        status: 200,
      }),
    );
    const everything = raw.join('');
    expect(everything).not.toContain('37.45');
    expect(everything).not.toContain('62.55');
    expect(everything).not.toContain(wallet.playerId);
  });
});
