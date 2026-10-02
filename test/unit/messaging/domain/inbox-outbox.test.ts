import { describe, expect, test } from 'bun:test';
import {
  InboxMessage,
  InvalidInboxMessageError,
  InvalidInboxStateError,
} from '@messaging/domain/inbox-message';
import {
  InvalidOutboxStateError,
  OutboxMessage,
} from '@messaging/domain/outbox-message';
import { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import {
  AT,
  HASH,
  LATER,
  brl,
  walletWith,
} from '@test/support/wallet-fixtures';
import { WalletBalanceChanged } from '@wallet/domain/events/wallet-balance-changed';

const backoff = ExponentialBackoff.create({
  baseMs: 1_000,
  maxMs: 300_000,
  random: () => 1,
});

function balanceChangedEvent(): WalletBalanceChanged {
  const wallet = walletWith('100.00');
  const entry = wallet.debit(brl('80.00'), {
    transactionId: 'tx-1',
    entryId: 'entry-1',
    at: AT,
  });
  return WalletBalanceChanged.from(wallet, entry, {
    eventId: 'event-1',
    correlationId: 'correlation-1',
    occurredAt: AT,
  });
}

describe('InboxMessage', () => {
  const received = () =>
    InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-transactions',
      payloadHash: HASH,
      receivedAt: AT,
    });

  test('starts unprocessed and records when it was processed', () => {
    const message = received();
    expect(message.isProcessed()).toBe(false);

    message.markProcessed(LATER);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(LATER);
  });

  test('cannot be processed twice', () => {
    const message = received();
    message.markProcessed(LATER);

    expect(() => message.markProcessed(LATER)).toThrow(InvalidInboxStateError);
  });

  test('tells whether a delivery carries the same payload', () => {
    const message = received();

    expect(message.matches(HASH)).toBe(true);
    expect(message.matches('b'.repeat(64))).toBe(false);
  });

  test.each([
    { messageId: '', consumerName: 'wager-transactions' },
    { messageId: 'msg-1', consumerName: '' },
  ])('refuses an empty identity %p', (identity) => {
    expect(() =>
      InboxMessage.receive({ ...identity, payloadHash: HASH, receivedAt: AT }),
    ).toThrow(InvalidInboxMessageError);
  });

  test('rehydrates a processed message', () => {
    const message = InboxMessage.rehydrate({
      messageId: 'msg-1',
      consumerName: 'wager-transactions',
      payloadHash: HASH,
      receivedAt: AT,
      processedAt: LATER,
    });

    expect(message.isProcessed()).toBe(true);
  });
});

describe('OutboxMessage', () => {
  test('enqueues the serialized envelope of an integration event', () => {
    const event = balanceChangedEvent();

    const message = OutboxMessage.enqueue(event);

    expect(message.id).toBe('event-1');
    expect(message.aggregateId).toBe('wallet-1');
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.eventVersion).toBe(1);
    expect(message.messageGroupId).toBe('wallet-1');
    expect(message.payload as unknown).toEqual(event.toJSON());
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toEqual(AT);
    expect(message.isPending()).toBe(true);
  });

  test('is due once its next attempt time has come', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());

    expect(message.isDue(new Date(AT.getTime() - 1))).toBe(false);
    expect(message.isDue(AT)).toBe(true);
  });

  test('backs off after a failed publication and keeps the reason', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());

    message.scheduleRetry(LATER, backoff, 'SQS timeout');
    message.scheduleRetry(LATER, backoff, 'SQS timeout');

    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt).toEqual(new Date(LATER.getTime() + 2_000));
    expect(message.lastError).toBe('SQS timeout');
    expect(message.isPending()).toBe(true);
  });

  test('truncates a long failure reason', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());

    message.scheduleRetry(LATER, backoff, 'x'.repeat(2_000));

    expect(message.lastError).toHaveLength(500);
  });

  test('stops being pending once published', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());

    message.markPublished(LATER);

    expect(message.publishedAt).toEqual(LATER);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(LATER)).toBe(false);
  });

  test('refuses to publish twice or retry after publishing', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());
    message.markPublished(LATER);

    expect(() => message.markPublished(LATER)).toThrow(InvalidOutboxStateError);
    expect(() => message.scheduleRetry(LATER, backoff, 'late')).toThrow(
      InvalidOutboxStateError,
    );
  });

  test('rehydrates stored state', () => {
    const state = OutboxMessage.enqueue(balanceChangedEvent()).toState();

    expect(OutboxMessage.rehydrate(state).toState()).toEqual(state);
  });
});
