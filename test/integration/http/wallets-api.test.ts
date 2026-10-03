import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { inconsistentWallets } from '@test/support/invariants';
import { type ApiHarness, startApi } from '@test/support/api';
import { bypassingLedgerGuards } from '@test/support/ledger-states';

let api: ApiHarness;
const corruptedOnPurpose: string[] = [];

beforeAll(async () => {
  api = await startApi({ DB_LOCK_TIMEOUT_MS: '300' });
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

async function openWallet(
  amount = '100.00',
): Promise<{ id: string; playerId: string }> {
  const response = await api.request('POST', '/wallets', {
    body: { playerId: Bun.randomUUIDv7(), initialBalance: brl(amount) },
  });
  expect(response.status).toBe(201);
  return response.body;
}

async function bet(
  wallet: { id: string; playerId: string },
  amount: string,
): Promise<void> {
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
      kind: 'BET',
      money: brl(amount),
    },
  });
  expect(response.status).toBe(200);
}

function expectProblem(
  response: { status: number; headers: Headers; body: any },
  status: number,
  code: string,
): void {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain(
    'application/problem+json',
  );
  expect(response.body).toMatchObject({ type: 'about:blank', status, code });
  expect(typeof response.body.title).toBe('string');
  expect(typeof response.body.retryable).toBe('boolean');
  expect(response.body.correlationId).toBe(
    response.headers.get('x-correlation-id'),
  );
}

describe('POST /wallets', () => {
  test('opens a wallet and answers 201 with its balance and version', async () => {
    const playerId = Bun.randomUUIDv7();

    const response = await api.request('POST', '/wallets', {
      body: { playerId, initialBalance: brl('1000.00') },
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      playerId,
      balance: brl('1000.00'),
      version: 1,
      createdAt: expect.any(String),
    });
  });

  test('answers 409 WALLET_ALREADY_EXISTS for a second wallet of the same player and currency', async () => {
    const wallet = await openWallet();

    const response = await api.request('POST', '/wallets', {
      body: { playerId: wallet.playerId, initialBalance: brl('5.00') },
    });

    expectProblem(response, 409, 'WALLET_ALREADY_EXISTS');
    expect(response.body.retryable).toBe(false);
    expect(response.body.walletId).toBe(wallet.id);
  });

  test.each([
    ['a missing player', { initialBalance: brl('10.00') }],
    [
      'a player id that is not a UUID',
      { playerId: 'player-1', initialBalance: brl('10.00') },
    ],
    [
      'an amount with one decimal',
      { playerId: Bun.randomUUIDv7(), initialBalance: brl('10.0') },
    ],
    [
      'an amount above seventeen integer digits',
      {
        playerId: Bun.randomUUIDv7(),
        initialBalance: brl('100000000000000000.00'),
      },
    ],
    [
      'a numeric amount',
      {
        playerId: Bun.randomUUIDv7(),
        initialBalance: { amount: 10, currency: 'BRL' },
      },
    ],
    [
      'a lowercase currency',
      {
        playerId: Bun.randomUUIDv7(),
        initialBalance: { amount: '10.00', currency: 'brl' },
      },
    ],
    [
      'an unknown field',
      {
        playerId: Bun.randomUUIDv7(),
        initialBalance: brl('10.00'),
        bonus: true,
      },
    ],
  ])('answers 400 INVALID_PAYLOAD for %s', async (_, body) => {
    const response = await api.request('POST', '/wallets', { body });

    expectProblem(response, 400, 'INVALID_PAYLOAD');
    expect(response.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.any(String) }),
      ]),
    );
  });

  test('answers 503 SERVICE_UNAVAILABLE while another opening for the same player is still in flight', async () => {
    const playerId = Bun.randomUUIDv7();
    const holder = await api.database.sql.reserve();
    await holder`begin`;
    await holder`
      insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
      values (${Bun.randomUUIDv7()}, ${playerId}, 'BRL', '0.00', 1, now(), now())`;

    try {
      const response = await api.request('POST', '/wallets', {
        body: { playerId, initialBalance: brl('10.00') },
      });

      expectProblem(response, 503, 'SERVICE_UNAVAILABLE');
      expect(response.headers.get('retry-after')).toBe('1');
    } finally {
      await holder`rollback`;
      holder.release();
    }
  });

  test('answers 400 INVALID_PAYLOAD for malformed JSON', async () => {
    const response = await api.request('POST', '/wallets', {
      body: '{"playerId":',
    });

    expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  test('echoes the correlation id it receives and creates one when absent', async () => {
    const echoed = await api.request('GET', `/wallets/${Bun.randomUUIDv7()}`, {
      headers: { 'x-correlation-id': 'trace-123' },
    });
    const generated = await api.request(
      'GET',
      `/wallets/${Bun.randomUUIDv7()}`,
    );

    expect(echoed.headers.get('x-correlation-id')).toBe('trace-123');
    expect(echoed.body.correlationId).toBe('trace-123');
    expect(generated.headers.get('x-correlation-id')).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });
});

describe('GET /wallets/:walletId', () => {
  test('shows the current state of the wallet', async () => {
    const wallet = await openWallet('100.00');
    await bet(wallet, '30.00');

    const response = await api.request('GET', `/wallets/${wallet.id}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: wallet.id,
      playerId: wallet.playerId,
      balance: brl('70.00'),
      version: 2,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  test('answers 404 WALLET_NOT_FOUND for an unknown wallet', async () => {
    expectProblem(
      await api.request('GET', `/wallets/${Bun.randomUUIDv7()}`),
      404,
      'WALLET_NOT_FOUND',
    );
  });

  test('answers 400 INVALID_REQUEST for an id that is not a UUID', async () => {
    expectProblem(
      await api.request('GET', '/wallets/wallet-1'),
      400,
      'INVALID_REQUEST',
    );
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  test('pages the ledger from the newest movement with an opaque cursor', async () => {
    const wallet = await openWallet('100.00');
    await bet(wallet, '1.00');
    await bet(wallet, '2.00');
    await bet(wallet, '3.00');

    const first = await api.request(
      'GET',
      `/wallets/${wallet.id}/ledger?limit=2`,
    );
    const second = await api.request(
      'GET',
      `/wallets/${wallet.id}/ledger?limit=2&cursor=${first.body.nextCursor}`,
    );

    expect(first.status).toBe(200);
    expect(
      first.body.items.map(
        (item: { walletVersion: number }) => item.walletVersion,
      ),
    ).toEqual([4, 3]);
    expect(first.body.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(
      second.body.items.map(
        (item: { walletVersion: number }) => item.walletVersion,
      ),
    ).toEqual([2, 1]);
    expect(second.body.nextCursor).toBeNull();
    expect(second.body.items[0]).toEqual({
      id: expect.any(String),
      transactionId: expect.any(String),
      direction: 'DEBIT',
      money: brl('1.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('99.00'),
      walletVersion: 2,
      createdAt: expect.any(String),
    });
  });

  test('uses a page of 50 entries by default', async () => {
    const wallet = await openWallet('100.00');

    const response = await api.request('GET', `/wallets/${wallet.id}/ledger`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [expect.objectContaining({ walletVersion: 1 })],
      nextCursor: null,
    });
  });

  test.each([
    ['limit=0'],
    ['limit=101'],
    ['limit=two'],
    ['limit=1.5'],
    ['page=2'],
  ])('answers 400 INVALID_REQUEST for %s', async (query) => {
    const wallet = await openWallet();

    expectProblem(
      await api.request('GET', `/wallets/${wallet.id}/ledger?${query}`),
      400,
      'INVALID_REQUEST',
    );
  });

  test('answers 400 INVALID_CURSOR for a cursor issued for another wallet', async () => {
    const other = await openWallet('100.00');
    await bet(other, '1.00');
    const page = await api.request(
      'GET',
      `/wallets/${other.id}/ledger?limit=1`,
    );
    const wallet = await openWallet();

    const response = await api.request(
      'GET',
      `/wallets/${wallet.id}/ledger?cursor=${page.body.nextCursor}`,
    );

    expectProblem(response, 400, 'INVALID_CURSOR');
  });

  test('answers 404 WALLET_NOT_FOUND for an unknown wallet', async () => {
    expectProblem(
      await api.request('GET', `/wallets/${Bun.randomUUIDv7()}/ledger`),
      404,
      'WALLET_NOT_FOUND',
    );
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('answers 200 with a consistent report', async () => {
    const wallet = await openWallet('100.00');
    await bet(wallet, '25.00');

    const response = await api.request(
      'POST',
      `/wallets/${wallet.id}/reconciliation`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: brl('75.00'),
      calculatedBalance: brl('75.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 2,
      chainBreaks: 0,
      versionConsistent: true,
    });
  });

  test('answers 200 flagging a stored balance that drifted from the ledger', async () => {
    const wallet = await openWallet('100.00');
    corruptedOnPurpose.push(wallet.id);
    await bypassingLedgerGuards(
      api.database.sql,
      (tx) =>
        tx`update wallets set balance_amount = '99.00' where id = ${wallet.id}`,
    );

    const response = await api.request(
      'POST',
      `/wallets/${wallet.id}/reconciliation`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      consistent: false,
      difference: { amount: '-1.00', currency: 'BRL' },
    });
  });

  test('answers 404 WALLET_NOT_FOUND for an unknown wallet', async () => {
    expectProblem(
      await api.request(
        'POST',
        `/wallets/${Bun.randomUUIDv7()}/reconciliation`,
      ),
      404,
      'WALLET_NOT_FOUND',
    );
  });

  test('answers 400 INVALID_REQUEST for an id that is not a UUID', async () => {
    expectProblem(
      await api.request('POST', '/wallets/wallet-1/reconciliation'),
      400,
      'INVALID_REQUEST',
    );
  });
});

describe('unknown routes', () => {
  test('answer 404 NOT_FOUND as problem details', async () => {
    expectProblem(await api.request('GET', '/nowhere'), 404, 'NOT_FOUND');
  });
});
