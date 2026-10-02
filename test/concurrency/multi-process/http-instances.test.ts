import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ApiResponse, requestApi } from '@test/support/api';
import { type TestDatabase, createMigratedDatabase } from '@test/support/database';
import { walletInvariantViolations } from '@test/support/invariants';
import { type RunningProcess, startApiProcess } from '@test/support/processes';

let database: TestDatabase;
let instances: RunningProcess[];

beforeAll(async () => {
  database = await createMigratedDatabase();
  instances = await Promise.all(
    [1, 2, 3].map((number) =>
      startApiProcess({ DATABASE_URL: database.url, INSTANCE_ID: `api-${number}`, DB_POOL_SIZE: '5' }),
    ),
  );
}, 60_000);

afterAll(async () => {
  const stopped = await Promise.all((instances ?? []).map(async (instance) => ({ instance, code: await instance.stop() })));
  for (const { instance } of stopped) {
    expect(instance.output()).toContain('"msg":"shutdown complete"');
  }
  await database.drop();
}, 60_000);

const brl = (amount: string) => ({ amount, currency: 'BRL' });

interface Wallet {
  id: string;
  playerId: string;
}

interface Submission {
  key: string;
  body: Record<string, unknown>;
}

async function openWallet(instance: RunningProcess, amount: string): Promise<Wallet> {
  const response = await requestApi(instance.url, 'POST', '/wallets', {
    body: { playerId: Bun.randomUUIDv7(), initialBalance: brl(amount) },
  });
  expect(response.status).toBe(201);
  return response.body;
}

function bet(wallet: Wallet, amount: string): Submission {
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

const submitTo = (instance: RunningProcess, { key, body }: Submission) =>
  requestApi(instance.url, 'POST', '/wagering/transactions', { headers: { 'idempotency-key': key }, body });

const instance = (index: number) => instances[index % instances.length]!;

async function debitsOf(walletId: string): Promise<number> {
  const [row] = await database.sql`
    select count(*)::int as count from wallet_ledger_entries where wallet_id = ${walletId} and direction = 'DEBIT'`;
  return row.count;
}

describe('C1 via HTTP on three API processes', () => {
  test('applies the same BET sent fifty times across the instances exactly once', async () => {
    const wallet = await openWallet(instance(0), '100.00');
    const request = bet(wallet, '10.00');

    const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => submitTo(instance(index), request)));

    expect(responses.every((response) => response.status === 200)).toBe(true);
    const applied = responses.filter((response) => response.body.idempotentReplay === false);
    expect(applied).toHaveLength(1);
    for (const response of responses) {
      expect({ ...response.body, idempotentReplay: false }).toEqual(applied[0]!.body);
    }
    expect(applied[0]!.body.balance).toEqual(brl('90.00'));
    expect(await debitsOf(wallet.id)).toBe(1);
    expect(await walletInvariantViolations(database.sql, wallet.id)).toEqual([]);
  });
});

describe('C2 via HTTP on three API processes', () => {
  test.each(Array.from({ length: 10 }, (_, round) => round + 1))(
    'lets exactly one of two 80.00 BETs win a 100.00 balance, with resends (round %i)',
    async (round) => {
      const wallet = await openWallet(instance(round), '100.00');
      const first = bet(wallet, '80.00');
      const second = bet(wallet, '80.00');

      const responses = await Promise.all([
        submitTo(instance(round), first),
        submitTo(instance(round + 1), second),
        submitTo(instance(round + 2), first),
        submitTo(instance(round + 3), second),
      ]);

      const outcomes = [responses.slice(0, 1).concat(responses[2]!), [responses[1]!, responses[3]!]].map(
        (copies: ApiResponse[]) => {
          expect(copies[0]!.status).toBe(copies[1]!.status);
          expect({ ...copies[0]!.body, idempotentReplay: false }).toEqual({ ...copies[1]!.body, idempotentReplay: false });
          return copies[0]!;
        },
      );
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([200, 422]);
      expect(outcomes.find((outcome) => outcome.status === 422)!.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      const current = await requestApi(instance(round + 4).url, 'GET', `/wallets/${wallet.id}`);
      expect(current.body.balance).toEqual(brl('20.00'));
      expect(await debitsOf(wallet.id)).toBe(1);
      expect(await walletInvariantViolations(database.sql, wallet.id)).toEqual([]);
    },
  );
});
