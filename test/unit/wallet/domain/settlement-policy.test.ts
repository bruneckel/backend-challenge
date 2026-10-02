import { describe, expect, test } from 'bun:test';
import { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import {
  AT,
  LATER,
  brl,
  pendingTransaction,
  storedTransaction,
  usd,
  walletWith,
} from '@test/support/wallet-fixtures';
import { LedgerDirection } from '@wallet/domain/ledger/ledger-direction';
import {
  SettlementPolicy,
  type SettlementOutcome,
} from '@wallet/domain/settlement/settlement-policy';
import { FailureCode } from '@wallet/domain/transaction/failure-code';
import {
  InvalidTransactionStateError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@wallet/domain/transaction/wager-transaction';
import type { Wallet } from '@wallet/domain/wallet/wallet';

const { Bet, Win, Loss, Refund, Rollback, Opening } = WagerTransactionKind;

const policy = new SettlementPolicy({
  maxReferenceAttempts: 3,
  referenceBackoff: ExponentialBackoff.create({
    baseMs: 2_000,
    maxMs: 120_000,
    random: () => 1,
  }),
});

function settle(
  transaction: WagerTransaction,
  options: {
    wallet?: Wallet;
    reference?: WagerTransaction;
    alreadyReversed?: boolean;
  } = {},
): {
  outcome: SettlementOutcome;
  wallet: Wallet;
  transaction: WagerTransaction;
} {
  const wallet = options.wallet ?? walletWith('100.00');
  const outcome = policy.settle({
    transaction,
    wallet,
    reference: options.reference ?? null,
    referenceAlreadyReversed: options.alreadyReversed ?? false,
    ledgerEntryId: 'entry-1',
    at: LATER,
  });
  return { outcome, wallet, transaction };
}

const referencing = (
  kind: typeof Refund | typeof Rollback | typeof Win | typeof Loss,
  amount: string,
) =>
  pendingTransaction(kind, brl(amount), {
    referenceExternalTransactionId: 'stored-ext',
  });

function waitingRefund(attempts: number): WagerTransaction {
  return storedTransaction(Refund, brl('25.00'), {
    status: WagerTransactionStatus.PendingReference,
    referenceExternalTransactionId: 'stored-ext',
    referenceAttempts: attempts,
    nextReferenceAttemptAt: AT,
    processedAt: undefined,
  });
}

describe('SettlementPolicy for BET, WIN and LOSS', () => {
  test('BET within the balance is processed with one debit', () => {
    const { outcome, wallet, transaction } = settle(
      pendingTransaction(Bet, brl('25.00')),
    );

    expect(outcome.type).toBe('processed');
    expect(outcome.type === 'processed' && outcome.ledgerEntry?.direction).toBe(
      LedgerDirection.Debit,
    );
    expect(wallet.balance.toString()).toBe('75.00');
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.resultBalance?.toString()).toBe('75.00');
    expect(transaction.processedAt).toEqual(LATER);
  });

  test('BET of the whole balance is processed and leaves zero', () => {
    const { outcome, wallet } = settle(pendingTransaction(Bet, brl('100.00')));

    expect(outcome.type).toBe('processed');
    expect(wallet.balance.toString()).toBe('0.00');
  });

  test('BET above the balance is rejected with INSUFFICIENT_FUNDS and touches nothing', () => {
    const { outcome, wallet, transaction } = settle(
      pendingTransaction(Bet, brl('80.00')),
      {
        wallet: walletWith('20.00'),
      },
    );

    expect(outcome).toEqual({
      type: 'rejected',
      failureCode: FailureCode.InsufficientFunds,
    });
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(1);
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.resultBalance?.toString()).toBe('20.00');
  });

  test('WIN without a reference is processed with one credit', () => {
    const { outcome, wallet } = settle(pendingTransaction(Win, brl('50.00')));

    expect(outcome.type === 'processed' && outcome.ledgerEntry?.direction).toBe(
      LedgerDirection.Credit,
    );
    expect(wallet.balance.toString()).toBe('150.00');
  });

  test('LOSS is processed without a ledger entry and without changing the wallet', () => {
    const { outcome, wallet, transaction } = settle(
      pendingTransaction(Loss, brl('0.00')),
    );

    expect(outcome).toEqual({ type: 'processed', ledgerEntry: null });
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(transaction.resultBalance?.toString()).toBe('100.00');
  });

  test('WIN referencing the BET of the same round is processed', () => {
    const bet = storedTransaction(Bet, brl('25.00'));

    const { outcome, wallet, transaction } = settle(referencing(Win, '60.00'), {
      reference: bet,
    });

    expect(outcome.type).toBe('processed');
    expect(wallet.balance.toString()).toBe('160.00');
    expect(transaction.referenceTransactionId).toBe(bet.id);
  });

  test('LOSS referencing the BET of the same round is processed without an entry', () => {
    const { outcome } = settle(referencing(Loss, '0.00'), {
      reference: storedTransaction(Bet, brl('25.00')),
    });

    expect(outcome).toEqual({ type: 'processed', ledgerEntry: null });
  });

  test('WIN referencing something other than a BET is rejected', () => {
    const { outcome } = settle(referencing(Win, '60.00'), {
      reference: storedTransaction(Win, brl('25.00')),
    });

    expect(outcome).toEqual({
      type: 'rejected',
      failureCode: FailureCode.InvalidReferenceKind,
    });
  });
});

describe('SettlementPolicy ownership and currency checks', () => {
  test('rejects a player that does not own the wallet', () => {
    const { outcome } = settle(
      pendingTransaction(Bet, brl('1.00'), { playerId: 'player-2' }),
    );

    expect(outcome).toEqual({
      type: 'rejected',
      failureCode: FailureCode.WalletPlayerMismatch,
    });
  });

  test('rejects a currency different from the wallet currency', () => {
    const { outcome, transaction } = settle(
      pendingTransaction(Bet, usd('1.00')),
    );

    expect(outcome).toEqual({
      type: 'rejected',
      failureCode: FailureCode.CurrencyMismatch,
    });
    expect(transaction.resultBalance?.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
  });

  test('checks the player before the currency', () => {
    const { outcome } = settle(
      pendingTransaction(Bet, usd('1.00'), { playerId: 'player-2' }),
    );

    expect(outcome).toEqual({
      type: 'rejected',
      failureCode: FailureCode.WalletPlayerMismatch,
    });
  });
});

describe('SettlementPolicy for REFUND', () => {
  test('credits back a processed BET of the same round and amount', () => {
    const bet = storedTransaction(Bet, brl('25.00'));

    const { outcome, wallet, transaction } = settle(
      referencing(Refund, '25.00'),
      { reference: bet },
    );

    expect(outcome.type === 'processed' && outcome.ledgerEntry?.direction).toBe(
      LedgerDirection.Credit,
    );
    expect(wallet.balance.toString()).toBe('125.00');
    expect(transaction.referenceTransactionId).toBe(bet.id);
  });

  test('waits for a missing reference and schedules the first check', () => {
    const { outcome, wallet, transaction } = settle(
      referencing(Refund, '25.00'),
    );

    expect(outcome).toEqual({ type: 'pending_reference', firstTime: true });
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(transaction.nextReferenceAttemptAt).toEqual(
      new Date(LATER.getTime() + 2_000),
    );
    expect(transaction.resultBalance?.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('keeps waiting while attempts remain and backs off', () => {
    const { outcome, transaction } = settle(waitingRefund(0));

    expect(outcome).toEqual({ type: 'pending_reference', firstTime: false });
    expect(transaction.referenceAttempts).toBe(1);
    expect(transaction.nextReferenceAttemptAt).toEqual(
      new Date(LATER.getTime() + 4_000),
    );
  });

  test('gives up with REFERENCE_NOT_FOUND when the attempts run out', () => {
    const { outcome, transaction } = settle(waitingRefund(2));

    expect(outcome).toEqual({
      type: 'rejected',
      failureCode: FailureCode.ReferenceNotFound,
    });
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
  });

  test('processes a waiting REFUND once its BET arrives', () => {
    const bet = storedTransaction(Bet, brl('25.00'));

    const { outcome, wallet } = settle(waitingRefund(1), { reference: bet });

    expect(outcome.type).toBe('processed');
    expect(wallet.balance.toString()).toBe('125.00');
  });

  test('rejects a reference that is not a BET', () => {
    const { outcome } = settle(referencing(Refund, '25.00'), {
      reference: storedTransaction(Win, brl('25.00')),
    });

    expect(outcome).toEqual({
      type: 'rejected',
      failureCode: FailureCode.InvalidReferenceKind,
    });
  });

  test('rejects a different amount', () => {
    const { outcome } = settle(referencing(Refund, '20.00'), {
      reference: storedTransaction(Bet, brl('25.00')),
    });

    expect(outcome).toEqual({
      type: 'rejected',
      failureCode: FailureCode.ReferenceAmountMismatch,
    });
  });

  test.each([
    ['round', { roundId: 'round-2' }],
    ['wallet', { walletId: 'wallet-2' }],
    ['player', { playerId: 'player-2' }],
    ['provider', { providerId: 'provider-b' }],
  ])('rejects a reference from another %s', (_, difference) => {
    const { outcome } = settle(referencing(Refund, '25.00'), {
      reference: storedTransaction(Bet, brl('25.00'), difference),
    });

    expect(outcome).toEqual({
      type: 'rejected',
      failureCode: FailureCode.ReferenceMismatch,
    });
  });

  test('rejects a reference in another currency', () => {
    const { outcome } = settle(referencing(Refund, '25.00'), {
      reference: storedTransaction(Bet, usd('25.00')),
    });

    expect(outcome).toEqual({
      type: 'rejected',
      failureCode: FailureCode.ReferenceMismatch,
    });
  });

  test.each([WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed])(
    'rejects a reference that ended %p',
    (status) => {
      const { outcome } = settle(referencing(Refund, '25.00'), {
        reference: storedTransaction(Bet, brl('25.00'), {
          status,
          failureCode: FailureCode.InsufficientFunds,
        }),
      });

      expect(outcome).toEqual({
        type: 'rejected',
        failureCode: FailureCode.ReferenceNotProcessed,
      });
    },
  );

  test('rejects a second REFUND of the same BET', () => {
    const { outcome, wallet } = settle(referencing(Refund, '25.00'), {
      reference: storedTransaction(Bet, brl('25.00')),
      alreadyReversed: true,
    });

    expect(outcome).toEqual({
      type: 'rejected',
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
    expect(wallet.balance.toString()).toBe('100.00');
  });
});

describe('SettlementPolicy for ROLLBACK', () => {
  test('of a BET credits the stake back', () => {
    const { outcome, wallet } = settle(referencing(Rollback, '25.00'), {
      reference: storedTransaction(Bet, brl('25.00')),
    });

    expect(outcome.type === 'processed' && outcome.ledgerEntry?.direction).toBe(
      LedgerDirection.Credit,
    );
    expect(wallet.balance.toString()).toBe('125.00');
  });

  test('of a WIN debits the prize back', () => {
    const { outcome, wallet } = settle(referencing(Rollback, '25.00'), {
      reference: storedTransaction(Win, brl('25.00')),
    });

    expect(outcome.type === 'processed' && outcome.ledgerEntry?.direction).toBe(
      LedgerDirection.Debit,
    );
    expect(wallet.balance.toString()).toBe('75.00');
  });

  test('of a REFUND debits the refund back', () => {
    const { outcome, wallet } = settle(referencing(Rollback, '25.00'), {
      reference: storedTransaction(Refund, brl('25.00')),
    });

    expect(outcome.type === 'processed' && outcome.ledgerEntry?.direction).toBe(
      LedgerDirection.Debit,
    );
    expect(wallet.balance.toString()).toBe('75.00');
  });

  test('that would make the balance negative is rejected with its own code', () => {
    const { outcome, wallet } = settle(referencing(Rollback, '25.00'), {
      reference: storedTransaction(Win, brl('25.00')),
      wallet: walletWith('10.00'),
    });

    expect(outcome).toEqual({
      type: 'rejected',
      failureCode: FailureCode.ReversalInsufficientFunds,
    });
    expect(FailureCode.ReversalInsufficientFunds).not.toBe(
      FailureCode.InsufficientFunds,
    );
    expect(wallet.balance.toString()).toBe('10.00');
  });

  test.each([Loss, Rollback, Opening])(
    'cannot reverse a %p',
    (referenceKind) => {
      const { outcome } = settle(referencing(Rollback, '25.00'), {
        reference: storedTransaction(referenceKind, brl('25.00')),
      });

      expect(outcome).toEqual({
        type: 'rejected',
        failureCode: FailureCode.InvalidReferenceKind,
      });
    },
  );

  test('rejects a second ROLLBACK of the same reference', () => {
    const { outcome } = settle(referencing(Rollback, '25.00'), {
      reference: storedTransaction(Bet, brl('25.00')),
      alreadyReversed: true,
    });

    expect(outcome).toEqual({
      type: 'rejected',
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
  });
});

describe('SettlementPolicy with a reference that is still waiting itself', () => {
  const waitingReference = () =>
    storedTransaction(Refund, brl('25.00'), {
      status: WagerTransactionStatus.PendingReference,
      processedAt: undefined,
      referenceExternalTransactionId: 'older-ext',
    });

  test('keeps the dependent transaction waiting', () => {
    const { outcome } = settle(referencing(Rollback, '25.00'), {
      reference: waitingReference(),
    });

    expect(outcome).toEqual({ type: 'pending_reference', firstTime: true });
  });

  test('gives up with REFERENCE_NOT_PROCESSED when the attempts run out', () => {
    const rollback = storedTransaction(Rollback, brl('25.00'), {
      status: WagerTransactionStatus.PendingReference,
      referenceExternalTransactionId: 'stored-ext',
      referenceAttempts: 2,
      nextReferenceAttemptAt: AT,
      processedAt: undefined,
    });

    const { outcome } = settle(rollback, { reference: waitingReference() });

    expect(outcome).toEqual({
      type: 'rejected',
      failureCode: FailureCode.ReferenceNotProcessed,
    });
  });
});

describe('SettlementPolicy guards', () => {
  test('refuses to settle a transaction that is already terminal', () => {
    const processed = storedTransaction(Bet, brl('25.00'));

    expect(() => settle(processed)).toThrow(InvalidTransactionStateError);
  });

  test('refuses a configuration without reference attempts', () => {
    expect(
      () =>
        new SettlementPolicy({
          maxReferenceAttempts: 0,
          referenceBackoff: ExponentialBackoff.create({
            baseMs: 1_000,
            maxMs: 2_000,
          }),
        }),
    ).toThrow(RangeError);
  });
});
