import { OutboxMessage } from '@messaging/domain/outbox-message';
import type { Clock } from '@shared/application/clock';
import type { IdGenerator } from '@shared/application/id-generator';
import type { Logger } from '@shared/application/logger';
import type { Metrics } from '@shared/application/metrics';
import type { UnitOfWork } from '@shared/application/unit-of-work';
import type { PendingReferenceCandidate } from '@wallet/application/ports/wager-transaction-repository';
import type { WageringScope } from '@wallet/application/ports/wagering-scope';
import { WagerTransactionFailed } from '@wallet/domain/events/wager-transaction-failed';
import { FailureCode } from '@wallet/domain/transaction/failure-code';
import {
  type WagerTransaction,
  WagerTransactionStatus,
} from '@wallet/domain/transaction/wager-transaction';

export interface FailPendingTransactionDependencies {
  unitOfWork: UnitOfWork<WageringScope>;
  clock: Clock;
  ids: IdGenerator;
  metrics: Metrics;
  logger: Logger;
}

export class FailPendingTransaction {
  constructor(private readonly deps: FailPendingTransactionDependencies) {}

  async execute(
    candidate: PendingReferenceCandidate,
  ): Promise<'failed' | 'skipped'> {
    const failed = await this.deps.unitOfWork.run((scope) =>
      this.fail(scope, candidate),
    );
    if (failed === undefined) {
      return 'skipped';
    }
    this.deps.metrics.increment('wager_transactions_total', {
      kind: failed.kind,
      status: failed.status,
      channel: 'worker',
    });
    this.deps.logger.error('waiting wager transaction failed', {
      channel: 'worker',
      transactionId: failed.id,
      walletId: failed.walletId,
      kind: failed.kind,
      failureCode: failed.failureCode,
    });
    return 'failed';
  }

  private async fail(
    { wallets, transactions, outbox }: WageringScope,
    candidate: PendingReferenceCandidate,
  ): Promise<WagerTransaction | undefined> {
    const wallet = await wallets.lockForUpdate(candidate.walletId);
    const transaction = await transactions.lockById(candidate.transactionId);
    if (
      wallet === null ||
      transaction === null ||
      transaction.walletId !== wallet.id ||
      transaction.status !== WagerTransactionStatus.PendingReference
    ) {
      return undefined;
    }
    const at = this.deps.clock.now();
    transaction.fail(FailureCode.ProcessingFailed, at);
    await transactions.updatePending(transaction);
    await outbox.enqueue([
      OutboxMessage.enqueue(
        WagerTransactionFailed.from(transaction, {
          eventId: this.deps.ids.next(),
          correlationId: transaction.correlationId,
          causationId: transaction.id,
          occurredAt: at,
        }),
      ),
    ]);
    return transaction;
  }
}
