import type {
  EventContext,
  IntegrationEvent,
} from '@messaging/domain/integration-event';
import { OutboxMessage } from '@messaging/domain/outbox-message';
import type { IdGenerator } from '@shared/application/id-generator';
import { WagerTransactionPendingReference } from '@wallet/domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '@wallet/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '@wallet/domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '@wallet/domain/events/wallet-balance-changed';
import type { SettlementOutcome } from '@wallet/domain/settlement/settlement-policy';
import type { WagerTransaction } from '@wallet/domain/transaction/wager-transaction';
import type { Wallet } from '@wallet/domain/wallet/wallet';

export type EventOrigin = Omit<EventContext, 'eventId'>;

export interface SettledTransaction {
  transaction: WagerTransaction;
  wallet: Wallet;
  outcome: SettlementOutcome;
}

export function settlementEvents(
  ids: IdGenerator,
  origin: EventOrigin,
  settled: SettledTransaction,
): OutboxMessage[] {
  const context = (): EventContext => ({ ...origin, eventId: ids.next() });
  const { transaction, wallet, outcome } = settled;
  const events: IntegrationEvent<unknown>[] = [];
  switch (outcome.type) {
    case 'processed':
      events.push(WagerTransactionProcessed.from(transaction, context()));
      if (outcome.ledgerEntry !== null) {
        events.push(
          WalletBalanceChanged.from(wallet, outcome.ledgerEntry, context()),
        );
      }
      break;
    case 'rejected':
      events.push(WagerTransactionRejected.from(transaction, context()));
      break;
    case 'pending_reference':
      if (outcome.firstTime) {
        events.push(
          WagerTransactionPendingReference.from(transaction, context()),
        );
      }
      break;
  }
  return events.map((event) => OutboxMessage.enqueue(event));
}
