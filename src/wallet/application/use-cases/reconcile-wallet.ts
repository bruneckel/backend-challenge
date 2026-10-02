import type { Logger } from '@shared/application/logger';
import type { Metrics } from '@shared/application/metrics';
import type { UnitOfWork } from '@shared/application/unit-of-work';
import { WalletNotFoundError } from '@wallet/application/errors';
import type { WageringScope } from '@wallet/application/ports/wagering-scope';
import type { MoneyProps } from '@wallet/domain/money/money';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export interface ReconcileWalletDependencies {
  unitOfWork: UnitOfWork<WageringScope>;
  metrics: Metrics;
  logger: Logger;
}

export class ReconcileWallet {
  constructor(private readonly deps: ReconcileWalletDependencies) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const snapshot = await this.deps.unitOfWork.run(({ ledger }) =>
      ledger.reconciliationSnapshot(walletId),
    );
    if (snapshot === null) {
      throw new WalletNotFoundError(walletId);
    }
    const calculated = snapshot.credits.subtract(snapshot.debits);
    const difference = snapshot.storedBalance.subtract(calculated);
    const consistent = difference.isZero();
    this.deps.metrics.increment('wallet_reconciliations_total', {
      result: consistent ? 'consistent' : 'divergent',
    });
    if (!consistent) {
      this.deps.metrics.increment('wallet_reconciliation_divergences_total');
      this.deps.logger.error('wallet balance diverges from its ledger', {
        walletId,
        checkedEntries: snapshot.entries,
      });
    }
    return {
      walletId,
      storedBalance: snapshot.storedBalance.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snapshot.entries,
    };
  }
}
