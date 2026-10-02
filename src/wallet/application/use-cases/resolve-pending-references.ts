import type { Clock } from '@shared/application/clock';
import { TransientFailure } from '@shared/application/transient-failure';
import type { UnitOfWork } from '@shared/application/unit-of-work';
import type { PendingReferenceCandidate } from '@wallet/application/ports/wager-transaction-repository';
import type { WageringScope } from '@wallet/application/ports/wagering-scope';
import type { FailPendingTransaction } from './fail-pending-transaction';
import type {
  PendingReferenceOutcome,
  ProcessPendingReference,
} from './process-pending-reference';

export interface ResolvePendingReferencesDependencies {
  unitOfWork: UnitOfWork<WageringScope>;
  clock: Clock;
  process: Pick<ProcessPendingReference, 'execute'>;
  fail: Pick<FailPendingTransaction, 'execute'>;
  batchSize: number;
  maxProcessingFailures: number;
}

export interface ResolutionSummary {
  candidates: number;
  processed: number;
  rejected: number;
  stillPending: number;
  skipped: number;
  failed: number;
  transientFailures: number;
}

const COUNTERS: Record<PendingReferenceOutcome, keyof ResolutionSummary> = {
  processed: 'processed',
  rejected: 'rejected',
  still_pending: 'stillPending',
  skipped: 'skipped',
};

export class ResolvePendingReferences {
  private readonly processingFailures = new Map<string, number>();

  constructor(private readonly deps: ResolvePendingReferencesDependencies) {}

  async runOnce(): Promise<ResolutionSummary> {
    const candidates = await this.deps.unitOfWork.run(({ transactions }) =>
      transactions.findDueReferenceCandidates(
        this.deps.clock.now(),
        this.deps.batchSize,
      ),
    );
    const summary: ResolutionSummary = {
      candidates: candidates.length,
      processed: 0,
      rejected: 0,
      stillPending: 0,
      skipped: 0,
      failed: 0,
      transientFailures: 0,
    };
    for (const candidate of candidates) {
      await this.resolve(candidate, summary);
    }
    return summary;
  }

  private async resolve(
    candidate: PendingReferenceCandidate,
    summary: ResolutionSummary,
  ): Promise<void> {
    try {
      const outcome = await this.deps.process.execute(candidate);
      this.processingFailures.delete(candidate.transactionId);
      summary[COUNTERS[outcome]] += 1;
    } catch (error) {
      if (error instanceof TransientFailure) {
        summary.transientFailures += 1;
        return;
      }
      const failures =
        (this.processingFailures.get(candidate.transactionId) ?? 0) + 1;
      if (failures < this.deps.maxProcessingFailures) {
        this.processingFailures.set(candidate.transactionId, failures);
        return;
      }
      this.processingFailures.delete(candidate.transactionId);
      if ((await this.deps.fail.execute(candidate)) === 'failed') {
        summary.failed += 1;
      }
    }
  }
}
