import { DomainError } from '@shared/domain/domain-error';
import { LedgerDirection } from '@wallet/domain/ledger/ledger-direction';
import { WalletLedgerEntry } from '@wallet/domain/ledger/wallet-ledger-entry';
import { CurrencyMismatchError, Money } from '@wallet/domain/money/money';

export class InsufficientFundsError extends DomainError {
  override readonly code = 'INSUFFICIENT_FUNDS';
}

export class NonPositiveMovementError extends DomainError {
  override readonly code = 'NON_POSITIVE_MOVEMENT';
}

export class NegativeInitialBalanceError extends DomainError {
  override readonly code = 'NEGATIVE_INITIAL_BALANCE';
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

export interface MovementContext {
  transactionId: string;
  entryId: string;
  at: Date;
}

export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry: WalletLedgerEntry | null } {
    const { initialBalance } = props;
    if (initialBalance.isNegative()) {
      throw new NegativeInitialBalanceError('Initial balance cannot be negative');
    }
    const wallet = new Wallet(props.id, props.playerId, initialBalance.currency, initialBalance, 1, props.at, props.at);
    if (initialBalance.isZero()) {
      return { wallet, openingEntry: null };
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      walletVersion: 1,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: props.at,
    });
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(money: Money, context: MovementContext): WalletLedgerEntry {
    this.assertMovement(money);
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError('Balance is not enough for this debit');
    }
    return this.apply(LedgerDirection.Debit, money, this._balance.subtract(money), context);
  }

  credit(money: Money, context: MovementContext): WalletLedgerEntry {
    this.assertMovement(money);
    return this.apply(LedgerDirection.Credit, money, this._balance.add(money), context);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  private apply(
    direction: LedgerDirection,
    money: Money,
    balanceAfter: Money,
    context: MovementContext,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: context.entryId,
      walletId: this.id,
      transactionId: context.transactionId,
      walletVersion: this._version + 1,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: context.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = context.at;
    return entry;
  }

  private assertMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new NonPositiveMovementError('Movement amount must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
