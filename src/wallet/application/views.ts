import type { LedgerDirection } from '@wallet/domain/ledger/ledger-direction';
import type { WalletLedgerEntry } from '@wallet/domain/ledger/wallet-ledger-entry';
import type { MoneyProps } from '@wallet/domain/money/money';
import type { FailureCode } from '@wallet/domain/transaction/failure-code';
import type {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@wallet/domain/transaction/wager-transaction';
import type { Wallet } from '@wallet/domain/wallet/wallet';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: `${LedgerDirection}`;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: Date;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  nextBeforeVersion: number | null;
}

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: `${WagerTransactionKind}`;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: `${WagerTransactionStatus}`;
  failureCode?: `${FailureCode}`;
  balance?: MoneyProps;
  createdAt: Date;
  processedAt?: Date;
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function toLedgerEntryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt,
  };
}

export function toTransactionView(transaction: WagerTransaction): TransactionView {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    ...optional('referenceExternalTransactionId', transaction.referenceExternalTransactionId),
    ...optional('referenceTransactionId', transaction.referenceTransactionId),
    status: transaction.status,
    ...optional('failureCode', transaction.failureCode),
    ...optional('balance', transaction.resultBalance?.toJSON()),
    createdAt: transaction.createdAt,
    ...optional('processedAt', transaction.processedAt),
  };
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
