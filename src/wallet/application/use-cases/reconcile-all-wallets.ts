import type { UnitOfWork } from '@shared/application/unit-of-work';
import type { WageringScope } from '@wallet/application/ports/wagering-scope';
import type { ReconcileWallet, ReconciliationReport } from './reconcile-wallet';

export interface ReconcileAllWalletsDependencies {
  unitOfWork: UnitOfWork<WageringScope>;
  reconcile: Pick<ReconcileWallet, 'execute'>;
}

export interface ReconcileAllOptions {
  pageSize: number;
  concurrency: number;
  limit?: number;
  after?: string;
  onDivergence?: (report: ReconciliationReport) => void;
}

export interface ReconcileAllSummary {
  checked: number;
  consistent: number;
  divergent: number;
  last: string | undefined;
}

export class ReconcileAllWallets {
  constructor(private readonly deps: ReconcileAllWalletsDependencies) {}

  async execute(options: ReconcileAllOptions): Promise<ReconcileAllSummary> {
    const summary: ReconcileAllSummary = {
      checked: 0,
      consistent: 0,
      divergent: 0,
      last: options.after,
    };
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    while (summary.checked < limit) {
      const page = Math.min(options.pageSize, limit - summary.checked);
      const ids = await this.deps.unitOfWork.run(({ wallets }) =>
        wallets.idsAfter(summary.last, page),
      );
      const reports = await this.reconcileEach(ids, options.concurrency);
      for (const report of reports) {
        summary.checked += 1;
        if (report.consistent) {
          summary.consistent += 1;
        } else {
          summary.divergent += 1;
          options.onDivergence?.(report);
        }
      }
      summary.last = ids.at(-1) ?? summary.last;
      if (ids.length < page) {
        break;
      }
    }
    return summary;
  }

  private async reconcileEach(
    ids: readonly string[],
    concurrency: number,
  ): Promise<ReconciliationReport[]> {
    const reports: ReconciliationReport[] = new Array(ids.length);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const index = next;
        next += 1;
        reports[index] = await this.deps.reconcile.execute(ids[index]!);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, ids.length) }, worker),
    );
    return reports;
  }
}
