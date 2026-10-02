import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { InboxMessage, type ReceiveInboxProps } from '@messaging/domain/inbox-message';
import { gate } from '@test/support/async';
import { AT, HASH, LATER, openedWallet, settledBet, storeOpenedWallet } from '@test/support/domain-builders';
import { type PersistenceHarness, createPersistenceHarness, plain } from '@test/support/persistence';

let harness: PersistenceHarness;

beforeAll(async () => {
  harness = await createPersistenceHarness();
});

afterAll(async () => {
  await harness.close();
});

function received(overrides: Partial<ReceiveInboxProps> = {}): InboxMessage {
  return InboxMessage.receive({
    messageId: Bun.randomUUIDv7(),
    consumerName: 'wager-commands',
    payloadHash: HASH,
    receivedAt: AT,
    ...overrides,
  });
}

const record = (message: InboxMessage) => harness.unitOfWork.run(({ inbox }) => inbox.record(message));

describe('MikroOrmInboxRepository', () => {
  test('records a message the first time it arrives', async () => {
    expect(await record(received())).toEqual({ recorded: true });
  });

  test('returns the stored record when the same message id arrives again', async () => {
    const first = received();
    await record(first);

    const result = await record(received({ messageId: first.messageId, payloadHash: 'b'.repeat(64), receivedAt: LATER }));

    expect(result.recorded).toBe(false);
    expect(result.recorded ? undefined : plain(result.existing.toState())).toEqual(plain(first.toState()));
  });

  test('keeps the deliveries of each consumer apart', async () => {
    const first = received();
    await record(first);

    expect(await record(received({ messageId: first.messageId, consumerName: 'audit' }))).toEqual({ recorded: true });
  });

  test('makes a concurrent delivery wait for the first transaction and then see its record', async () => {
    const first = received();
    const recorded = gate();
    const release = gate();
    const order: string[] = [];

    const holder = harness.unitOfWork.run(async ({ inbox }) => {
      await inbox.record(first);
      recorded.open();
      await release.opened;
      order.push('first committing');
    });
    await recorded.opened;
    const second = record(received({ messageId: first.messageId })).then((result) => {
      order.push('second recorded');
      return result;
    });
    await Bun.sleep(100);
    release.open();
    await holder;

    expect((await second).recorded).toBe(false);
    expect(order).toEqual(['first committing', 'second recorded']);
  });

  test('records the message when the first transaction rolls back', async () => {
    const first = received();
    const recorded = gate();
    const release = gate();

    const holder = harness.unitOfWork.run(async ({ inbox }) => {
      await inbox.record(first);
      recorded.open();
      await release.opened;
      throw new Error('processing failed');
    });
    await recorded.opened;
    const second = record(received({ messageId: first.messageId }));
    await Bun.sleep(100);
    release.open();
    await holder.catch(() => undefined);

    expect(await second).toEqual({ recorded: true });
  });

  test('saves when the message was processed and the transaction it produced', async () => {
    const opened = openedWallet('100.00');
    const { bet } = settledBet(opened.wallet);
    const message = received();
    await harness.unitOfWork.run(async (scope) => {
      await storeOpenedWallet(scope, opened);
      await scope.transactions.insert(bet);
      await scope.inbox.record(message);
      message.markProcessed(LATER);
      await scope.inbox.saveProcessed(message, bet.id);
    });

    const [row] = await harness.database.sql`
      select processed_at, transaction_id from inbox_messages where message_id = ${message.messageId}`;
    expect(row).toEqual({ processed_at: LATER, transaction_id: bet.id });
  });
});
