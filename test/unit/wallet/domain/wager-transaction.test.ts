import { describe, expect, test } from 'bun:test';
import {
  AT,
  HASH,
  LATER,
  brl,
  pendingTransaction,
  storedTransaction,
  transactionProps,
} from '@test/support/wallet-fixtures';
import { LedgerDirection } from '@wallet/domain/ledger/ledger-direction';
import { FailureCode } from '@wallet/domain/transaction/failure-code';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@wallet/domain/transaction/wager-transaction';

const { Bet, Win, Loss, Refund, Rollback, Opening } = WagerTransactionKind;

function codeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('WagerTransaction.create', () => {
  test('is born PENDING with the submitted fields', () => {
    const transaction = pendingTransaction(Bet, brl('25.00'), { id: 'tx-a' });

    expect(transaction.id).toBe('tx-a');
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.kind).toBe(Bet);
    expect(transaction.money.toString()).toBe('25.00');
    expect(transaction.referenceAttempts).toBe(0);
    expect(transaction.isTerminal()).toBe(false);
  });

  test('refuses the internal OPENING kind', () => {
    const props = transactionProps(Bet, brl('1.00'));

    expect(
      codeOf(() =>
        WagerTransaction.create({
          ...props,
          kind: Opening as unknown as typeof Bet,
        }),
      ),
    ).toBe('UNSUPPORTED_KIND');
  });

  test.each([Refund, Rollback] as const)(
    'requires a reference for %p',
    (kind) => {
      expect(codeOf(() => pendingTransaction(kind, brl('1.00')))).toBe(
        'REFERENCE_REQUIRED',
      );
    },
  );

  test('refuses a reference on a BET', () => {
    expect(
      codeOf(() =>
        pendingTransaction(Bet, brl('1.00'), {
          referenceExternalTransactionId: 'ext-0',
        }),
      ),
    ).toBe('REFERENCE_NOT_ALLOWED');
  });

  test.each([Win, Loss] as const)(
    'accepts an optional reference on %p',
    (kind) => {
      const transaction = pendingTransaction(kind, brl('1.00'), {
        referenceExternalTransactionId: 'ext-0',
      });

      expect(transaction.referenceExternalTransactionId).toBe('ext-0');
    },
  );

  test.each([Bet, Win, Refund, Rollback] as const)(
    'refuses a zero amount on %p',
    (kind) => {
      const reference =
        kind === Refund || kind === Rollback
          ? { referenceExternalTransactionId: 'ext-0' }
          : {};

      expect(
        codeOf(() => pendingTransaction(kind, brl('0.00'), reference)),
      ).toBe('INVALID_AMOUNT');
    },
  );

  test('accepts a zero amount on LOSS', () => {
    expect(pendingTransaction(Loss, brl('0.00')).money.isZero()).toBe(true);
  });

  test('throws an InvalidWagerTransactionError', () => {
    expect(() => pendingTransaction(Refund, brl('1.00'))).toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe('WagerTransaction.opening', () => {
  test('builds the internal opening credit with reserved identifiers', () => {
    const opening = WagerTransaction.opening({
      id: 'opening-tx',
      walletId: 'wallet-9',
      playerId: 'player-9',
      money: brl('1000.00'),
      payloadHash: HASH,
      correlationId: 'correlation-9',
      createdAt: AT,
    });

    expect(opening.kind).toBe(Opening);
    expect(opening.status).toBe(WagerTransactionStatus.Pending);
    expect(opening.providerId).toBe('internal');
    expect(opening.externalTransactionId).toBe('opening:wallet-9');
    expect(opening.idempotencyKey).toBe('opening:wallet-9');
    expect(opening.roundId).toBe('opening');
    expect(opening.gameId).toBe('internal');
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe('WagerTransaction transitions', () => {
  test('PENDING to PROCESSED records the outcome', () => {
    const transaction = pendingTransaction(Bet, brl('25.00'));

    transaction.markProcessed(undefined, brl('75.00'), LATER);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.processedAt).toEqual(LATER);
    expect(transaction.resultBalance?.toString()).toBe('75.00');
    expect(transaction.isTerminal()).toBe(true);
  });

  test('PENDING to REJECTED records the failure code and the observed balance', () => {
    const transaction = pendingTransaction(Bet, brl('80.00'));

    transaction.reject(FailureCode.InsufficientFunds, brl('20.00'), LATER);

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(transaction.resultBalance?.toString()).toBe('20.00');
    expect(transaction.processedAt).toBeUndefined();
  });

  test('PENDING to FAILED records the failure code', () => {
    const transaction = pendingTransaction(Bet, brl('1.00'));

    transaction.fail(FailureCode.ProcessingFailed, LATER);

    expect(transaction.status).toBe(WagerTransactionStatus.Failed);
    expect(transaction.failureCode).toBe(FailureCode.ProcessingFailed);
  });

  test('PENDING to PENDING_REFERENCE schedules the first reference check', () => {
    const transaction = pendingTransaction(Refund, brl('25.00'), {
      referenceExternalTransactionId: 'ext-0',
    });

    transaction.markPendingReference(brl('100.00'), LATER, AT);

    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(transaction.nextReferenceAttemptAt).toEqual(LATER);
    expect(transaction.referenceAttempts).toBe(0);
    expect(transaction.resultBalance?.toString()).toBe('100.00');
    expect(transaction.isTerminal()).toBe(false);
  });

  test('a pending reference retry increments the attempts without changing the status', () => {
    const transaction = pendingTransaction(Refund, brl('25.00'), {
      referenceExternalTransactionId: 'ext-0',
    });
    transaction.markPendingReference(brl('100.00'), LATER, AT);
    const nextTry = new Date('2026-10-02T12:10:00.000Z');

    transaction.scheduleReferenceRetry(nextTry, LATER);

    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(transaction.referenceAttempts).toBe(1);
    expect(transaction.nextReferenceAttemptAt).toEqual(nextTry);
  });

  test('PENDING_REFERENCE can still be processed, rejected or failed, and clears the schedule', () => {
    const outcomes: Array<(transaction: WagerTransaction) => void> = [
      (transaction) =>
        transaction.markProcessed('stored-1', brl('125.00'), LATER),
      (transaction) =>
        transaction.reject(FailureCode.ReferenceNotFound, brl('100.00'), LATER),
      (transaction) => transaction.fail(FailureCode.ProcessingFailed, LATER),
    ];

    for (const finish of outcomes) {
      const transaction = pendingTransaction(Refund, brl('25.00'), {
        referenceExternalTransactionId: 'ext-0',
      });
      transaction.markPendingReference(brl('100.00'), LATER, AT);

      finish(transaction);

      expect(transaction.isTerminal()).toBe(true);
      expect(transaction.nextReferenceAttemptAt).toBeUndefined();
    }
  });

  test('records the resolved reference when processed', () => {
    const transaction = pendingTransaction(Refund, brl('25.00'), {
      referenceExternalTransactionId: 'ext-0',
    });

    transaction.markProcessed('stored-1', brl('125.00'), LATER);

    expect(transaction.referenceTransactionId).toBe('stored-1');
  });

  test('refuses a retry schedule on a transaction that is not waiting for its reference', () => {
    const transaction = pendingTransaction(Bet, brl('1.00'));

    expect(() => transaction.scheduleReferenceRetry(LATER, LATER)).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('refuses to mark a waiting transaction as pending again', () => {
    const transaction = pendingTransaction(Refund, brl('25.00'), {
      referenceExternalTransactionId: 'ext-0',
    });
    transaction.markPendingReference(brl('100.00'), LATER, AT);

    expect(() =>
      transaction.markPendingReference(brl('100.00'), LATER, AT),
    ).toThrow(InvalidTransactionStateError);
  });

  test.each([
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ])('refuses every transition out of the terminal status %p', (status) => {
    const transaction = storedTransaction(Bet, brl('1.00'), {
      status,
      failureCode: FailureCode.InsufficientFunds,
    });
    const attempts = [
      () => transaction.markProcessed(undefined, brl('1.00'), LATER),
      () =>
        transaction.reject(FailureCode.InsufficientFunds, brl('1.00'), LATER),
      () => transaction.fail(FailureCode.ProcessingFailed, LATER),
      () => transaction.markPendingReference(brl('1.00'), LATER, LATER),
      () => transaction.scheduleReferenceRetry(LATER, LATER),
    ];

    for (const attempt of attempts) {
      expect(attempt).toThrow(InvalidTransactionStateError);
    }
    expect(transaction.status).toBe(status);
  });
});

describe('WagerTransaction queries', () => {
  test('only LOSS has no balance effect', () => {
    expect(pendingTransaction(Loss, brl('0.00')).affectsBalance()).toBe(false);
    expect(pendingTransaction(Bet, brl('1.00')).affectsBalance()).toBe(true);
    expect(pendingTransaction(Win, brl('1.00')).affectsBalance()).toBe(true);
  });

  test('only REFUND and ROLLBACK require a reference', () => {
    const withReference = { referenceExternalTransactionId: 'ext-0' };

    expect(
      pendingTransaction(
        Refund,
        brl('1.00'),
        withReference,
      ).requiresReference(),
    ).toBe(true);
    expect(
      pendingTransaction(
        Rollback,
        brl('1.00'),
        withReference,
      ).requiresReference(),
    ).toBe(true);
    expect(
      pendingTransaction(Win, brl('1.00'), withReference).requiresReference(),
    ).toBe(false);
    expect(pendingTransaction(Bet, brl('1.00')).requiresReference()).toBe(
      false,
    );
  });

  test('matches its own payload hash only', () => {
    const transaction = pendingTransaction(Bet, brl('1.00'));

    expect(transaction.matchesPayload(HASH)).toBe(true);
    expect(transaction.matchesPayload('b'.repeat(64))).toBe(false);
  });

  test.each([
    [Bet, LedgerDirection.Debit],
    [Win, LedgerDirection.Credit],
  ] as const)('%p moves the ledger in the %p direction', (kind, direction) => {
    expect(pendingTransaction(kind, brl('1.00')).ledgerDirectionFor()).toBe(
      direction,
    );
  });

  test('REFUND credits the bet back', () => {
    const refund = pendingTransaction(Refund, brl('1.00'), {
      referenceExternalTransactionId: 'ext-0',
    });

    expect(refund.ledgerDirectionFor(storedTransaction(Bet, brl('1.00')))).toBe(
      LedgerDirection.Credit,
    );
  });

  test.each([
    [Bet, LedgerDirection.Credit],
    [Win, LedgerDirection.Debit],
    [Refund, LedgerDirection.Debit],
  ])(
    'ROLLBACK of a %p moves the ledger in the %p direction',
    (referenceKind, direction) => {
      const rollback = pendingTransaction(Rollback, brl('1.00'), {
        referenceExternalTransactionId: 'ext-0',
      });

      expect(
        rollback.ledgerDirectionFor(
          storedTransaction(referenceKind, brl('1.00')),
        ),
      ).toBe(direction);
    },
  );

  test('LOSS has no ledger direction', () => {
    expect(() =>
      pendingTransaction(Loss, brl('0.00')).ledgerDirectionFor(),
    ).toThrow(InvalidWagerTransactionError);
  });

  test('ROLLBACK needs the reference to know its direction', () => {
    const rollback = pendingTransaction(Rollback, brl('1.00'), {
      referenceExternalTransactionId: 'ext-0',
    });

    expect(() => rollback.ledgerDirectionFor()).toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe('WagerTransaction.rehydrate', () => {
  test('restores any stored state without validating transitions', () => {
    const stored = storedTransaction(Bet, brl('25.00'), {
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      processedAt: undefined,
    });

    expect(stored.status).toBe(WagerTransactionStatus.Rejected);
    expect(stored.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(stored.toState().kind).toBe(Bet);
  });
});
