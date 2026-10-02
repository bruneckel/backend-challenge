import {
  IntegrationEvent,
  type EventContext,
  type IntegrationEventProps,
} from '@messaging/domain/integration-event';
import {
  InvalidTransactionStateError,
  WagerTransactionStatus,
  type WagerTransaction,
} from '@wallet/domain/transaction/wager-transaction';
import {
  transactionEventData,
  type TransactionEventData,
} from './transaction-event-data';

export interface WagerTransactionPendingReferenceData extends TransactionEventData {
  referenceExternalTransactionId: string;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  override readonly eventType = 'WagerTransactionPendingReference';
  override readonly version = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionPendingReferenceData>,
  ) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionPendingReference {
    const { referenceExternalTransactionId, nextReferenceAttemptAt } =
      transaction;
    if (
      transaction.status !== WagerTransactionStatus.PendingReference ||
      referenceExternalTransactionId === undefined ||
      nextReferenceAttemptAt === undefined
    ) {
      throw new InvalidTransactionStateError(
        `Transaction ${transaction.id} is not waiting for its reference`,
      );
    }
    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...transactionEventData(transaction),
        referenceExternalTransactionId,
        nextAttemptAt: nextReferenceAttemptAt.toISOString(),
      },
    });
  }

  override get messageGroupId(): string {
    return this.data.walletId;
  }
}
