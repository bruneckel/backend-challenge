import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import type { Message, SQSClient } from '@aws-sdk/client-sqs';
import { waitUntil } from '@test/support/async';
import { commandFor } from '@test/support/commands';
import {
  type PersistenceHarness,
  createPersistenceHarness,
} from '@test/support/persistence';
import { spawnProcess, startWorkerProcess } from '@test/support/processes';
import {
  type TestQueues,
  createTestQueues,
  createTestSqsClient,
  drainQueue,
} from '@test/support/sqs';
import {
  type Wagering,
  createWagering,
  openWalletWith,
} from '@test/support/wagering';
import { WagerTransactionKind } from '@wallet/domain/transaction/wager-transaction';

let harness: PersistenceHarness;
let wagering: Wagering;
let sqs: SQSClient;
let queues: TestQueues;

const BATCH_SIZE = 5;

beforeAll(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork);
  wagering.clock.set(new Date('2026-01-01T00:00:00.000Z'));
  sqs = createTestSqsClient();
});

beforeEach(async () => {
  queues = await createTestQueues(sqs);
});

afterEach(async () => {
  await queues.delete();
});

afterAll(async () => {
  sqs.destroy();
  await harness.close();
});

const workerEnvironment = (): Record<string, string> => ({
  DATABASE_URL: harness.database.url,
  ...queues.environment,
  OUTBOX_POLL_INTERVAL_MS: '50',
  OUTBOX_BATCH_SIZE: String(BATCH_SIZE),
  OUTBOX_RETRY_BASE_MS: '50',
  OUTBOX_RETRY_MAX_MS: '200',
  DB_POOL_SIZE: '3',
});

async function createEvents(wallets: number): Promise<number> {
  for (let index = 0; index < wallets; index += 1) {
    const wallet = await openWalletWith(wagering, '100.00');
    await wagering.submit.execute(
      commandFor(wallet, WagerTransactionKind.Bet, '10.00'),
    );
  }
  return wallets * 4;
}

async function pendingEvents(): Promise<number> {
  const [row] = await harness.database
    .sql`select count(*)::int as count from outbox_messages where published_at is null`;
  return row.count;
}

const deduplicationIdOf = (message: Message) =>
  message.Attributes?.MessageDeduplicationId;

function expectEventIdsMatchDeduplicationIds(messages: Message[]): void {
  for (const message of messages) {
    expect(JSON.parse(message.Body!).eventId).toBe(deduplicationIdOf(message));
  }
}

describe('C6 publishers on separate processes', () => {
  test('two worker processes publish every event exactly once on the happy path', async () => {
    const total = await createEvents(20);
    const workers = await Promise.all(
      [1, 2].map((number) =>
        startWorkerProcess({
          ...workerEnvironment(),
          INSTANCE_ID: `worker-${number}`,
        }),
      ),
    );

    try {
      await waitUntil(async () => (await pendingEvents()) === 0, {
        timeoutMs: 30_000,
        description: 'the outbox to drain',
      });
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
    }

    const messages = await drainQueue(sqs, queues.urls.events);
    expect(messages).toHaveLength(total);
    expect(new Set(messages.map(deduplicationIdOf)).size).toBe(total);
    expectEventIdsMatchDeduplicationIds(messages);
    for (const worker of workers) {
      expect(worker.output()).toContain('"msg":"shutdown complete"');
    }
  });

  test('a publisher killed between sending and committing only leaves duplicates with the same event id', async () => {
    const total = await createEvents(5);

    const crashing = spawnProcess(
      'test/support/entrypoints/worker-crash-after-publish.ts',
      workerEnvironment(),
      'crashing-worker',
    );
    await crashing.exited;
    expect(crashing.output()).toContain('published before crash');
    expect(await pendingEvents()).toBe(total);

    const survivor = await startWorkerProcess({
      ...workerEnvironment(),
      INSTANCE_ID: 'survivor',
    });
    try {
      await waitUntil(async () => (await pendingEvents()) === 0, {
        timeoutMs: 30_000,
        description: 'the outbox to drain',
      });
    } finally {
      await survivor.stop();
    }

    const messages = await drainQueue(sqs, queues.urls.events);
    expect(new Set(messages.map(deduplicationIdOf)).size).toBe(total);
    expect(messages.length).toBeGreaterThanOrEqual(total);
    expect(messages.length).toBeLessThanOrEqual(total + BATCH_SIZE);
    expectEventIdsMatchDeduplicationIds(messages);
  });
});
