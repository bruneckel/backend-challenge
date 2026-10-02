import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { CanonicalJsonFingerprinter } from '@platform/crypto/canonical-json-fingerprinter';
import { type ApiHarness, startApi } from '@test/support/api';
import { insertRow } from '@test/support/database';
import { transactionRow } from '@test/support/schema-rows';
import { type WagerOperation, wagerOperationPayload } from '@wallet/application/wager-operation';
import { ProcessPendingReference } from '@wallet/application/use-cases/process-pending-reference';

let api: ApiHarness;

beforeAll(async () => {
  api = await startApi({ DB_LOCK_TIMEOUT_MS: '300', REFERENCE_BACKOFF_BASE_MS: '10', REFERENCE_BACKOFF_MAX_MS: '40' });
});

afterAll(async () => {
  await api.close();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

interface Wallet {
  id: string;
  playerId: string;
}

interface Submission {
  key: string;
  body: Record<string, unknown>;
}

async function openWallet(amount = '100.00'): Promise<Wallet> {
  const response = await api.request('POST', '/wallets', { body: { playerId: Bun.randomUUIDv7(), initialBalance: brl(amount) } });
  return response.body;
}

function submission(wallet: Wallet, kind: string, amount: string, extra: Record<string, unknown> = {}): Submission {
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
      kind,
      money: brl(amount),
      ...extra,
    },
  };
}

function referencing(reference: Submission, kind: string): Submission {
  const wallet = { id: String(reference.body.walletId), playerId: String(reference.body.playerId) };
  const money = reference.body.money as { amount: string };
  return submission(wallet, kind, money.amount, { referenceExternalTransactionId: reference.body.externalTransactionId });
}

const submit = ({ key, body }: Submission, headers: Record<string, string> = {}) =>
  api.request('POST', '/wagering/transactions', { headers: { 'idempotency-key': key, ...headers }, body });

function expectProblem(response: { status: number; headers: Headers; body: any }, status: number, code: string): void {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  expect(response.body).toMatchObject({ type: 'about:blank', status, code });
  expect(response.body.correlationId).toBe(response.headers.get('x-correlation-id'));
}

describe('POST /wagering/transactions', () => {
  test('answers 200 with the result of a processed BET', async () => {
    const wallet = await openWallet('100.00');

    const response = await submit(submission(wallet, 'BET', '25.00'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: brl('75.00'),
      idempotentReplay: false,
    });
  });

  test('answers 422 with the failure code of a rejected BET', async () => {
    const wallet = await openWallet('100.00');

    const response = await submit(submission(wallet, 'BET', '100.01'));

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      transactionId: expect.any(String),
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl('100.00'),
      idempotentReplay: false,
    });
  });

  test('answers 202 with a Location for a REFUND that arrives before its BET', async () => {
    const wallet = await openWallet('100.00');

    const response = await submit(referencing(submission(wallet, 'BET', '10.00'), 'REFUND'));

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: brl('100.00'), idempotentReplay: false });
    expect(response.headers.get('location')).toBe(`/wagering/transactions/${response.body.transactionId}`);
  });

  test.each([
    ['a processed BET', '25.00', 200],
    ['a rejected BET', '500.00', 422],
  ])('replays %s with the same status and body', async (_, amount, status) => {
    const wallet = await openWallet('100.00');
    const request = submission(wallet, 'BET', amount);
    const original = await submit(request);
    await submit(submission(wallet, 'WIN', '50.00'));

    const replay = await submit(request);

    expect(original.status).toBe(status);
    expect(replay.status).toBe(status);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
  });

  test('replays a waiting transaction with its current state', async () => {
    const wallet = await openWallet('100.00');
    const betRequest = submission(wallet, 'BET', '10.00');
    const refundRequest = referencing(betRequest, 'REFUND');
    const waiting = await submit(refundRequest);

    const stillWaiting = await submit(refundRequest);
    await submit(betRequest);
    await Bun.sleep(60);
    const outcome = await api.app
      .get(ProcessPendingReference)
      .execute({ transactionId: waiting.body.transactionId, walletId: wallet.id });
    const settled = await submit(refundRequest);

    expect(stillWaiting.status).toBe(202);
    expect(stillWaiting.body).toEqual({ ...waiting.body, idempotentReplay: true });
    expect(outcome).toBe('processed');
    expect(settled.status).toBe(200);
    expect(settled.body).toEqual({
      transactionId: waiting.body.transactionId,
      status: 'PROCESSED',
      balance: brl('100.00'),
      idempotentReplay: true,
    });
  });

  test('replays a FAILED transaction as 500 with its original result', async () => {
    const wallet = await openWallet('100.00');
    const request = submission(wallet, 'BET', '10.00');
    const payloadHash = new CanonicalJsonFingerprinter().fingerprint(
      wagerOperationPayload(request.body as unknown as WagerOperation),
    );
    const failed = transactionRow(
      { id: wallet.id, player_id: wallet.playerId, currency: 'BRL' },
      {
        external_transaction_id: request.body.externalTransactionId,
        idempotency_key: request.key,
        payload_hash: payloadHash,
        status: 'FAILED',
        failure_code: 'PROCESSING_FAILED',
        processed_at: null,
        result_balance_amount: '100.00',
      },
    );
    await insertRow(api.database.sql, 'wager_transactions', failed);

    const response = await submit(request);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      transactionId: failed.id,
      status: 'FAILED',
      failureCode: 'PROCESSING_FAILED',
      balance: brl('100.00'),
      idempotentReplay: true,
    });
  });

  test.each([
    ['is missing', undefined],
    ['is empty', ''],
    ['is longer than 255 characters', 'k'.repeat(256)],
    ['has spaces', 'provider-a transaction-1'],
  ])('answers 400 IDEMPOTENCY_KEY_REQUIRED when the key %s', async (_, key) => {
    const wallet = await openWallet();
    const { body } = submission(wallet, 'BET', '10.00');

    const response = await api.request('POST', '/wagering/transactions', {
      headers: key === undefined ? {} : { 'idempotency-key': key },
      body,
    });

    expectProblem(response, 400, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  test.each([
    ['an unknown field', { bonus: true }],
    ['the reserved internal provider', { providerId: 'internal' }],
    ['a provider id with spaces', { providerId: 'provider a' }],
    ['a wallet id that is not a UUID', { walletId: 'wallet-1' }],
    ['an unknown kind', { kind: 'JACKPOT' }],
    ['a numeric amount', { money: { amount: 10, currency: 'BRL' } }],
    ['an amount with three decimals', { money: brl('10.005') }],
    ['an amount above seventeen integer digits', { money: brl('100000000000000000.00') }],
    ['an empty round id', { roundId: '' }],
    ['an external id longer than 128 characters', { externalTransactionId: 'e'.repeat(129) }],
  ])('answers 400 INVALID_PAYLOAD for %s', async (_, override) => {
    const wallet = await openWallet();
    const request = submission(wallet, 'BET', '10.00');

    const response = await submit({ key: request.key, body: { ...request.body, ...override } });

    expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  test.each([
    ['UNSUPPORTED_KIND', 'an OPENING', 'OPENING', {}],
    ['REFERENCE_REQUIRED', 'a REFUND without a reference', 'REFUND', {}],
    ['REFERENCE_NOT_ALLOWED', 'a BET with a reference', 'BET', { referenceExternalTransactionId: 'ext-1' }],
  ])('answers 400 %s for %s', async (code, _, kind, extra) => {
    const wallet = await openWallet();

    expectProblem(await submit(submission(wallet, kind, '10.00', extra)), 400, code);
  });

  test('answers 404 WALLET_NOT_FOUND for an unknown wallet', async () => {
    const wallet = await openWallet();

    expectProblem(await submit(submission({ ...wallet, id: Bun.randomUUIDv7() }, 'BET', '10.00')), 404, 'WALLET_NOT_FOUND');
  });

  test('answers 409 IDEMPOTENCY_KEY_CONFLICT for the same key with another payload', async () => {
    const wallet = await openWallet();
    const request = submission(wallet, 'BET', '10.00');
    await submit(request);

    const response = await submit({ key: request.key, body: { ...request.body, money: brl('11.00') } });

    expectProblem(response, 409, 'IDEMPOTENCY_KEY_CONFLICT');
    expect(response.body.retryable).toBe(false);
  });

  test('answers 409 EXTERNAL_TRANSACTION_CONFLICT for a new key on an external id already used', async () => {
    const wallet = await openWallet();
    const request = submission(wallet, 'BET', '10.00');
    await submit(request);

    expectProblem(await submit({ key: 'regenerated-key', body: request.body }), 409, 'EXTERNAL_TRANSACTION_CONFLICT');
  });

  test('answers 503 SERVICE_UNAVAILABLE with Retry-After while the wallet stays locked', async () => {
    const wallet = await openWallet();
    const holder = await api.database.sql.reserve();
    await holder`begin`;
    await holder`select id from wallets where id = ${wallet.id} for update`;

    try {
      const response = await submit(submission(wallet, 'BET', '10.00'));

      expectProblem(response, 503, 'SERVICE_UNAVAILABLE');
      expect(response.headers.get('retry-after')).toBe('1');
      expect(response.body.retryable).toBe(true);
    } finally {
      await holder`rollback`;
      holder.release();
    }
  });

  test('stores the correlation id it receives with the transaction', async () => {
    const wallet = await openWallet();

    const response = await submit(submission(wallet, 'BET', '10.00'), { 'x-correlation-id': 'trace-xyz' });

    const [row] = await api.database.sql`
      select correlation_id from wager_transactions where id = ${response.body.transactionId}`;
    expect(row.correlation_id).toBe('trace-xyz');
    expect(response.headers.get('x-correlation-id')).toBe('trace-xyz');
  });
});

describe('GET /wagering/transactions', () => {
  test('shows a transaction by id and by provider and external id', async () => {
    const wallet = await openWallet('100.00');
    const request = submission(wallet, 'BET', '10.00');
    const created = await submit(request);

    const byId = await api.request('GET', `/wagering/transactions/${created.body.transactionId}`);
    const byExternalId = await api.request(
      'GET',
      `/providers/provider-a/wagering/transactions/${request.body.externalTransactionId}`,
    );

    expect(byId.status).toBe(200);
    expect(byId.body).toEqual({
      transactionId: created.body.transactionId,
      providerId: 'provider-a',
      externalTransactionId: request.body.externalTransactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: brl('10.00'),
      status: 'PROCESSED',
      balance: brl('90.00'),
      createdAt: expect.any(String),
      processedAt: expect.any(String),
    });
    expect(byExternalId.body).toEqual(byId.body);
  });

  test('answers 404 TRANSACTION_NOT_FOUND for unknown transactions', async () => {
    expectProblem(await api.request('GET', `/wagering/transactions/${Bun.randomUUIDv7()}`), 404, 'TRANSACTION_NOT_FOUND');
    expectProblem(await api.request('GET', '/providers/provider-a/wagering/transactions/missing'), 404, 'TRANSACTION_NOT_FOUND');
  });

  test('answers 400 INVALID_REQUEST for a transaction id that is not a UUID', async () => {
    expectProblem(await api.request('GET', '/wagering/transactions/tx-1'), 400, 'INVALID_REQUEST');
  });
});
