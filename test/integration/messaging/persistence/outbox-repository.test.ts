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

function eventMessage(occurredAt: Date): OutboxMessage {
  const opened = openedWallet('100.00');
  const { entry } = settledBet(opened.wallet);
  const event = WalletBalanceChanged.from(opened.wallet, entry, {
    eventId: Bun.randomUUIDv7(),
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
