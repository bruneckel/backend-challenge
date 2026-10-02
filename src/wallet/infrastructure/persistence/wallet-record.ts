import { type InferEntity, defineEntity, p } from '@mikro-orm/core';
import { Money } from '@wallet/domain/money/money';
import { Wallet } from '@wallet/domain/wallet/wallet';

export const WalletRecord = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.text(),
    balanceAmount: p.decimal().columnType('numeric'),
    version: p.integer(),
    createdAt: p.datetime().columnType('timestamptz'),
    updatedAt: p.datetime().columnType('timestamptz'),
  },
});

export type WalletRow = InferEntity<typeof WalletRecord>;

export function toWalletRow(wallet: Wallet): WalletRow {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balanceAmount: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: Money.from({ amount: row.balanceAmount, currency: row.currency }),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
