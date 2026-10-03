import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { INestApplication } from '@nestjs/common';
import { createWorkerApplication } from '@app/worker-application';
import { OutboxMessage } from '@messaging/domain/outbox-message';
import { loadConfig } from '@platform/config/app-config';
import { silentLogger } from '@shared/application/logger';
import { waitUntil } from '@test/support/async';
import { openedWallet, settledBet } from '@test/support/domain-builders';
import { testIdentity } from '@test/support/identity';
import {
  type PersistenceHarness,
  createPersistenceHarness,
} from '@test/support/persistence';
import {
  type TestQueues,
  createTestQueues,
  createTestSqsClient,
} from '@test/support/sqs';
import { WalletBalanceChanged } from '@wallet/domain/events/wallet-balance-changed';

let harness: PersistenceHarness;
let sqs: SQSClient;
let queues: TestQueues;
let worker: INestApplication;

beforeAll(async () => {
  harness = await createPersistenceHarness();
  sqs = createTestSqsClient();
  queues = await createTestQueues(sqs);
});

afterAll(async () => {
  await worker?.close();
  await queues.delete();
  sqs.destroy();
  await harness.close();
});

async function publishedEvent(createdAt: Date): Promise<string> {
  const opened = openedWallet('100.00');
  const { entry } = settledBet(opened.wallet);
  const message = OutboxMessage.enqueue(
    WalletBalanceChanged.from(opened.wallet, entry, {
      eventId: Bun.randomUUIDv7('hex', createdAt),
      correlationId: 'correlation-1',
      occurredAt: createdAt,
    }),
  );
  message.markPublished(createdAt);
  await harness.unitOfWork.run(async ({ outbox }) => {
    await outbox.enqueue([message]);
    await outbox.saveAll([message]);
  });
  return message.id;
}

async function storedIds(): Promise<string[]> {
  const rows: { id: string }[] = await harness.database
    .sql`select id from outbox_messages`;
  return rows.map((row) => row.id);
}

describe('message retention in the worker', () => {
  test('purges expired published events in a loop and keeps the recent ones', async () => {
    const expired = await publishedEvent(new Date(Date.now() - 48 * 3_600_000));
    const recent = await publishedEvent(new Date());
    const config = loadConfig({
      DATABASE_URL: harness.database.url,
      PORT: '0',
      ...queues.environment,
      ...(await testIdentity()).environment,
      OUTBOX_PUBLISHER_ENABLED: 'false',
      CONSUMER_ENABLED: 'false',
      REFERENCE_SCHEDULER_ENABLED: 'false',
      OUTBOX_RETENTION_HOURS: '24',
      RETENTION_INTERVAL_MS: '1000',
    });

    worker = await createWorkerApplication(config, { logger: silentLogger });
    await worker.init();

    await waitUntil(async () => !(await storedIds()).includes(expired), {
      description: 'the expired event to be purged',
    });
    const later = await publishedEvent(new Date(Date.now() - 30 * 3_600_000));
    await waitUntil(async () => !(await storedIds()).includes(later), {
      description: 'the loop to purge again after its interval',
    });
    expect(await storedIds()).toEqual([recent]);
  });
});
