import { type InferEntity, defineEntity, p } from '@mikro-orm/core';
import type { LedgerDirection } from '@wallet/domain/ledger/ledger-direction';
import { WalletLedgerEntry } from '@wallet/domain/ledger/wallet-ledger-entry';
import { Money } from '@wallet/domain/money/money';

export const LedgerEntryRecord = defineEntity({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    walletVersion: p.integer(),
    direction: p.text(),
    amount: p.decimal().columnType('numeric'),
    currency: p.text(),
    balanceBefore: p.decimal().columnType('numeric'),
    balanceAfter: p.decimal().columnType('numeric'),
    createdAt: p.datetime().columnType('timestamptz'),
  },
});

export type LedgerEntryRow = InferEntity<typeof LedgerEntryRecord>;

export function toLedgerEntryRow(entry: WalletLedgerEntry): LedgerEntryRow {
  const state = entry.toState();
  return {
    id: state.id,
    walletId: state.walletId,
    transactionId: state.transactionId,
    walletVersion: state.walletVersion,
    direction: state.direction,
    amount: state.money.toJSON().amount,
    currency: state.money.currency,
    balanceBefore: state.balanceBefore.toJSON().amount,
    balanceAfter: state.balanceAfter.toJSON().amount,
    createdAt: state.createdAt,
  };
}

export function toLedgerEntry(row: LedgerEntryRow): WalletLedgerEntry {
  const money = (amount: string) =>
    Money.from({ amount, currency: row.currency });
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    walletVersion: row.walletVersion,
    direction: row.direction as LedgerDirection,
    money: money(row.amount),
    balanceBefore: money(row.balanceBefore),
    balanceAfter: money(row.balanceAfter),
    createdAt: row.createdAt,
  });
}
