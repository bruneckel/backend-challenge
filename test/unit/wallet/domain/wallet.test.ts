import { describe, expect, test } from 'bun:test';
import { AT, LATER, brl, usd, walletWith } from '@test/support/wallet-fixtures';
import { LedgerDirection } from '@wallet/domain/ledger/ledger-direction';
import { CurrencyMismatchError } from '@wallet/domain/money/money';
import {
  BalanceLimitExceededError,
  InsufficientFundsError,
  NegativeInitialBalanceError,
  NonPositiveMovementError,
  Wallet,
} from '@wallet/domain/wallet/wallet';

const openWith = (amount: string) =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(amount),
    openingTransactionId: 'opening-tx',
    openingEntryId: 'opening-entry',
    at: AT,
  });

const movement = { transactionId: 'tx-9', entryId: 'entry-9', at: LATER };

describe('Wallet.open', () => {
  test('opens with a zero balance, version 1 and no ledger entry', () => {
    const { wallet, openingEntry } = openWith('0.00');

    expect(wallet.balance.toString()).toBe('0.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeNull();
  });

  test('opens with a positive balance, version 1 and a matching opening credit', () => {
    const { wallet, openingEntry } = openWith('1000.00');

    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.version).toBe(1);
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.transactionId).toBe('opening-tx');
    expect(openingEntry?.walletVersion).toBe(1);
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('1000.00');
    expect(openingEntry?.isBalanced()).toBe(true);
  });

  test('refuses a negative initial balance', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('1.00').negate(),
        openingTransactionId: 'opening-tx',
        openingEntryId: 'opening-entry',
        at: AT,
      }),
    ).toThrow(NegativeInitialBalanceError);
  });
});

describe('Wallet.debit', () => {
  test('lowers the balance, bumps the version and returns the matching debit entry', () => {
    const wallet = walletWith('100.00');

    const entry = wallet.debit(brl('80.00'), movement);

    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(LATER);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe('tx-9');
    expect(entry.id).toBe('entry-9');
    expect(entry.walletVersion).toBe(2);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('20.00');
  });

  test('allows spending the whole balance', () => {
    const wallet = walletWith('80.00');

    wallet.debit(brl('80.00'), movement);

    expect(wallet.balance.toString()).toBe('0.00');
  });

  test('refuses to go below zero and leaves the wallet untouched', () => {
    const wallet = walletWith('20.00');

    expect(() => wallet.debit(brl('80.00'), movement)).toThrow(
      InsufficientFundsError,
    );
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(AT);
  });
});

describe('Wallet.credit', () => {
  test('raises the balance, bumps the version and returns the matching credit entry', () => {
    const wallet = walletWith('20.00');

    const entry = wallet.credit(brl('80.00'), movement);

    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toString()).toBe('20.00');
    expect(entry.balanceAfter.toString()).toBe('100.00');
  });

  test('tells whether a credit keeps the balance within the storage limit', () => {
    const wallet = walletWith('99999999999999990.00');

    expect(wallet.canCredit(brl('9.99'))).toBe(true);
    expect(wallet.canCredit(brl('10.00'))).toBe(false);
    expect(() => wallet.canCredit(usd('1.00'))).toThrow(CurrencyMismatchError);
  });

  test('refuses a credit past the storage limit and leaves the wallet untouched', () => {
    const wallet = walletWith('99999999999999990.00');

    expect(() => wallet.credit(brl('10.00'), movement)).toThrow(
      BalanceLimitExceededError,
    );
    expect(wallet.balance.toString()).toBe('99999999999999990.00');
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet movement guards', () => {
  test('refuses another currency and leaves the wallet untouched', () => {
    const wallet = walletWith('100.00');

    expect(() => wallet.debit(usd('1.00'), movement)).toThrow(
      CurrencyMismatchError,
    );
    expect(() => wallet.credit(usd('1.00'), movement)).toThrow(
      CurrencyMismatchError,
    );
    expect(wallet.version).toBe(1);
  });

  test('refuses a zero movement', () => {
    const wallet = walletWith('100.00');

    expect(() => wallet.credit(brl('0.00'), movement)).toThrow(
      NonPositiveMovementError,
    );
    expect(() => wallet.debit(brl('0.00'), movement)).toThrow(
      NonPositiveMovementError,
    );
  });

  test('tells whether a debit fits the balance', () => {
    const wallet = walletWith('80.00');

    expect(wallet.canDebit(brl('80.00'))).toBe(true);
    expect(wallet.canDebit(brl('80.01'))).toBe(false);
    expect(() => wallet.canDebit(usd('1.00'))).toThrow(CurrencyMismatchError);
  });
});

describe('Wallet persistence state', () => {
  test('rehydrates stored state and exposes it back unchanged', () => {
    const state = {
      id: 'wallet-7',
      playerId: 'player-7',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: AT,
      updatedAt: LATER,
    };

    const wallet = Wallet.rehydrate(state);

    expect(wallet.toState()).toEqual(state);
  });
});
