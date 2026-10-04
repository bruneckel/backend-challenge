import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
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
let worker: INestApplication | undefined;

beforeAll(async () => {
  harness = await createPersistenceHarness();
  sqs = createTestSqsClient();
  queues = await createTestQueues(sqs);
});

afterEach(async () => {
  await worker?.close();
  await harness.database.sql`delete from outbox_messages`;
});

afterAll(async () => {
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

async function startWorker(settings: Record<string, string>): Promise<void> {
  const config = loadConfig({
    DATABASE_URL: harness.database.url,
    PORT: '0',
    ...queues.environment,
    ...(await testIdentity()).environment,
    OUTBOX_PUBLISHER_ENABLED: 'false',
    CONSUMER_ENABLED: 'false',
    REFERENCE_SCHEDULER_ENABLED: 'false',
    OUTBOX_RETENTION_HOURS: '24',
    ...settings,
  });
  worker = await createWorkerApplication(config, { logger: silentLogger });
  await worker.init();
}

describe('message retention in the worker', () => {
  test('purges expired published events in a loop and keeps the recent ones', async () => {
    const expired = await publishedEvent(new Date(Date.now() - 48 * 3_600_000));
    const recent = await publishedEvent(new Date());
    await startWorker({ RETENTION_INTERVAL_MS: '1000' });

    await waitUntil(async () => !(await storedIds()).includes(expired), {
      description: 'the expired event to be purged',
    });
    const later = await publishedEvent(new Date(Date.now() - 30 * 3_600_000));
    await waitUntil(async () => !(await storedIds()).includes(later), {
      description: 'the loop to purge again after its interval',
    });
    expect(await storedIds()).toEqual([recent]);
  });

  test('pauses between full batches', async () => {
    const day = 24 * 3_600_000;
    for (const age of [4, 3, 2]) {
      await publishedEvent(new Date(Date.now() - age * day));
    }
    await startWorker({
      RETENTION_BATCH_SIZE: '1',
      RETENTION_BATCH_PAUSE_MS: '1000',
    });

    await waitUntil(async () => (await storedIds()).length === 2, {
      description: 'the first batch to be purged',
      intervalMs: 10,
    });
    const remaining: number[] = [];
    for (let sample = 0; sample < 5; sample += 1) {
      remaining.push((await storedIds()).length);
      await Bun.sleep(50);
    }

    expect(remaining).toEqual([2, 2, 2, 2, 2]);
    await waitUntil(async () => (await storedIds()).length === 0, {
      description: 'the remaining batches to be purged after their pauses',
    });
  });

  test('releases the retention lease when the worker stops', async () => {
    await startWorker({ INSTANCE_ID: 'worker-lease' });
    const lease = async () => {
      const [row] = await harness.database.sql`
        select holder, expires_at <= now() as released
        from maintenance_leases where name = 'message-retention'`;
      return row;
    };
    await waitUntil(async () => (await lease())?.holder === 'worker-lease', {
      description: 'the worker to take the retention lease',
    });

    await worker?.close();
    worker = undefined;

    expect(await lease()).toEqual({ holder: 'worker-lease', released: true });
  });
});
