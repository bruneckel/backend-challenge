import { describe, expect, test } from 'bun:test';
import {
  LATER,
  brl,
  pendingTransaction,
  walletWith,
} from '@test/support/wallet-fixtures';
import { WagerTransactionFailed } from '@wallet/domain/events/wager-transaction-failed';
import { WagerTransactionPendingReference } from '@wallet/domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '@wallet/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '@wallet/domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '@wallet/domain/events/wallet-balance-changed';
import { FailureCode } from '@wallet/domain/transaction/failure-code';
import {
  InvalidTransactionStateError,
  WagerTransactionKind,
} from '@wallet/domain/transaction/wager-transaction';

const context = {
  eventId: 'event-1',
  correlationId: 'correlation-1',
  causationId: 'provider-a:ext-1',
  occurredAt: LATER,
};

const serialized = (event: { toJSON(): unknown }) =>
  JSON.parse(JSON.stringify(event));

const bet = () =>
  pendingTransaction(WagerTransactionKind.Bet, brl('25.00'), {
    id: 'tx-1',
    externalTransactionId: 'ext-1',
  });

describe('WalletBalanceChanged', () => {
  test('serializes the ledger movement with money as decimal strings', () => {
    const wallet = walletWith('100.00');
    const entry = wallet.debit(brl('80.00'), {
      transactionId: 'tx-1',
      entryId: 'entry-1',
      at: LATER,
    });

    const event = WalletBalanceChanged.from(wallet, entry, context);

    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.version).toBe(1);
    expect(event.messageGroupId).toBe('wallet-1');
    expect(serialized(event)).toEqual({
      eventId: 'event-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'correlation-1',
      causationId: 'provider-a:ext-1',
      occurredAt: '2026-10-02T12:05:00.000Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: 'DEBIT',
        money: { amount: '80.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '20.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  test('round-trips through JSON as plain data', () => {
    const wallet = walletWith('100.00');
    const entry = wallet.credit(brl('1.00'), {
      transactionId: 'tx-1',
      entryId: 'entry-1',
      at: LATER,
    });

    const event = WalletBalanceChanged.from(wallet, entry, context);

    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });

  test('omits the causation id when there is none', () => {
    const wallet = walletWith('100.00');
    const entry = wallet.credit(brl('1.00'), {
      transactionId: 'tx-1',
      entryId: 'entry-1',
      at: LATER,
    });

    const envelope = WalletBalanceChanged.from(wallet, entry, {
      ...context,
      causationId: undefined,
    }).toJSON();

    expect('causationId' in envelope).toBe(false);
  });
});

describe('WagerTransactionProcessed', () => {
  test('describes the applied transaction and the balance after it', () => {
    const transaction = bet();
    transaction.markProcessed(undefined, brl('75.00'), LATER);

    const event = WagerTransactionProcessed.from(transaction, context);

    expect(event.eventType).toBe('WagerTransactionProcessed');
    expect(event.aggregateId).toBe('tx-1');
    expect(event.messageGroupId).toBe('wallet-1');
    expect(serialized(event).data).toEqual({
      transactionId: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      referenceTransactionId: null,
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      processedAt: '2026-10-02T12:05:00.000Z',
    });
  });

  test('can only describe a processed transaction', () => {
    expect(() => WagerTransactionProcessed.from(bet(), context)).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('WagerTransactionRejected', () => {
  test('carries the failure code and the unchanged balance', () => {
    const transaction = bet();
    transaction.reject(FailureCode.InsufficientFunds, brl('20.00'), LATER);

    const event = WagerTransactionRejected.from(transaction, context);

    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(serialized(event).data).toMatchObject({
      transactionId: 'tx-1',
      kind: 'BET',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '20.00', currency: 'BRL' },
    });
  });

  test('can only describe a rejected transaction', () => {
    expect(() => WagerTransactionRejected.from(bet(), context)).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('WagerTransactionPendingReference', () => {
  test('names the missing reference and the next check', () => {
    const refund = pendingTransaction(
      WagerTransactionKind.Refund,
      brl('25.00'),
      {
        id: 'tx-2',
        referenceExternalTransactionId: 'ext-1',
      },
    );
    refund.markPendingReference(brl('100.00'), LATER, LATER);

    const event = WagerTransactionPendingReference.from(refund, context);

    expect(event.eventType).toBe('WagerTransactionPendingReference');
    expect(serialized(event).data).toMatchObject({
      transactionId: 'tx-2',
      kind: 'REFUND',
      referenceExternalTransactionId: 'ext-1',
      nextAttemptAt: '2026-10-02T12:05:00.000Z',
    });
  });

  test('can only describe a transaction waiting for its reference', () => {
    expect(() => WagerTransactionPendingReference.from(bet(), context)).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('WagerTransactionFailed', () => {
  test('carries the failure code and the balance observed when the transaction was recorded', () => {
    const refund = pendingTransaction(
      WagerTransactionKind.Refund,
      brl('25.00'),
      {
        id: 'tx-3',
        referenceExternalTransactionId: 'ext-1',
      },
    );
    refund.markPendingReference(brl('100.00'), LATER, LATER);
    refund.fail(FailureCode.ProcessingFailed, LATER);

    const event = WagerTransactionFailed.from(refund, context);

    expect(event.eventType).toBe('WagerTransactionFailed');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe('tx-3');
    expect(event.messageGroupId).toBe('wallet-1');
    expect(serialized(event).data).toMatchObject({
      transactionId: 'tx-3',
      walletId: 'wallet-1',
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      failureCode: 'PROCESSING_FAILED',
      balance: { amount: '100.00', currency: 'BRL' },
    });
  });

  test('can only describe a failed transaction', () => {
    expect(() => WagerTransactionFailed.from(bet(), context)).toThrow(
      InvalidTransactionStateError,
    );
  });
});
