import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { INestApplication } from '@nestjs/common';
import { createWorkerApplication } from '@app/worker-application';
import { loadConfig } from '@platform/config/app-config';
import { silentLogger } from '@shared/application/logger';
import { inconsistentWallets } from '@test/support/invariants';
import { waitUntil } from '@test/support/async';
import {
  METRICS_READER,
  bearerFor,
  testIdentity,
} from '@test/support/identity';
import { commandFor, referencing } from '@test/support/commands';
import {
  type PersistenceHarness,
  createPersistenceHarness,
} from '@test/support/persistence';
import {
  type TestQueues,
  createTestQueues,
  createTestSqsClient,
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
let worker: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork);
  sqs = createTestSqsClient();
  queues = await createTestQueues(sqs);
  const config = loadConfig({
    DATABASE_URL: harness.database.url,
    PORT: '0',
    INSTANCE_ID: 'worker-observed',
    ...queues.environment,
    ...(await testIdentity()).environment,
    OUTBOX_PUBLISHER_ENABLED: 'false',
    REFERENCE_SCHEDULER_ENABLED: 'false',
    SQS_RECEIVE_WAIT_SECONDS: '1',
    SQS_RECEIVE_TIMEOUT_MS: '3000',
    METRICS_SAMPLE_INTERVAL_MS: '100',
  });
  worker = await createWorkerApplication(config, { logger: silentLogger });
  await worker.listen(0, '127.0.0.1');
  baseUrl = (await worker.getUrl()).replace('[::1]', '127.0.0.1');
});

afterEach(async () => {
  expect(await inconsistentWallets(harness.database.sql)).toEqual([]);
});

afterAll(async () => {
  await worker.close();
  await queues.delete();
  sqs.destroy();
  await harness.close();
});

async function metricValue(
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  const response = await fetch(`${baseUrl}/metrics`, {
    headers: { authorization: await bearerFor({ roles: [METRICS_READER] }) },
  });
  const text = await response.text();
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
  return line === undefined ? Number.NaN : Number(line.split(' ').at(-1));
}

describe('worker observability', () => {
  test('counts dead-lettered messages and samples the backlog gauges', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    await wagering.submit.execute(
      referencing(
        commandFor(wallet, WagerTransactionKind.Bet, '10.00'),
        WagerTransactionKind.Refund,
      ),
    );
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queues.urls.commands,
        MessageBody: '{"not":"a wager request"}',
        MessageGroupId: wallet.id,
        MessageDeduplicationId: Bun.randomUUIDv7(),
      }),
    );

    await waitUntil(
      async () =>
        (await metricValue('sqs_messages_dead_lettered_total', {
          reason: 'INVALID_MESSAGE',
        })) === 1 &&
        (await metricValue('sqs_dlq_approximate_messages')) === 1 &&
        (await metricValue('outbox_pending_events')) === 3 &&
        (await metricValue('pending_reference_transactions')) === 1,
      { timeoutMs: 15_000, description: 'the worker metrics to settle' },
    );

    expect(
      await metricValue('outbox_oldest_pending_age_seconds'),
    ).toBeGreaterThan(0);
    expect(await metricValue('pending_reference_transactions')).toBe(1);
  });
});
