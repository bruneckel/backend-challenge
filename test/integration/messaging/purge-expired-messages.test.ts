import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PurgeExpiredMessages } from '@messaging/application/purge-expired-messages';
import { InboxMessage } from '@messaging/domain/inbox-message';
import { OutboxMessage } from '@messaging/domain/outbox-message';
import { HASH, openedWallet, settledBet } from '@test/support/domain-builders';
import {
  type PersistenceHarness,
  createPersistenceHarness,
} from '@test/support/persistence';
import { RecordingMetrics } from '@test/support/recording-metrics';
import { FixedClock } from '@test/support/wagering';
import { WalletBalanceChanged } from '@wallet/domain/events/wallet-balance-changed';

const NOW = new Date('2026-10-03T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

let harness: PersistenceHarness;

beforeAll(async () => {
  harness = await createPersistenceHarness();
});

afterAll(async () => {
  await harness.close();
});

async function publishedEvent(createdHoursAgo: number): Promise<string> {
  const opened = openedWallet('100.00');
  const { entry } = settledBet(opened.wallet);
  const message = OutboxMessage.enqueue(
    WalletBalanceChanged.from(opened.wallet, entry, {
      eventId: Bun.randomUUIDv7('hex', ago(createdHoursAgo)),
      correlationId: 'correlation-1',
      occurredAt: ago(createdHoursAgo),
    }),
  );
  message.markPublished(ago(createdHoursAgo));
  await harness.unitOfWork.run(async ({ outbox }) => {
    await outbox.enqueue([message]);
    await outbox.saveAll([message]);
  });
  return message.id;
}

async function processedMessage(receivedHoursAgo: number): Promise<string> {
  const message = InboxMessage.receive({
    messageId: Bun.randomUUIDv7(),
    consumerName: 'wager-commands',
    payloadHash: HASH,
    receivedAt: ago(receivedHoursAgo),
  });
  message.markProcessed(ago(receivedHoursAgo));
  await harness.unitOfWork.run(async ({ inbox }) => {
    await inbox.record(message);
    await inbox.saveProcessed(message, undefined);
  });
  return message.messageId;
}

async function pendingEvent(createdHoursAgo: number): Promise<OutboxMessage> {
  const opened = openedWallet('100.00');
  const { entry } = settledBet(opened.wallet);
  const message = OutboxMessage.enqueue(
    WalletBalanceChanged.from(opened.wallet, entry, {
      eventId: Bun.randomUUIDv7('hex', ago(createdHoursAgo)),
      correlationId: 'correlation-1',
      occurredAt: ago(createdHoursAgo),
    }),
  );
  await harness.unitOfWork.run(({ outbox }) => outbox.enqueue([message]));
  return message;
}

async function unprocessedMessage(
  receivedHoursAgo: number,
): Promise<InboxMessage> {
  const message = InboxMessage.receive({
    messageId: Bun.randomUUIDv7(),
    consumerName: 'wager-commands',
    payloadHash: HASH,
    receivedAt: ago(receivedHoursAgo),
  });
  await harness.unitOfWork.run(({ inbox }) => inbox.record(message));
  return message;
}

async function remaining(): Promise<{ outbox: string[]; inbox: string[] }> {
  const outbox: { id: string }[] = await harness.database
    .sql`select id from outbox_messages order by id`;
  const inbox: { message_id: string }[] = await harness.database
    .sql`select message_id from inbox_messages order by message_id`;
  return {
    outbox: outbox.map((row) => row.id),
    inbox: inbox.map((row) => row.message_id),
  };
}

describe('PurgeExpiredMessages', () => {
  test('deletes one batch of expired published events and processed messages per run', async () => {
    const expiredEvents = [
      await publishedEvent(200),
      await publishedEvent(190),
      await publishedEvent(180),
    ];
    const freshEvent = await publishedEvent(1);
    const expiredMessages = [
      await processedMessage(400),
      await processedMessage(380),
      await processedMessage(370),
    ];
    const freshMessage = await processedMessage(300);
    const metrics = new RecordingMetrics();
    const purge = new PurgeExpiredMessages({
      unitOfWork: harness.unitOfWork,
      clock: new FixedClock(NOW),
      metrics,
      settings: {
        outboxRetentionHours: 168,
        inboxRetentionHours: 360,
        batchSize: 2,
      },
    });

    const runs = [
      await purge.execute(),
      await purge.execute(),
      await purge.execute(),
    ];

    expect(runs).toEqual([
      { outbox: 2, inbox: 2 },
      { outbox: 1, inbox: 1 },
      { outbox: 0, inbox: 0 },
    ]);
    expect(await remaining()).toEqual({
      outbox: [freshEvent],
      inbox: [freshMessage],
    });
    expect(expiredEvents).toHaveLength(3);
    expect(expiredMessages).toHaveLength(3);
    expect(metrics.count('outbox_events_purged_total')).toBe(3);
    expect(metrics.count('inbox_messages_purged_total')).toBe(3);
  });

  test('continues after the last purged row while batches are full and starts over after a partial one', async () => {
    const before = await remaining();
    const lateEvent = await pendingEvent(300);
    await publishedEvent(290);
    await publishedEvent(280);
    const lateMessage = await unprocessedMessage(500);
    await processedMessage(490);
    await processedMessage(480);
    const purge = new PurgeExpiredMessages({
      unitOfWork: harness.unitOfWork,
      clock: new FixedClock(NOW),
      metrics: new RecordingMetrics(),
      settings: {
        outboxRetentionHours: 168,
        inboxRetentionHours: 360,
        batchSize: 1,
      },
    });

    const first = await purge.execute();
    await harness.unitOfWork.run(async ({ outbox, inbox }) => {
      lateEvent.markPublished(ago(279));
      await outbox.saveAll([lateEvent]);
      lateMessage.markProcessed(ago(479));
      await inbox.saveProcessed(lateMessage, undefined);
    });
    const second = await purge.execute();
    const afterSecond = await remaining();
    const rest = [
      await purge.execute(),
      await purge.execute(),
      await purge.execute(),
    ];

    expect([first, second, ...rest]).toEqual([
      { outbox: 1, inbox: 1 },
      { outbox: 1, inbox: 1 },
      { outbox: 0, inbox: 0 },
      { outbox: 1, inbox: 1 },
      { outbox: 0, inbox: 0 },
    ]);
    expect(afterSecond).toEqual({
      outbox: [...before.outbox, lateEvent.id].sort(),
      inbox: [...before.inbox, lateMessage.messageId].sort(),
    });
    expect(await remaining()).toEqual(before);
  });
});
