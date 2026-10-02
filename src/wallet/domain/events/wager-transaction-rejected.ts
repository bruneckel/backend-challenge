import {
  IntegrationEvent,
  type EventContext,
  type IntegrationEventProps,
} from '@messaging/domain/integration-event';
import type { MoneyProps } from '@wallet/domain/money/money';
import type { FailureCode } from '@wallet/domain/transaction/failure-code';
import {
  InvalidTransactionStateError,
  WagerTransactionStatus,
  type WagerTransaction,
} from '@wallet/domain/transaction/wager-transaction';
import {
  transactionEventData,
  type TransactionEventData,
} from './transaction-event-data';

export interface WagerTransactionRejectedData extends TransactionEventData {
  failureCode: FailureCode;
  balance: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  override readonly eventType = 'WagerTransactionRejected';
  override readonly version = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionRejectedData>,
  ) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionRejected {
    const { failureCode, resultBalance } = transaction;
    if (
      transaction.status !== WagerTransactionStatus.Rejected ||
      !failureCode ||
      !resultBalance
    ) {
      throw new InvalidTransactionStateError(
        `Transaction ${transaction.id} is not rejected`,
      );
    }
    return new WagerTransactionRejected({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...transactionEventData(transaction),
        failureCode,
        balance: resultBalance.toJSON(),
      },
    });
  }

  override get messageGroupId(): string {
    return this.data.walletId;
  }
}
