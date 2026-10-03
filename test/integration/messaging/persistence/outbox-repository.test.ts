import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { OutboxMessage } from '@messaging/domain/outbox-message';
import { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import { gate } from '@test/support/async';
import { openedWallet, settledBet } from '@test/support/domain-builders';
import {
  type PersistenceHarness,
  createPersistenceHarness,
  plain,
} from '@test/support/persistence';
import { WalletBalanceChanged } from '@wallet/domain/events/wallet-balance-changed';

let harness: PersistenceHarness;

beforeEach(async () => {
  harness = await createPersistenceHarness();
});

afterEach(async () => {
  await harness.close();
});

const NOW = new Date('2026-10-02T12:00:00.000Z');

function eventMessage(
  occurredAt: Date,
  eventId = Bun.randomUUIDv7(),
): OutboxMessage {
  const opened = openedWallet('100.00');
  const { entry } = settledBet(opened.wallet);
  const event = WalletBalanceChanged.from(opened.wallet, entry, {
    eventId,
    correlationId: 'correlation-1',
    occurredAt,
  });
  return OutboxMessage.enqueue(event);
}

const minutesFromNow = (minutes: number) =>
  new Date(NOW.getTime() + minutes * 60_000);

const enqueue = (...messages: OutboxMessage[]) =>
  harness.unitOfWork.run(({ outbox }) => outbox.enqueue(messages));

const claim = (limit = 10, now = NOW) =>
  harness.unitOfWork.run(({ outbox }) => outbox.claimDueBatch(now, limit));

const CUTOFF = new Date('2026-09-25T12:00:00.000Z');

const createdAt = (offsetMs: number) =>
  eventMessage(
    minutesFromNow(-1),
    Bun.randomUUIDv7('hex', new Date(CUTOFF.getTime() + offsetMs)),
  );

const publish = (...messages: OutboxMessage[]) =>
  harness.unitOfWork.run(async ({ outbox }) => {
    for (const message of messages) {
      message.markPublished(NOW);
    }
    await outbox.saveAll(messages);
  });

const purge = (limit: number, after?: string) =>
  harness.unitOfWork.run(({ outbox }) =>
    outbox.deletePublishedBefore(CUTOFF, limit, after),
  );

async function storedIds(): Promise<string[]> {
  const rows: { id: string }[] = await harness.database
    .sql`select id from outbox_messages order by id`;
  return rows.map((row) => row.id);
}

describe('MikroOrmOutboxRepository', () => {
  test('stores the event envelope and reads it back unchanged', async () => {
    const message = eventMessage(minutesFromNow(-1));
    await enqueue(message);

    const [claimed] = await claim();

    expect(plain(claimed?.toState())).toEqual(plain(message.toState()));
  });

  test('claims due messages oldest first and leaves the ones not yet due', async () => {
    const older = eventMessage(minutesFromNow(-5));
    const newer = eventMessage(minutesFromNow(-1));
    const future = eventMessage(minutesFromNow(5));
    await enqueue(newer, future, older);

    const claimed = await claim();

    expect(claimed.map((message) => message.id)).toEqual([older.id, newer.id]);
  });

  test('respects the batch limit', async () => {
    await enqueue(
      eventMessage(minutesFromNow(-3)),
      eventMessage(minutesFromNow(-2)),
      eventMessage(minutesFromNow(-1)),
    );

    expect(await claim(2)).toHaveLength(2);
  });

  test('stops claiming a message once it is saved as published', async () => {
    await enqueue(eventMessage(minutesFromNow(-1)));

    await harness.unitOfWork.run(async ({ outbox }) => {
      for (const message of await outbox.claimDueBatch(NOW, 10)) {
        message.markPublished(NOW);
        await outbox.save(message);
      }
    });

    expect(await claim()).toEqual([]);
  });

  test('saves a failed attempt and claims the message again only when it is due', async () => {
    const message = eventMessage(minutesFromNow(-1));
    await enqueue(message);
    const backoff = ExponentialBackoff.create({
      baseMs: 60_000,
      maxMs: 60_000,
      random: () => 1,
    });

    await harness.unitOfWork.run(async ({ outbox }) => {
      const [claimed] = await outbox.claimDueBatch(NOW, 10);
      claimed!.scheduleRetry(NOW, backoff, 'broker unavailable');
      await outbox.save(claimed!);
    });

    expect(await claim(10, NOW)).toEqual([]);
    const [retried] = await claim(10, minutesFromNow(1));
    expect(retried?.toState()).toMatchObject({
      attempts: 1,
      lastError: 'broker unavailable',
      nextAttemptAt: minutesFromNow(1),
    });
  });

  test('saves the outcome of a whole batch in one call', async () => {
    const published = eventMessage(minutesFromNow(-3));
    const failed = eventMessage(minutesFromNow(-2));
    const untouched = eventMessage(minutesFromNow(-1));
    await enqueue(published, failed, untouched);
    const backoff = ExponentialBackoff.create({
      baseMs: 60_000,
      maxMs: 60_000,
      random: () => 1,
    });

    await harness.unitOfWork.run(async ({ outbox }) => {
      const [first, second] = await outbox.claimDueBatch(NOW, 2);
      first!.markPublished(NOW);
      second!.scheduleRetry(NOW, backoff, 'Throttled: slow down');
      await outbox.saveAll([first!, second!]);
    });

    expect((await claim(10, NOW)).map((message) => message.id)).toEqual([
      untouched.id,
    ]);
    const later = await claim(10, minutesFromNow(1));
    expect(later.map((message) => message.id)).toEqual([
      untouched.id,
      failed.id,
    ]);
    expect(later[1]?.toState()).toMatchObject({
      attempts: 1,
      lastError: 'Throttled: slow down',
      nextAttemptAt: minutesFromNow(1),
    });
    const [row] = await harness.database.sql`
      select published_at from outbox_messages where id = ${published.id}`;
    expect(row.published_at).toEqual(NOW);
  });

  test('saves an empty batch without touching anything', async () => {
    const message = eventMessage(minutesFromNow(-1));
    await enqueue(message);

    await harness.unitOfWork.run(({ outbox }) => outbox.saveAll([]));

    expect((await claim()).map((claimed) => claimed.id)).toEqual([message.id]);
  });

  test('deletes the published events created before the cutoff and keeps the rest', async () => {
    const old = createdAt(-60_000);
    const recent = createdAt(60_000);
    const pending = createdAt(-60_000);
    await enqueue(old, recent, pending);
    await publish(old, recent);

    const deleted = await purge(10);

    expect(deleted).toEqual({ count: 1, last: old.id });
    expect(await storedIds()).toEqual([pending.id, recent.id].sort());
  });

  test('deletes at most one batch at a time', async () => {
    const old = [createdAt(-3000), createdAt(-2000), createdAt(-1000)];
    await enqueue(...old);
    await publish(...old);

    const batches = [await purge(2), await purge(2), await purge(2)];

    expect(batches.map((batch) => batch.count)).toEqual([2, 1, 0]);
    expect(await storedIds()).toEqual([]);
  });

  test('deletes only the events after a given position, oldest first', async () => {
    const events = [createdAt(-3000), createdAt(-2000), createdAt(-1000)];
    await enqueue(...events);
    await publish(...events);

    const deleted = await purge(10, events[0]!.id);

    expect(deleted).toEqual({ count: 2, last: events[2]!.id });
    expect(await storedIds()).toEqual([events[0]!.id]);
    await purge(10);
  });

  test('lets concurrent publishers claim disjoint batches', async () => {
    const messages = [-4, -3, -2, -1].map((minutes) =>
      eventMessage(minutesFromNow(minutes)),
    );
    await enqueue(...messages);
    const firstClaimed = gate();
    const release = gate();

    const first = harness.unitOfWork.run(async ({ outbox }) => {
      const batch = await outbox.claimDueBatch(NOW, 2);
      firstClaimed.open();
      await release.opened;
      return batch;
    });
    await firstClaimed.opened;
    const second = await claim(2);
    release.open();
    const firstBatch = await first;

    expect(firstBatch.map((message) => message.id)).toEqual([
      messages[0]!.id,
      messages[1]!.id,
    ]);
    expect(second.map((message) => message.id)).toEqual([
      messages[2]!.id,
      messages[3]!.id,
    ]);
  });
});
