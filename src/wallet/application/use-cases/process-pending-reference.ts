import type { Clock } from '@shared/application/clock';
import type { IdGenerator } from '@shared/application/id-generator';
import type { UnitOfWork } from '@shared/application/unit-of-work';
import type { WageringScope } from '@wallet/application/ports/wagering-scope';
import { TransactionSettler } from '@wallet/application/transaction-settler';
import type { SettlementOutcome, SettlementPolicy } from '@wallet/domain/settlement/settlement-policy';
import { type WagerTransaction, WagerTransactionStatus } from '@wallet/domain/transaction/wager-transaction';

export interface PendingReferenceCandidate {
  transactionId: string;
  walletId: string;
}

export type PendingReferenceOutcome = 'processed' | 'rejected' | 'still_pending' | 'skipped';

export interface ProcessPendingReferenceDependencies {
  unitOfWork: UnitOfWork<WageringScope>;
  clock: Clock;
  ids: IdGenerator;
  settlement: SettlementPolicy;
}

const OUTCOMES: Record<SettlementOutcome['type'], PendingReferenceOutcome> = {
  processed: 'processed',
  rejected: 'rejected',
  pending_reference: 'still_pending',
};

export class ProcessPendingReference {
  private readonly settler: TransactionSettler;

  constructor(private readonly deps: ProcessPendingReferenceDependencies) {
    this.settler = new TransactionSettler(deps.settlement, deps.ids);
  }

  execute(candidate: PendingReferenceCandidate): Promise<PendingReferenceOutcome> {
    return this.deps.unitOfWork.run(async (scope) => {
      const wallet = await scope.wallets.lockForUpdate(candidate.walletId);
      if (wallet === null) {
        return 'skipped';
      }
      const transaction = await scope.transactions.lockById(candidate.transactionId);
      const at = this.deps.clock.now();
      if (!isDueForReference(transaction, wallet.id, at)) {
        return 'skipped';
      }
      const settlement = await this.settler.settle(scope, transaction, wallet, at);
      await this.settler.recordProgress(scope, settlement, {
        correlationId: transaction.correlationId,
        causationId: transaction.id,
        occurredAt: at,
      });
      return OUTCOMES[settlement.outcome.type];
    });
  }
}

function isDueForReference(transaction: WagerTransaction | null, walletId: string, at: Date): transaction is WagerTransaction {
  return (
    transaction !== null &&
    transaction.walletId === walletId &&
    transaction.status === WagerTransactionStatus.PendingReference &&
    transaction.nextReferenceAttemptAt !== undefined &&
    transaction.nextReferenceAttemptAt <= at
  );
}
