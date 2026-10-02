import type { Clock } from '@shared/application/clock';
import type { IdGenerator } from '@shared/application/id-generator';
import type { Logger } from '@shared/application/logger';
import type { Metrics } from '@shared/application/metrics';
import type { UnitOfWork } from '@shared/application/unit-of-work';
import type { PendingReferenceCandidate } from '@wallet/application/ports/wager-transaction-repository';
import type { WageringScope } from '@wallet/application/ports/wagering-scope';
import { TransactionSettler } from '@wallet/application/transaction-settler';
import type {
  SettlementOutcome,
  SettlementPolicy,
} from '@wallet/domain/settlement/settlement-policy';
import {
  type WagerTransaction,
  WagerTransactionStatus,
} from '@wallet/domain/transaction/wager-transaction';

export type { PendingReferenceCandidate } from '@wallet/application/ports/wager-transaction-repository';

export type PendingReferenceOutcome =
  'processed' | 'rejected' | 'still_pending' | 'skipped';

export interface ProcessPendingReferenceDependencies {
  unitOfWork: UnitOfWork<WageringScope>;
  clock: Clock;
  ids: IdGenerator;
  settlement: SettlementPolicy;
  metrics: Metrics;
  logger: Logger;
}

const OUTCOMES: Record<SettlementOutcome['type'], PendingReferenceOutcome> = {
  processed: 'processed',
  rejected: 'rejected',
  pending_reference: 'still_pending',
};

export class ProcessPendingReference {
  private readonly settler: TransactionSettler;

  constructor(private readonly deps: ProcessPendingReferenceDependencies) {
    this.settler = new TransactionSettler(
      deps.settlement,
      deps.ids,
      deps.metrics,
    );
  }

  async execute(
    candidate: PendingReferenceCandidate,
  ): Promise<PendingReferenceOutcome> {
    let settled: WagerTransaction | undefined;
    const outcome = await this.deps.unitOfWork.run(async (scope) => {
      const wallet = await this.settler.lockWallet(scope, candidate.walletId);
      if (wallet === null) {
        return 'skipped';
      }
      const transaction = await scope.transactions.lockById(
        candidate.transactionId,
      );
      const at = this.deps.clock.now();
      if (!isDueForReference(transaction, wallet.id, at)) {
        return 'skipped';
      }
      const settlement = await this.settler.settle(
        scope,
        transaction,
        wallet,
        at,
      );
      await this.settler.recordProgress(scope, settlement, {
        correlationId: transaction.correlationId,
        causationId: transaction.id,
        occurredAt: at,
      });
      settled = transaction;
      return OUTCOMES[settlement.outcome.type];
    });
    if (settled !== undefined) {
      this.record(outcome, settled);
    }
    return outcome;
  }

  private record(
    outcome: PendingReferenceOutcome,
    transaction: WagerTransaction,
  ): void {
    const fields = {
      channel: 'worker',
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      kind: transaction.kind,
      status: transaction.status,
      failureCode: transaction.failureCode,
    };
    if (outcome === 'still_pending') {
      this.deps.metrics.increment('pending_reference_retries_total');
      this.deps.logger.info('reference still missing', {
        ...fields,
        attempt: transaction.referenceAttempts,
      });
      return;
    }
    this.deps.metrics.increment('wager_transactions_total', {
      kind: transaction.kind,
      status: transaction.status,
      channel: 'worker',
    });
    this.deps.logger.info('waiting wager transaction settled', fields);
  }
}

function isDueForReference(
  transaction: WagerTransaction | null,
  walletId: string,
  at: Date,
): transaction is WagerTransaction {
  return (
    transaction !== null &&
    transaction.walletId === walletId &&
    transaction.status === WagerTransactionStatus.PendingReference &&
    transaction.nextReferenceAttemptAt !== undefined &&
    transaction.nextReferenceAttemptAt <= at
  );
}
