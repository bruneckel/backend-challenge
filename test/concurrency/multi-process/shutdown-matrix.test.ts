import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { waitUntil } from '@test/support/async';
import { commandFor } from '@test/support/commands';
import { walletInvariantViolations } from '@test/support/invariants';
import {
  type PersistenceHarness,
  createPersistenceHarness,
} from '@test/support/persistence';
import {
  type SpawnedProcess,
  spawnProcess,
  startProcess,
  startWorkerProcess,
} from '@test/support/processes';
import {
  type TestQueues,
  createTestQueues,
  createTestSqsClient,
  drainQueue,
  queueDepth,
} from '@test/support/sqs';
import {
  type Wagering,
  createWagering,
  openWalletWith,
} from '@test/support/wagering';
import type { WalletView } from '@wallet/application/views';
import { WagerTransactionKind } from '@wallet/domain/transaction/wager-transaction';

const SLOW_CONSUMER = 'test/support/entrypoints/worker-slow-consumer.ts';
const PAUSE_IN_TRANSACTION =
  'test/support/entrypoints/worker-pause-in-transaction.ts';
const PAUSE_BEFORE_ACK = 'test/support/entrypoints/worker-pause-before-ack.ts';
const PAUSE_AFTER_PUBLISH =
  'test/support/entrypoints/worker-pause-after-publish.ts';
const PUBLISHER_BATCH_SIZE = 5;

let sqs: SQSClient;
let harness: PersistenceHarness;
let wagering: Wagering;
let queues: TestQueues;

beforeAll(() => {
  sqs = createTestSqsClient();
});

beforeEach(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork);
  wagering.clock.set(new Date('2026-01-01T00:00:00.000Z'));
  queues = await createTestQueues(sqs);
});

afterEach(async () => {
  await queues.delete();
  await harness.close();
});

afterAll(() => {
  sqs.destroy();
});

const consumerEnvironment = (
  extra: Record<string, string> = {},
): Record<string, string> => ({
  DATABASE_URL: harness.database.url,
  ...queues.environment,
  OUTBOX_PUBLISHER_ENABLED: 'false',
  REFERENCE_SCHEDULER_ENABLED: 'false',
  SQS_RECEIVE_WAIT_SECONDS: '1',
  SQS_RECEIVE_TIMEOUT_MS: '3000',
  SQS_VISIBILITY_TIMEOUT_SECONDS: '2',
  SQS_HEARTBEAT_INTERVAL_MS: '1000',
  DB_POOL_SIZE: '3',
  ...extra,
});

const publisherEnvironment = (): Record<string, string> => ({
  DATABASE_URL: harness.database.url,
  ...queues.environment,
  CONSUMER_ENABLED: 'false',
  REFERENCE_SCHEDULER_ENABLED: 'false',
  OUTBOX_POLL_INTERVAL_MS: '50',
  OUTBOX_BATCH_SIZE: String(PUBLISHER_BATCH_SIZE),
  OUTBOX_RETRY_BASE_MS: '50',
  OUTBOX_RETRY_MAX_MS: '200',
  DB_POOL_SIZE: '3',
});

async function sendRequest(wallet: WalletView): Promise<string> {
  const messageId = `msg-${Bun.randomUUIDv7()}`;
  const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queues.urls.commands,
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'provider-a',
          externalTransactionId,
          idempotencyKey: `provider-a:${externalTransactionId}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-1',
          gameId: 'fortune-chimp',
          kind: 'BET',
          money: { amount: '25.00', currency: 'BRL' },
        },
      }),
      MessageGroupId: wallet.id,
      MessageDeduplicationId: Bun.randomUUIDv7(),
    }),
  );
  return messageId;
}

async function appliedMessageIds(wallets: WalletView[]): Promise<string[]> {
  const ids = wallets.map((wallet) => wallet.id);
  const rows = await harness.database.sql`
    select correlation_id from wager_transactions where kind = 'BET' and wallet_id in ${harness.database.sql(ids)}`;
  return rows.map((row: { correlation_id: string }) => row.correlation_id);
}

async function visibleMessageIds(): Promise<string[]> {
  const { Messages = [] } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queues.urls.commands,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 0,
    }),
  );
  return Messages.map((message) => JSON.parse(message.Body!).messageId);
}

async function inboxRows(messageId: string): Promise<number> {
  const [row] = await harness.database.sql`
    select count(*)::int as count from inbox_messages where message_id = ${messageId}`;
  return row.count;
}

async function outboxRows(): Promise<number> {
  const [row] = await harness.database
    .sql`select count(*)::int as count from outbox_messages`;
  return row.count;
}

async function pendingEvents(): Promise<number> {
  const [row] = await harness.database
    .sql`select count(*)::int as count from outbox_messages where published_at is null`;
  return row.count;
}

async function createEvents(wallets: number): Promise<number> {
  for (let index = 0; index < wallets; index += 1) {
    const wallet = await openWalletWith(wagering, '100.00');
    await wagering.submit.execute(
      commandFor(wallet, WagerTransactionKind.Bet, '10.00'),
    );
  }
  return outboxRows();
}

const deduplicationIdOf = (message: Message) =>
  message.Attributes?.MessageDeduplicationId;

async function balanceOf(wallet: WalletView): Promise<string> {
  return (await wagering.queries.getWallet(wallet.id)).balance.amount;
}

async function expectConsistent(wallets: WalletView[]): Promise<void> {
  for (const wallet of wallets) {
    expect(
      await walletInvariantViolations(harness.database.sql, wallet.id),
    ).toEqual([]);
  }
}

async function pausedWorker(
  entrypoint: string,
  environment: Record<string, string>,
  marker: string,
): Promise<SpawnedProcess> {
  const worker = spawnProcess(
    entrypoint,
    { TEST_PAUSE_MS: '3000', ...environment },
    entrypoint.split('/').at(-1),
  );
  let exited = false;
  void worker.exited.then(() => {
    exited = true;
  });
  await waitUntil(() => worker.output().includes(marker) || exited, {
    timeoutMs: 20_000,
    description: marker,
  });
  if (!worker.output().includes(marker)) {
    throw new Error(
      `${worker.name} exited before ${marker}:\n${worker.output()}`,
    );
  }
  return worker;
}

async function interrupt(
  worker: SpawnedProcess,
  signal: NodeJS.Signals,
): Promise<void> {
  worker.kill(signal);
  await worker.exited;
}

async function drainWithSurvivor(
  environment: Record<string, string>,
  drained: () => Promise<boolean>,
): Promise<void> {
  const survivor = await startWorkerProcess({
    ...environment,
    INSTANCE_ID: 'survivor',
  });
  try {
    await waitUntil(drained, {
      timeoutMs: 30_000,
      description: 'the survivor to drain the work left behind',
    });
  } finally {
    await survivor.stop();
  }
}

const commandsDrained = async () =>
  (await queueDepth(sqs, queues.urls.commands)) === 0;

describe('shutdown matrix: message received and not started', () => {
  test('SIGTERM finishes the messages in progress and gives the others back to the queue (I8)', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 6 }, () => openWalletWith(wagering, '100.00')),
    );
    const sent = [];
    for (const wallet of wallets) {
      sent.push(await sendRequest(wallet));
    }
    const worker = await startProcess(
      SLOW_CONSUMER,
      consumerEnvironment({
        CONSUMER_MAX_CONCURRENT_GROUPS: '2',
        SQS_VISIBILITY_TIMEOUT_SECONDS: '30',
        TEST_PAUSE_MS: '1500',
      }),
    );
    await waitUntil(() => worker.output().includes('processing started'), {
      timeoutMs: 15_000,
      description: 'a message to start',
    });

    await worker.stop('SIGTERM');

    const started = (worker.output().match(/processing started/g) ?? []).length;
    const finished = (worker.output().match(/processing finished/g) ?? [])
      .length;
    const applied = await appliedMessageIds(wallets);
    const givenBack = await visibleMessageIds();
    expect(worker.output()).toContain('"msg":"shutdown complete"');
    expect(finished).toBe(started);
    expect(applied).toHaveLength(started);
    expect(givenBack.sort()).toEqual(
      sent.filter((messageId) => !applied.includes(messageId)).sort(),
    );
    await expectConsistent(wallets);
  });

  test('SIGKILL leaves the messages to reappear after the visibility timeout and be applied once', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 3 }, () => openWalletWith(wagering, '100.00')),
    );
    const sent = [];
    for (const wallet of wallets) {
      sent.push(await sendRequest(wallet));
    }
    const environment = consumerEnvironment({
      CONSUMER_MAX_CONCURRENT_GROUPS: '1',
    });
    const worker = await pausedWorker(
      SLOW_CONSUMER,
      environment,
      'processing started',
    );

    await interrupt(worker, 'SIGKILL');

    expect(await appliedMessageIds(wallets)).toEqual([]);
    await drainWithSurvivor(environment, commandsDrained);
    expect((await appliedMessageIds(wallets)).sort()).toEqual(sent.sort());
    for (const wallet of wallets) {
      expect(await balanceOf(wallet)).toBe('75.00');
    }
    await expectConsistent(wallets);
  });
});

describe('shutdown matrix: during the transaction', () => {
  test('SIGTERM lets the transaction commit and the message be acknowledged', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const messageId = await sendRequest(wallet);
    const worker = await pausedWorker(
      PAUSE_IN_TRANSACTION,
      consumerEnvironment(),
      'paused inside the transaction',
    );
    expect(await appliedMessageIds([wallet])).toEqual([]);

    await interrupt(worker, 'SIGTERM');

    expect(worker.output()).toContain('"msg":"shutdown complete"');
    expect(await appliedMessageIds([wallet])).toEqual([messageId]);
    await Bun.sleep(2500);
    expect(await queueDepth(sqs, queues.urls.commands)).toBe(0);
    expect(await inboxRows(messageId)).toBe(1);
    expect(await balanceOf(wallet)).toBe('75.00');
    await expectConsistent([wallet]);
  });

  test('SIGKILL rolls the transaction back and the redelivery applies the operation once', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const messageId = await sendRequest(wallet);
    const eventsBefore = await outboxRows();
    const environment = consumerEnvironment();
    const worker = await pausedWorker(
      PAUSE_IN_TRANSACTION,
      environment,
      'paused inside the transaction',
    );

    await interrupt(worker, 'SIGKILL');

    expect(await appliedMessageIds([wallet])).toEqual([]);
    expect(await inboxRows(messageId)).toBe(0);
    expect(await outboxRows()).toBe(eventsBefore);
    expect(await balanceOf(wallet)).toBe('100.00');
    await drainWithSurvivor(environment, commandsDrained);
    expect(await appliedMessageIds([wallet])).toEqual([messageId]);
    expect(await inboxRows(messageId)).toBe(1);
    expect(await balanceOf(wallet)).toBe('75.00');
    await expectConsistent([wallet]);
  });
});

describe('shutdown matrix: after the commit and before the ack', () => {
  test('SIGTERM finishes the ack, so the message is not delivered again', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const messageId = await sendRequest(wallet);
    const worker = await pausedWorker(
      PAUSE_BEFORE_ACK,
      consumerEnvironment(),
      'committed, paused before the ack',
    );
    expect(await appliedMessageIds([wallet])).toEqual([messageId]);

    await interrupt(worker, 'SIGTERM');

    expect(worker.output()).toContain('"msg":"shutdown complete"');
    await Bun.sleep(2500);
    expect(await queueDepth(sqs, queues.urls.commands)).toBe(0);
    expect(await inboxRows(messageId)).toBe(1);
    expect(await balanceOf(wallet)).toBe('75.00');
    await expectConsistent([wallet]);
  });

  test('SIGKILL leads to a redelivery that leaves a single effect (C5)', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const messageId = await sendRequest(wallet);
    const environment = consumerEnvironment();
    const worker = await pausedWorker(
      PAUSE_BEFORE_ACK,
      environment,
      'committed, paused before the ack',
    );

    await interrupt(worker, 'SIGKILL');

    expect(await appliedMessageIds([wallet])).toEqual([messageId]);
    await drainWithSurvivor(environment, commandsDrained);
    expect(await appliedMessageIds([wallet])).toEqual([messageId]);
    expect(await inboxRows(messageId)).toBe(1);
    expect(await balanceOf(wallet)).toBe('75.00');
    await expectConsistent([wallet]);
  });
});

describe('shutdown matrix: publisher between sending and committing', () => {
  test('SIGTERM commits the batch, so every event is published exactly once', async () => {
    const total = await createEvents(1);
    expect(total).toBeLessThanOrEqual(PUBLISHER_BATCH_SIZE);
    const worker = await pausedWorker(
      PAUSE_AFTER_PUBLISH,
      publisherEnvironment(),
      'published, paused before the commit',
    );

    await interrupt(worker, 'SIGTERM');

    expect(worker.output()).toContain('"msg":"shutdown complete"');
    expect(await pendingEvents()).toBe(0);
    const messages = await drainQueue(sqs, queues.urls.events);
    expect(messages).toHaveLength(total);
    expect(new Set(messages.map(deduplicationIdOf)).size).toBe(total);
  });

  test('SIGKILL only leaves duplicates with the same event id (C6)', async () => {
    const total = await createEvents(5);
    const worker = await pausedWorker(
      PAUSE_AFTER_PUBLISH,
      publisherEnvironment(),
      'published, paused before the commit',
    );

    await interrupt(worker, 'SIGKILL');

    expect(await pendingEvents()).toBe(total);
    await drainWithSurvivor(
      publisherEnvironment(),
      async () => (await pendingEvents()) === 0,
    );
    const messages = await drainQueue(sqs, queues.urls.events);
    expect(new Set(messages.map(deduplicationIdOf)).size).toBe(total);
    expect(messages.length).toBeGreaterThanOrEqual(total);
    expect(messages.length).toBeLessThanOrEqual(total + PUBLISHER_BATCH_SIZE);
    for (const message of messages) {
      expect(JSON.parse(message.Body!).eventId).toBe(
        deduplicationIdOf(message),
      );
    }
  });
});
