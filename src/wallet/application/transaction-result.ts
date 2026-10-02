import type { MoneyProps } from '@wallet/domain/money/money';
import type { FailureCode } from '@wallet/domain/transaction/failure-code';
import type { WagerTransaction, WagerTransactionStatus } from '@wallet/domain/transaction/wager-transaction';

export interface TransactionResult {
  transactionId: string;
  status: `${WagerTransactionStatus}`;
  balance: MoneyProps;
  failureCode?: `${FailureCode}`;
  idempotentReplay: boolean;
}

export function transactionResult(transaction: WagerTransaction, idempotentReplay: boolean): TransactionResult {
  const balance = transaction.resultBalance;
  if (balance === undefined) {
    throw new Error(`Wager transaction ${transaction.id} has no observed balance to report`);
  }
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: balance.toJSON(),
    ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
    idempotentReplay,
  };
}
