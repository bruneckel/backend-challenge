import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { type ApiHarness, startApi } from '@test/support/api';
import { waitUntil } from '@test/support/async';
import {
  METRICS_READER,
  OPERATOR,
  bearerFor,
  testIdentity,
} from '@test/support/identity';
import { inconsistentWallets } from '@test/support/invariants';
import { type EventStream, openEventStream } from '@test/support/sse';

let api: ApiHarness;
const streams: EventStream[] = [];

beforeAll(async () => {
  api = await startApi({ STREAM_SWEEP_INTERVAL_MS: '50' });
});

afterEach(async () => {
  for (const stream of streams.splice(0)) {
    stream.close();
  }
  expect(await inconsistentWallets(api.database.sql)).toEqual([]);
});

afterAll(async () => {
  await api.close();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

interface Wallet {
  id: string;
  playerId: string;
}

async function openWallet(amount = '100.00'): Promise<Wallet> {
  const response = await api.request('POST', '/wallets', {
    body: { playerId: Bun.randomUUIDv7(), initialBalance: brl(amount) },
  });
  expect(response.status).toBe(201);
  return response.body;
}

async function settle(wallet: Wallet, kind: string, amount: string) {
  const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
  const response = await api.request('POST', '/wagering/transactions', {
    headers: { 'idempotency-key': `provider-a:${externalTransactionId}` },
    body: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind,
      money: brl(amount),
    },
  });
  expect(response.status).toBe(200);
  return response.body;
}

async function subscribe(
  harness: ApiHarness,
  walletId: string,
  options: { authorization?: string | null; lastEventId?: string } = {},
): Promise<EventStream> {
  const authorization =
    options.authorization === undefined
      ? await bearerFor({ roles: [OPERATOR] })
      : options.authorization;
  const stream = await openEventStream(
    `${harness.baseUrl}/wallets/${walletId}/events`,
    {
      ...(authorization === null ? {} : { authorization }),
      ...(options.lastEventId === undefined
        ? {}
        : { 'last-event-id': options.lastEventId }),
    },
  );
  streams.push(stream);
  return stream;
}

async function metricsText(harness: ApiHarness): Promise<string> {
  const response = await fetch(`${harness.baseUrl}/metrics`, {
    headers: { authorization: await bearerFor({ roles: [METRICS_READER] }) },
  });
  return response.text();
}

describe('wallet event stream', () => {
  test('sends a wallet snapshot and then every new ledger entry', async () => {
    const wallet = await openWallet('100.00');
    const stream = await subscribe(api, wallet.id);
    await stream.waitFor(1);

    const bet = await settle(wallet, 'BET', '10.00');
    await settle(wallet, 'WIN', '5.00');
    const events = await stream.waitFor(3);

    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.headers.get('cache-control')).toContain('no-cache');
    expect(stream.retry).toBe(3000);
    expect(events[0]).toEqual({
      id: '1',
      event: 'wallet',
      data: expect.objectContaining({
        id: wallet.id,
        balance: brl('100.00'),
        version: 1,
      }),
    });
    expect(events[1]).toEqual({
      id: '2',
      event: 'ledger-entry',
      data: expect.objectContaining({
        walletId: wallet.id,
        transactionId: bet.transactionId,
        direction: 'DEBIT',
        balanceAfter: brl('90.00'),
        walletVersion: 2,
      }),
    });
    expect(events[2]?.id).toBe('3');
    expect(events[2]?.data.balanceAfter).toEqual(brl('95.00'));
  });

  test('replays what the client missed after its Last-Event-ID', async () => {
    const wallet = await openWallet('100.00');
    for (const amount of ['1.00', '2.00', '3.00']) {
      await settle(wallet, 'BET', amount);
    }

    const stream = await subscribe(api, wallet.id, { lastEventId: '2' });
    const events = await stream.waitFor(2);

    expect(events.map((event) => [event.id, event.event])).toEqual([
      ['3', 'ledger-entry'],
      ['4', 'ledger-entry'],
    ]);
  });

  test('goes on live after the replay without gaps or repeats', async () => {
    const wallet = await openWallet('100.00');
    await settle(wallet, 'BET', '1.00');
    const stream = await subscribe(api, wallet.id, { lastEventId: '1' });
    await stream.waitFor(1);

    await settle(wallet, 'BET', '2.00');
    await settle(wallet, 'WIN', '3.00');
    await stream.waitFor(3);
    await Bun.sleep(200);

    expect(stream.events.map((event) => event.id)).toEqual(['2', '3', '4']);
  });

  test('requires a bearer token', async () => {
    const wallet = await openWallet();

    const stream = await subscribe(api, wallet.id, { authorization: null });

    expect(stream.status).toBe(401);
    expect(stream.problem.code).toBe('AUTHENTICATION_REQUIRED');
  });

  test('is reserved to the operator', async () => {
    const wallet = await openWallet();

    const provider = await subscribe(api, wallet.id, {
      authorization: await bearerFor({ providerId: 'provider-a' }),
    });
    const reader = await subscribe(api, wallet.id, {
      authorization: await bearerFor({ roles: [METRICS_READER] }),
    });

    expect([provider.status, reader.status]).toEqual([403, 403]);
  });

  test('answers 404 for an unknown wallet', async () => {
    const stream = await subscribe(api, Bun.randomUUIDv7());

    expect(stream.status).toBe(404);
    expect(stream.problem.code).toBe('WALLET_NOT_FOUND');
  });

  test.each(['abc', '-1', '9'])(
    'refuses the Last-Event-ID %p',
    async (lastEventId) => {
      const wallet = await openWallet();

      const stream = await subscribe(api, wallet.id, { lastEventId });

      expect(stream.status).toBe(400);
      expect(stream.problem.code).toBe('INVALID_REQUEST');
    },
  );

  test('ends the stream when the token expires and keeps it out of the request latency histogram', async () => {
    const wallet = await openWallet();
    const shortLived = await (
      await testIdentity()
    ).sign({ roles: [OPERATOR], expiresInSeconds: 1 });

    const stream = await subscribe(api, wallet.id, {
      authorization: `Bearer ${shortLived}`,
    });
    await stream.waitForClose(5000);

    expect(stream.events.map((event) => event.event)).toEqual(['wallet']);
    expect(await metricsText(api)).not.toContain(
      'route="/wallets/:walletId/events",status="200"',
    );
  });

  test('reports the open streams', async () => {
    const wallet = await openWallet();
    const stream = await subscribe(api, wallet.id);
    await stream.waitFor(1);

    await waitUntil(async () =>
      /^wallet_event_streams\{[^}]*\} 1$/m.test(await metricsText(api)),
    );
    stream.close();
    await waitUntil(async () =>
      /^wallet_event_streams\{[^}]*\} 0$/m.test(await metricsText(api)),
    );
  });

  test('refuses a stream beyond the capacity of the instance', async () => {
    const small = await startApi({ STREAM_MAX_STREAMS: '1' });
    try {
      const response = await small.request('POST', '/wallets', {
        body: { playerId: Bun.randomUUIDv7(), initialBalance: brl('1.00') },
      });
      const first = await subscribe(small, response.body.id);
      await first.waitFor(1);

      const second = await subscribe(small, response.body.id);

      expect(second.status).toBe(503);
      expect(second.headers.get('retry-after')).toBe('5');
      expect(second.problem).toMatchObject({
        code: 'STREAM_CAPACITY_EXCEEDED',
        retryable: true,
      });
    } finally {
      await small.close();
    }
  });

  test('ends the open streams when the application shuts down', async () => {
    const closing = await startApi();
    const response = await closing.request('POST', '/wallets', {
      body: { playerId: Bun.randomUUIDv7(), initialBalance: brl('1.00') },
    });
    const stream = await subscribe(closing, response.body.id);
    await stream.waitFor(1);

    const started = performance.now();
    await closing.close();

    await stream.waitForClose(2000);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
