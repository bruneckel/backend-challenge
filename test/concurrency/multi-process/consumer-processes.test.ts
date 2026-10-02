import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ReceiveMessageCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { waitUntil } from '@test/support/async';
import { walletInvariantViolations } from '@test/support/invariants';
import { type PersistenceHarness, createPersistenceHarness } from '@test/support/persistence';
import { spawnProcess, startProcess, startWorkerProcess } from '@test/support/processes';
import { type TestQueues, createTestQueues, createTestSqsClient } from '@test/support/sqs';
import { type Wagering, createWagering, openWalletWith } from '@test/support/wagering';
import type { WalletView } from '@wallet/application/views';

let harness: PersistenceHarness;
let wagering: Wagering;
let sqs: SQSClient;
let queues: TestQueues;

beforeAll(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork);
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

const workerEnvironment = (extra: Record<string, string> = {}): Record<string, string> => ({
  DATABASE_URL: harness.database.url,
  ...queues.environment,
  OUTBOX_PUBLISHER_ENABLED: 'false',
  SQS_RECEIVE_WAIT_SECONDS: '1',
  SQS_RECEIVE_TIMEOUT_MS: '3000',
  SQS_HEARTBEAT_INTERVAL_MS: '1000',
  DB_POOL_SIZE: '3',
  ...extra,
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
    new ReceiveMessageCommand({ QueueUrl: queues.urls.commands, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 0 }),
  );
  return Messages.map((message) => JSON.parse(message.Body!).messageId);
}

describe('consumer processes', () => {
  test('I8 SIGTERM finishes the messages in progress and gives the others back to the queue', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => openWalletWith(wagering, '100.00')));
    const sent = [];
    for (const wallet of wallets) {
      sent.push(await sendRequest(wallet));
    }
    const worker = await startProcess(
      'test/support/entrypoints/worker-slow-consumer.ts',
      workerEnvironment({ CONSUMER_MAX_CONCURRENT_GROUPS: '2', SQS_VISIBILITY_TIMEOUT_SECONDS: '30', TEST_SLOW_HANDLER_MS: '1500' }),
    );
    await waitUntil(() => worker.output().includes('processing started'), { timeoutMs: 15_000, description: 'a message to start' });

    await worker.stop('SIGTERM');

    const started = (worker.output().match(/processing started/g) ?? []).length;
    const finished = (worker.output().match(/processing finished/g) ?? []).length;
    const applied = await appliedMessageIds(wallets);
    const givenBack = await visibleMessageIds();
    expect(worker.output()).toContain('"msg":"shutdown complete"');
    expect(finished).toBe(started);
    expect(applied).toHaveLength(started);
    expect(givenBack.sort()).toEqual(sent.filter((messageId) => !applied.includes(messageId)).sort());
    for (const wallet of wallets) {
      expect(await walletInvariantViolations(harness.database.sql, wallet.id)).toEqual([]);
    }
  });

  test('C5 a worker killed after the commit and before the ack leaves a single effect after redelivery', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const messageId = await sendRequest(wallet);
    const environment = workerEnvironment({ SQS_VISIBILITY_TIMEOUT_SECONDS: '2' });

    const crashing = spawnProcess('test/support/entrypoints/worker-crash-before-ack.ts', environment, 'crashing-consumer');
    await crashing.exited;
    expect(crashing.output()).toContain('committed, crashing before the ack');
    expect(await appliedMessageIds([wallet])).toEqual([messageId]);

    const survivor = await startWorkerProcess({ ...environment, INSTANCE_ID: 'survivor' });
    try {
      await waitUntil(
        async () => {
          const [inbox] = await harness.database.sql`select count(*)::int as count from inbox_messages where message_id = ${messageId}`;
          return inbox.count === 1 && (await visibleMessageIds()).length === 0;
        },
        { timeoutMs: 20_000, description: 'the redelivery to be acknowledged' },
      );
      await Bun.sleep(2500);
    } finally {
      await survivor.stop();
    }

    expect(await appliedMessageIds([wallet])).toEqual([messageId]);
    expect((await wagering.queries.getWallet(wallet.id)).balance.amount).toBe('75.00');
    expect(await visibleMessageIds()).toEqual([]);
    expect(await walletInvariantViolations(harness.database.sql, wallet.id)).toEqual([]);
  });
});
