import { DomainError } from '@shared/domain/domain-error';
import type { Money } from '@wallet/domain/money/money';
import { LedgerDirection } from './ledger-direction';

export class InvalidLedgerEntryError extends DomainError {
  override readonly code = 'INVALID_LEDGER_ENTRY';
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  walletVersion: number;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly walletVersion: number,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvalidLedgerEntryError(
        'Wallet version must be a positive integer',
      );
    }
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('Ledger amount must be positive');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Ledger balances cannot be negative');
    }
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError('Ledger arithmetic does not add up');
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.walletVersion,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt.getTime()),
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  toState(): LedgerEntryState {
    return {
      id: this.id,
      walletId: this.walletId,
      transactionId: this.transactionId,
      walletVersion: this.walletVersion,
      direction: this.direction,
      money: this.money,
      balanceBefore: this.balanceBefore,
      balanceAfter: this.balanceAfter,
      createdAt: this.createdAt,
    };
  }
}
