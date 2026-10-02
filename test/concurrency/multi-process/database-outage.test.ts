import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { waitUntil } from '@test/support/async';
import {
  type PersistenceHarness,
  createPersistenceHarness,
} from '@test/support/persistence';
import { startWorkerProcess } from '@test/support/processes';
import {
  type TestQueues,
  createTestQueues,
  createTestSqsClient,
  drainQueue,
} from '@test/support/sqs';
import { type TcpProxy, startTcpProxy } from '@test/support/tcp-proxy';
import {
  type Wagering,
  createWagering,
  openWalletWith,
} from '@test/support/wagering';

let harness: PersistenceHarness;
let wagering: Wagering;
let sqs: SQSClient;
let queues: TestQueues;
let proxy: TcpProxy;

beforeAll(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork);
  sqs = createTestSqsClient();
  queues = await createTestQueues(sqs);
  proxy = await startTcpProxy('127.0.0.1', 5432);
});

afterAll(async () => {
  await proxy.close();
  await queues.delete();
  sqs.destroy();
  await harness.close();
});

describe('I9 PostgreSQL outage', () => {
  test('the worker reports not ready, pauses the consumer and recovers without losing the message', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const throughProxy = new URL(harness.database.url);
    throughProxy.port = String(proxy.port);
    const worker = await startWorkerProcess({
      DATABASE_URL: throughProxy.toString(),
      ...queues.environment,
      OUTBOX_PUBLISHER_ENABLED: 'false',
      REFERENCE_SCHEDULER_ENABLED: 'false',
      READINESS_CACHE_MS: '0',
      SQS_RECEIVE_WAIT_SECONDS: '1',
      SQS_RECEIVE_TIMEOUT_MS: '3000',
      SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
      SQS_HEARTBEAT_INTERVAL_MS: '1000',
      CONSUMER_RETRY_BASE_MS: '1000',
      CONSUMER_RETRY_MAX_MS: '2000',
      DB_POOL_SIZE: '3',
    });
    const readiness = async () => {
      const response = await fetch(`${worker.url}/health/ready`);
      return { status: response.status, body: await response.json() };
    };
    const messageId = `msg-${Bun.randomUUIDv7()}`;
    const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;

    try {
      proxy.pause();
      await waitUntil(async () => (await readiness()).status === 503, {
        timeoutMs: 10_000,
        description: 'readiness to report the outage',
      });
      expect((await readiness()).body).toMatchObject({
        status: 'not_ready',
        checks: { database: 'down', sqs: 'up' },
      });
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
          MessageDeduplicationId: messageId,
        }),
      );
      await waitUntil(() => worker.output().includes('wager consumer paused'), {
        timeoutMs: 15_000,
        description: 'the consumer to pause',
      });

      proxy.resume();
      await waitUntil(async () => (await readiness()).status === 200, {
        timeoutMs: 15_000,
        description: 'readiness to recover',
      });
      await waitUntil(
        async () =>
          (await wagering.queries.getWallet(wallet.id)).balance.amount ===
          '75.00',
        { timeoutMs: 30_000, description: 'the message to be applied' },
      );
    } finally {
      await worker.stop();
    }

    const transactions = await harness.database.sql`
      select count(*)::int as count from wager_transactions where correlation_id = ${messageId}`;
    expect(transactions[0].count).toBe(1);
    expect(
      await drainQueue(sqs, queues.urls.deadLetter, { idleReceives: 1 }),
    ).toEqual([]);
  });
});
