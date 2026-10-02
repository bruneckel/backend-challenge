import { type InferEntity, defineEntity, p } from '@mikro-orm/core';
import { Money } from '@wallet/domain/money/money';
import type { FailureCode } from '@wallet/domain/transaction/failure-code';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '@wallet/domain/transaction/wager-transaction';

export const WagerTransactionRecord = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.text(),
    externalTransactionId: p.text(),
    idempotencyKey: p.text(),
    payloadHash: p.text(),
    walletId: p.uuid(),
    playerId: p.uuid(),
    roundId: p.text(),
    gameId: p.text(),
    kind: p.text(),
    amount: p.decimal().columnType('numeric'),
    currency: p.text(),
    referenceExternalTransactionId: p.text().nullable(),
    correlationId: p.text(),
    status: p.text(),
    failureCode: p.text().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    processedAt: p.datetime().columnType('timestamptz').nullable(),
    resultBalanceAmount: p.decimal().columnType('numeric').nullable(),
    resultBalanceCurrency: p.text().nullable(),
    referenceAttempts: p.integer(),
    nextReferenceAttemptAt: p.datetime().columnType('timestamptz').nullable(),
    createdAt: p.datetime().columnType('timestamptz'),
    updatedAt: p.datetime().columnType('timestamptz'),
  },
});

export type WagerTransactionRow = InferEntity<typeof WagerTransactionRecord>;

export type WagerTransactionProgress = Pick<
  WagerTransactionRow,
  | 'status'
  | 'failureCode'
  | 'referenceTransactionId'
  | 'processedAt'
  | 'resultBalanceAmount'
  | 'resultBalanceCurrency'
  | 'referenceAttempts'
  | 'nextReferenceAttemptAt'
  | 'updatedAt'
>;

export function toWagerTransactionProgress(transaction: WagerTransaction): WagerTransactionProgress {
  const resultBalance = transaction.resultBalance?.toJSON();
  return {
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    processedAt: transaction.processedAt ?? null,
    resultBalanceAmount: resultBalance?.amount ?? null,
    resultBalanceCurrency: resultBalance?.currency ?? null,
    referenceAttempts: transaction.referenceAttempts,
    nextReferenceAttemptAt: transaction.nextReferenceAttemptAt ?? null,
    updatedAt: transaction.updatedAt,
  };
}

export function toWagerTransactionRow(transaction: WagerTransaction): WagerTransactionRow {
  const money = transaction.money.toJSON();
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: money.amount,
    currency: money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    correlationId: transaction.correlationId,
    createdAt: transaction.createdAt,
    ...toWagerTransactionProgress(transaction),
  };
}

export function toWagerTransaction(row: WagerTransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as WagerTransactionKind,
    money: Money.from({ amount: row.amount, currency: row.currency }),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    correlationId: row.correlationId,
    createdAt: row.createdAt,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: (row.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: row.processedAt ?? undefined,
    resultBalance:
      row.resultBalanceAmount == null || row.resultBalanceCurrency == null
        ? undefined
        : Money.from({ amount: row.resultBalanceAmount, currency: row.resultBalanceCurrency }),
    referenceAttempts: row.referenceAttempts,
    nextReferenceAttemptAt: row.nextReferenceAttemptAt ?? undefined,
    updatedAt: row.updatedAt,
  });
}
