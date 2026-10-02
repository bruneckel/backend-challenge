import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { type ApiResponse, requestApi } from '@test/support/api';
import {
  type TestDatabase,
  createMigratedDatabase,
} from '@test/support/database';
import { walletInvariantViolations } from '@test/support/invariants';
import {
  type LoadWallet,
  type Operation,
  balanceAfter,
  enqueueOperation,
  openWalletOverHttp,
  operationFor,
  runConcurrently,
  shuffled,
  storedOutcomes,
  submitUntilAnswered,
  waitForDrain,
} from '@test/support/load';
import {
  type RunningProcess,
  startApiProcess,
  startWorkerProcess,
} from '@test/support/processes';
import {
  type TestQueues,
  createTestQueues,
  createTestSqsClient,
  drainQueue,
  queueDepth,
} from '@test/support/sqs';

type Channel = 'http' | 'sqs' | 'sqs-redelivered';

const CHANNELS: readonly (readonly Channel[])[] = [
  ['http', 'http'],
  ['sqs'],
  ['http', 'sqs'],
  ['sqs-redelivered'],
];

let database: TestDatabase;
let sqs: SQSClient;
let queues: TestQueues;
let apis: RunningProcess[] = [];
let workers: RunningProcess[] = [];

beforeAll(async () => {
  database = await createMigratedDatabase();
  sqs = createTestSqsClient();
  queues = await createTestQueues(sqs);
  const environment = {
    DATABASE_URL: database.url,
    ...queues.environment,
    DB_POOL_SIZE: '5',
    REFERENCE_MAX_ATTEMPTS: '200',
    REFERENCE_BACKOFF_BASE_MS: '100',
    REFERENCE_BACKOFF_MAX_MS: '500',
  };
  [apis, workers] = await Promise.all([
    Promise.all(
      [1, 2, 3].map((number) =>
        startApiProcess({ ...environment, INSTANCE_ID: `api-${number}` }),
      ),
    ),
    Promise.all(
      [1, 2, 3].map((number) =>
        startWorkerProcess({
          ...environment,
          INSTANCE_ID: `worker-${number}`,
          SQS_RECEIVE_WAIT_SECONDS: '1',
          SQS_RECEIVE_TIMEOUT_MS: '3000',
          SQS_VISIBILITY_TIMEOUT_SECONDS: '10',
          SQS_HEARTBEAT_INTERVAL_MS: '1000',
          OUTBOX_POLL_INTERVAL_MS: '50',
          REFERENCE_SCHEDULER_POLL_INTERVAL_MS: '50',
        }),
      ),
    ),
  ]);
}, 90_000);

afterAll(async () => {
  const processes = [...apis, ...workers];
  await Promise.all(processes.map((running) => running.stop()));
  for (const running of processes) {
    expect(running.output()).toContain('"msg":"shutdown complete"');
  }
  await queues.delete();
  sqs.destroy();
  await database.drop();
}, 90_000);

function walletLoad(wallet: LoadWallet): Operation[] {
  const bets = Array.from({ length: 16 }, () =>
    operationFor(wallet, 'BET', '10.00'),
  );
  const wins = Array.from({ length: 8 }, () =>
    operationFor(wallet, 'WIN', '5.00'),
  );
  const refunds = bets
    .slice(0, 4)
    .map((bet) => operationFor(wallet, 'REFUND', '10.00', bet));
  const rollbacks = bets
    .slice(4, 8)
    .map((bet) => operationFor(wallet, 'ROLLBACK', '10.00', bet));
  return [...bets, ...wins, ...refunds, ...rollbacks];
}

describe('C4 mixed load on three API and three worker processes', () => {
  test('applies every operation once and keeps each wallet consistent when HTTP and SQS race on the same wallets', async () => {
    const urls = apis.map((api) => api.url);
    const wallets = await Promise.all(
      urls.map((url) => openWalletOverHttp(url, '1000.00')),
    );
    const operations = shuffled(wallets.flatMap(walletLoad));
    const sends = shuffled(
      operations.flatMap((operation, index) =>
        CHANNELS[index % CHANNELS.length]!.map((channel) => ({
          channel,
          operation,
        })),
      ),
    );
    const messageIds = new Set<string>();
    const answers: { operation: Operation; response: ApiResponse }[] = [];

    await runConcurrently(sends, 24, async ({ channel, operation }, index) => {
      if (channel === 'http') {
        const response = await submitUntilAnswered(
          [
            ...urls.slice(index % urls.length),
            ...urls.slice(0, index % urls.length),
          ],
          operation,
        );
        answers.push({ operation, response });
        return;
      }
      const messageId = await enqueueOperation(
        sqs,
        queues.urls.commands,
        operation,
      );
      messageIds.add(messageId);
      if (channel === 'sqs-redelivered') {
        await enqueueOperation(sqs, queues.urls.commands, operation, {
          messageId,
        });
      }
    });
    await waitForDrain(database.sql, sqs, queues, operations);

    const outcomes = await storedOutcomes(database.sql, operations);
    expect(outcomes.size).toBe(operations.length);
    expect(
      [...outcomes.values()].filter(
        (outcome) => outcome.status !== 'PROCESSED',
      ),
    ).toEqual([]);
    for (const { operation, response } of answers) {
      expect([200, 202]).toContain(response.status);
      expect(response.body.transactionId).toBe(
        outcomes.get(operation.idempotencyKey)!.id,
      );
    }
    for (const wallet of wallets) {
      const current = await requestApi(
        urls[0]!,
        'GET',
        `/wallets/${wallet.id}`,
      );
      expect(current.body.balance).toEqual({
        amount: balanceAfter(
          '1000.00',
          operations.filter(({ body }) => body.walletId === wallet.id),
        ),
        currency: 'BRL',
      });
      expect(await walletInvariantViolations(database.sql, wallet.id)).toEqual(
        [],
      );
    }
    const [inbox] = await database.sql`
      select count(*)::int as count from inbox_messages`;
    expect(inbox.count).toBe(messageIds.size);
    expect(await queueDepth(sqs, queues.urls.deadLetter)).toBe(0);
    const [outbox] = await database.sql`
      select count(*)::int as count from outbox_messages`;
    const events = await drainQueue(sqs, queues.urls.events);
    const eventIds = events.map(
      (event) => JSON.parse(event.Body!).eventId as string,
    );
    expect(new Set(eventIds).size).toBe(outbox.count);
  });
});

describe('C1 across channels on three API and three worker processes', () => {
  test('applies the same BET sent 25 times over HTTP and 25 times over SQS exactly once', async () => {
    const urls = apis.map((api) => api.url);
    const wallet = await openWalletOverHttp(urls[0]!, '100.00');
    const bet = operationFor(wallet, 'BET', '10.00');
    const messageIds: string[] = [];

    const responses = await Promise.all(
      Array.from({ length: 50 }, async (_, index) => {
        if (index % 2 === 0) {
          return submitUntilAnswered([urls[index % urls.length]!], bet);
        }
        messageIds.push(await enqueueOperation(sqs, queues.urls.commands, bet));
        return undefined;
      }),
    );
    await waitForDrain(database.sql, sqs, queues, [bet]);

    const outcome = (await storedOutcomes(database.sql, [bet])).get(
      bet.idempotencyKey,
    )!;
    expect(outcome.status).toBe('PROCESSED');
    const answers = responses.filter(
      (response): response is ApiResponse => response !== undefined,
    );
    expect(answers).toHaveLength(25);
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      expect(answer.body.transactionId).toBe(outcome.id);
      expect(answer.body.balance).toEqual({ amount: '90.00', currency: 'BRL' });
    }
    expect(
      answers.filter((answer) => !answer.body.idempotentReplay).length,
    ).toBeLessThanOrEqual(1);
    const [inbox] = await database.sql`
      select count(*)::int as count from inbox_messages where message_id in ${database.sql(messageIds)}`;
    expect(inbox.count).toBe(25);
    const [debits] = await database.sql`
      select count(*)::int as count from wallet_ledger_entries where wallet_id = ${wallet.id} and direction = 'DEBIT'`;
    expect(debits.count).toBe(1);
    expect(await walletInvariantViolations(database.sql, wallet.id)).toEqual(
      [],
    );
  });
});
