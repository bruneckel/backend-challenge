import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '@messaging/application/ports/event-publisher';
import { PublishOutboxBatch } from '@messaging/application/publish-outbox-batch';
import { createOutboxScope } from '@messaging/infrastructure/persistence/outbox-scope';
import { createSqsClient } from '@messaging/infrastructure/sqs/sqs-client';
import { SqsEventPublisher } from '@messaging/infrastructure/sqs/sqs-event-publisher';
import { MikroOrmUnitOfWork } from '@platform/database/mikro-orm-unit-of-work';
import { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import { commandFor } from '@test/support/commands';
import { insertRow } from '@test/support/database';
import { type PersistenceHarness, createPersistenceHarness } from '@test/support/persistence';
import { outboxRow } from '@test/support/schema-rows';
import { SQS_SETTINGS, type TestQueues, createTestQueues, createTestSqsClient, drainQueue } from '@test/support/sqs';
import { FixedClock, START, type Wagering, createWagering, openWalletWith } from '@test/support/wagering';
import { WagerTransactionKind } from '@wallet/domain/transaction/wager-transaction';

let harness: PersistenceHarness;
let wagering: Wagering;
let sqs: SQSClient;
let queues: TestQueues;

const PUBLISH_AT = new Date(START.getTime() + 60_000);
const retryBackoff = ExponentialBackoff.create({ baseMs: 1000, maxMs: 300_000, random: () => 1 });

beforeEach(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork);
  sqs = createTestSqsClient();
  queues = await createTestQueues(sqs);
});

afterEach(async () => {
  await queues.delete();
  sqs.destroy();
  await harness.close();
});

function publishing(publisher: EventPublisher, at = PUBLISH_AT, batchSize = 10): PublishOutboxBatch {
  return new PublishOutboxBatch({
    unitOfWork: new MikroOrmUnitOfWork(harness.orm, createOutboxScope, { lockTimeoutMs: 2000 }),
    publisher,
    clock: new FixedClock(at),
    retryBackoff,
    batchSize,
  });
}

const realPublisher = () => new SqsEventPublisher(sqs, queues.urls.events);

async function walletWithBet(): Promise<string> {
  const wallet = await openWalletWith(wagering, '100.00');
  await wagering.submit.execute(commandFor(wallet, WagerTransactionKind.Bet, '10.00'));
  return wallet.id;
}

async function outboxState() {
  return harness.database.sql`
    select id, event_type, message_group_id, payload, attempts, last_error, next_attempt_at, published_at
    from outbox_messages order by id`;
}

describe('PublishOutboxBatch with SQS', () => {
  test('publishes due events to the FIFO queue grouped by wallet and deduplicated by event id', async () => {
    const walletId = await walletWithBet();

    const summary = await publishing(realPublisher()).execute();

    expect(summary).toEqual({ claimed: 4, published: 4, retried: 0 });
    const rows = await outboxState();
    expect(rows.every((row: { published_at: Date | null }) => row.published_at !== null)).toBe(true);
    const messages = await drainQueue(sqs, queues.urls.events);
    expect(messages.map((message) => JSON.parse(message.Body!).eventType)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    for (const [index, message] of messages.entries()) {
      expect(JSON.parse(message.Body!)).toEqual(rows[index].payload);
      expect(message.Attributes?.MessageGroupId).toBe(walletId);
      expect(message.Attributes?.MessageDeduplicationId).toBe(rows[index].id);
      expect(message.MessageAttributes?.eventType?.StringValue).toBe(rows[index].event_type);
    }
  });

  test('marks only the entries the broker accepted and schedules the refused ones for another attempt', async () => {
    await walletWithBet();
    const refused = outboxRow({ payload: { note: 'not allowed ￿' }, occurred_at: START, next_attempt_at: START });
    await insertRow(harness.database.sql, 'outbox_messages', refused);

    const summary = await publishing(realPublisher()).execute();

    expect(summary).toEqual({ claimed: 5, published: 4, retried: 1 });
    const [row] = await harness.database.sql`
      select attempts, last_error, next_attempt_at, published_at from outbox_messages where id = ${refused.id}`;
    expect(row).toMatchObject({ attempts: 1, published_at: null, next_attempt_at: new Date(PUBLISH_AT.getTime() + 1000) });
    expect(row.last_error).toContain('InvalidMessageContents');
    expect(await drainQueue(sqs, queues.urls.events)).toHaveLength(4);
  });

  test('treats an ambiguous answer as a failure of the whole batch and resends the same event ids', async () => {
    await walletWithBet();
    const real = realPublisher();
    const answerLost: EventPublisher = {
      async publish(messages) {
        await real.publish(messages);
        throw new Error('response lost');
      },
    };

    const first = await publishing(answerLost).execute();
    const second = await publishing(real, new Date(PUBLISH_AT.getTime() + 2000)).execute();

    expect(first).toEqual({ claimed: 4, published: 0, retried: 4 });
    expect(second).toEqual({ claimed: 4, published: 4, retried: 0 });
    const messages = await drainQueue(sqs, queues.urls.events);
    expect(messages).toHaveLength(4);
    expect(new Set(messages.map((message) => message.Attributes?.MessageDeduplicationId)).size).toBe(4);
  });

  test('gives up at once when the broker refuses connections', async () => {
    await walletWithBet();
    const unreachable = createSqsClient({ ...SQS_SETTINGS, endpoint: 'http://127.0.0.1:9' }, { requestTimeoutMs: 1000 });
    const started = Date.now();

    const summary = await publishing(new SqsEventPublisher(unreachable, queues.urls.events)).execute();

    expect(summary).toEqual({ claimed: 4, published: 0, retried: 4 });
    expect(Date.now() - started).toBeLessThan(2000);
    unreachable.destroy();
  });

  test('gives up when the broker does not answer within the publish timeout', async () => {
    await walletWithBet();
    const silent = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {}, open() {} } });
    const client = createSqsClient({ ...SQS_SETTINGS, endpoint: `http://127.0.0.1:${silent.port}` }, { requestTimeoutMs: 300 });
    const started = Date.now();

    const summary = await publishing(new SqsEventPublisher(client, queues.urls.events)).execute();

    const elapsed = Date.now() - started;
    expect(summary).toEqual({ claimed: 4, published: 0, retried: 4 });
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(3000);
    const rows = await outboxState();
    expect(rows.every((row: { last_error: string | null }) => row.last_error !== null)).toBe(true);
    client.destroy();
    silent.stop(true);
  });

  test('lets two publishers in one process share the outbox without publishing an event twice', async () => {
    for (let index = 0; index < 10; index += 1) {
      await walletWithBet();
    }
    const drain = async (publisher: PublishOutboxBatch) => {
      while ((await publisher.execute()).claimed > 0) {
        await Bun.sleep(1);
      }
    };

    await Promise.all([drain(publishing(realPublisher(), PUBLISH_AT, 3)), drain(publishing(realPublisher(), PUBLISH_AT, 3))]);

    const pending = await harness.database.sql`select count(*)::int as count from outbox_messages where published_at is null`;
    expect(pending[0].count).toBe(0);
    const messages = await drainQueue(sqs, queues.urls.events);
    expect(messages).toHaveLength(40);
    expect(new Set(messages.map((message) => message.Attributes?.MessageDeduplicationId)).size).toBe(40);
  });
});
