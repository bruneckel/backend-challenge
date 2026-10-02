import type { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import { LedgerDirection } from '@wallet/domain/ledger/ledger-direction';
import type { WalletLedgerEntry } from '@wallet/domain/ledger/wallet-ledger-entry';
import { FailureCode } from '@wallet/domain/transaction/failure-code';
import {
  InvalidTransactionStateError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@wallet/domain/transaction/wager-transaction';
import type { Wallet } from '@wallet/domain/wallet/wallet';

export interface SettlementPolicyOptions {
  maxReferenceAttempts: number;
  referenceBackoff: ExponentialBackoff;
}

export interface SettlementInput {
  transaction: WagerTransaction;
  wallet: Wallet;
  reference: WagerTransaction | null;
  referenceAlreadyReversed: boolean;
  ledgerEntryId: string;
  at: Date;
}

export type SettlementOutcome =
  | { type: 'processed'; ledgerEntry: WalletLedgerEntry | null }
  | { type: 'rejected'; failureCode: FailureCode }
  | { type: 'pending_reference'; firstTime: boolean };

const REFERENCEABLE_KINDS: Record<
  WagerTransactionKind,
  readonly WagerTransactionKind[]
> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

export class SettlementPolicy {
  constructor(private readonly options: SettlementPolicyOptions) {
    if (
      !Number.isInteger(options.maxReferenceAttempts) ||
      options.maxReferenceAttempts < 1
    ) {
      throw new RangeError('maxReferenceAttempts must be a positive integer');
    }
  }

  settle(input: SettlementInput): SettlementOutcome {
    const { transaction, wallet } = input;
    if (transaction.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Transaction ${transaction.id} is already ${transaction.status}`,
      );
    }
    if (transaction.playerId !== wallet.playerId) {
      return this.reject(input, FailureCode.WalletPlayerMismatch);
    }
    if (transaction.money.currency !== wallet.currency) {
      return this.reject(input, FailureCode.CurrencyMismatch);
    }
    if (transaction.referenceExternalTransactionId === undefined) {
      return this.apply(input, undefined);
    }
    const resolution = this.resolveReference(input);
    return resolution instanceof WagerTransaction
      ? this.apply(input, resolution)
      : resolution;
  }

  private resolveReference(
    input: SettlementInput,
  ): SettlementOutcome | WagerTransaction {
    const { transaction, reference } = input;
    if (reference === null) {
      return this.waitForReference(input, FailureCode.ReferenceNotFound);
    }
    if (!this.sharesContext(transaction, reference)) {
      return this.reject(input, FailureCode.ReferenceMismatch);
    }
    if (!REFERENCEABLE_KINDS[transaction.kind].includes(reference.kind)) {
      return this.reject(input, FailureCode.InvalidReferenceKind);
    }
    if (
      transaction.requiresReference() &&
      !transaction.money.equals(reference.money)
    ) {
      return this.reject(input, FailureCode.ReferenceAmountMismatch);
    }
    if (!reference.isTerminal()) {
      return this.waitForReference(input, FailureCode.ReferenceNotProcessed);
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return this.reject(input, FailureCode.ReferenceNotProcessed);
    }
    if (transaction.requiresReference() && input.referenceAlreadyReversed) {
      return this.reject(input, FailureCode.ReferenceAlreadyReversed);
    }
    return reference;
  }

  private sharesContext(
    transaction: WagerTransaction,
    reference: WagerTransaction,
  ): boolean {
    return (
      reference.providerId === transaction.providerId &&
      reference.playerId === transaction.playerId &&
      reference.walletId === transaction.walletId &&
      reference.roundId === transaction.roundId &&
      reference.money.currency === transaction.money.currency
    );
  }

  private waitForReference(
    input: SettlementInput,
    exhaustedCode: FailureCode,
  ): SettlementOutcome {
    const { transaction, wallet, at } = input;
    const { maxReferenceAttempts, referenceBackoff } = this.options;
    if (transaction.status === WagerTransactionStatus.Pending) {
      transaction.markPendingReference(
        wallet.balance,
        referenceBackoff.nextAttemptAt(at, 1),
        at,
      );
      return { type: 'pending_reference', firstTime: true };
    }
    const attempt = transaction.referenceAttempts + 1;
    if (attempt >= maxReferenceAttempts) {
      return this.reject(input, exhaustedCode);
    }
    transaction.scheduleReferenceRetry(
      referenceBackoff.nextAttemptAt(at, attempt + 1),
      at,
    );
    return { type: 'pending_reference', firstTime: false };
  }

  private apply(
    input: SettlementInput,
    reference: WagerTransaction | undefined,
  ): SettlementOutcome {
    const { transaction, wallet, at } = input;
    if (!transaction.affectsBalance()) {
      transaction.markProcessed(reference?.id, wallet.balance, at);
      return { type: 'processed', ledgerEntry: null };
    }
    const direction = transaction.ledgerDirectionFor(reference);
    if (
      direction === LedgerDirection.Debit &&
      !wallet.canDebit(transaction.money)
    ) {
      const failureCode =
        transaction.kind === WagerTransactionKind.Rollback
          ? FailureCode.ReversalInsufficientFunds
          : FailureCode.InsufficientFunds;
      return this.reject(input, failureCode);
    }
    const movement = {
      transactionId: transaction.id,
      entryId: input.ledgerEntryId,
      at,
    };
    const ledgerEntry =
      direction === LedgerDirection.Debit
        ? wallet.debit(transaction.money, movement)
        : wallet.credit(transaction.money, movement);
    transaction.markProcessed(reference?.id, wallet.balance, at);
    return { type: 'processed', ledgerEntry };
  }

  private reject(
    input: SettlementInput,
    failureCode: FailureCode,
  ): SettlementOutcome {
    input.transaction.reject(failureCode, input.wallet.balance, input.at);
    return { type: 'rejected', failureCode };
  }
}
