import { IntegrationEvent, type EventContext, type IntegrationEventProps } from '@messaging/domain/integration-event';
import type { MoneyProps } from '@wallet/domain/money/money';
import {
  InvalidTransactionStateError,
  WagerTransactionStatus,
  type WagerTransaction,
} from '@wallet/domain/transaction/wager-transaction';
import { transactionEventData, type TransactionEventData } from './transaction-event-data';

export interface WagerTransactionProcessedData extends TransactionEventData {
  referenceTransactionId: string | null;
  balanceAfter: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  override readonly eventType = 'WagerTransactionProcessed';
  override readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    const { resultBalance, processedAt } = transaction;
    if (transaction.status !== WagerTransactionStatus.Processed || !resultBalance || !processedAt) {
      throw new InvalidTransactionStateError(`Transaction ${transaction.id} is not processed`);
    }
    return new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...transactionEventData(transaction),
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        balanceAfter: resultBalance.toJSON(),
        processedAt: processedAt.toISOString(),
      },
    });
  }

  override get messageGroupId(): string {
    return this.data.walletId;
  }
}
