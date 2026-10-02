import { describe, expect, test } from 'bun:test';
import { AT, brl, usd } from '@test/support/wallet-fixtures';
import { LedgerDirection } from '@wallet/domain/ledger/ledger-direction';
import {
  InvalidLedgerEntryError,
  WalletLedgerEntry,
  type CreateLedgerEntryProps,
} from '@wallet/domain/ledger/wallet-ledger-entry';
import { CurrencyMismatchError } from '@wallet/domain/money/money';

const entryProps = (
  overrides: Partial<CreateLedgerEntryProps> = {},
): CreateLedgerEntryProps => ({
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  walletVersion: 2,
  direction: LedgerDirection.Debit,
  money: brl('80.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('20.00'),
  createdAt: AT,
  ...overrides,
});

describe('WalletLedgerEntry.create', () => {
  test('accepts a debit whose arithmetic adds up', () => {
    const entry = WalletLedgerEntry.create(entryProps());

    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toString()).toBe('20.00');
  });

  test('accepts a credit whose arithmetic adds up', () => {
    const entry = WalletLedgerEntry.create(
      entryProps({
        direction: LedgerDirection.Credit,
        balanceAfter: brl('180.00'),
      }),
    );

    expect(entry.isBalanced()).toBe(true);
  });

  test('rejects arithmetic that does not add up', () => {
    expect(() =>
      WalletLedgerEntry.create(entryProps({ balanceAfter: brl('21.00') })),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create(
        entryProps({
          direction: LedgerDirection.Credit,
          balanceAfter: brl('20.00'),
        }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects a zero amount', () => {
    expect(() =>
      WalletLedgerEntry.create(
        entryProps({ money: brl('0.00'), balanceAfter: brl('100.00') }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects a negative balance after the movement', () => {
    expect(() =>
      WalletLedgerEntry.create(
        entryProps({
          balanceBefore: brl('10.00'),
          balanceAfter: brl('10.00').subtract(brl('80.00')),
        }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects mixed currencies', () => {
    expect(() =>
      WalletLedgerEntry.create(entryProps({ money: usd('80.00') })),
    ).toThrow(CurrencyMismatchError);
  });

  test.each([0, -1, 1.5])('rejects the wallet version %p', (walletVersion) => {
    expect(() =>
      WalletLedgerEntry.create(entryProps({ walletVersion })),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('is frozen and keeps its own copy of the creation date', () => {
    const createdAt = new Date(AT);
    const entry = WalletLedgerEntry.create(entryProps({ createdAt }));
    createdAt.setFullYear(2000);

    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry.createdAt.toISOString()).toBe(AT.toISOString());
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('rebuilds stored state without validating it, so corruption stays detectable', () => {
    const corrupted = WalletLedgerEntry.rehydrate(
      entryProps({ balanceAfter: brl('25.00') }),
    );

    expect(corrupted.isBalanced()).toBe(false);
  });
});
