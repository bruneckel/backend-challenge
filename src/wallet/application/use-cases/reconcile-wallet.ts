import type { LogFields, Logger } from '@shared/application/logger';
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
  chainBreaks: number;
  versionConsistent: boolean;
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
    const balanceMatches = difference.isZero();
    const versionConsistent =
      snapshot.storedVersion === (snapshot.lastEntryVersion ?? 1) &&
      (snapshot.firstEntryVersion ?? 1) <= 2;
    const consistent =
      balanceMatches && snapshot.chainBreaks === 0 && versionConsistent;
    this.deps.metrics.increment('wallet_reconciliations_total', {
      result: consistent ? 'consistent' : 'divergent',
    });
    if (!balanceMatches) {
      this.diverged('balance', 'wallet balance diverges from its ledger', {
        walletId,
        checkedEntries: snapshot.entries,
      });
    }
    if (snapshot.chainBreaks > 0) {
      this.diverged('chain', 'wallet ledger chain is broken', {
        walletId,
        chainBreaks: snapshot.chainBreaks,
      });
    }
    if (!versionConsistent) {
      this.diverged('version', 'wallet version diverges from its ledger', {
        walletId,
        storedVersion: snapshot.storedVersion,
        lastEntryVersion: snapshot.lastEntryVersion,
      });
    }
    return {
      walletId,
      storedBalance: snapshot.storedBalance.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snapshot.entries,
      chainBreaks: snapshot.chainBreaks,
      versionConsistent,
    };
  }

  private diverged(kind: string, message: string, fields: LogFields): void {
    this.deps.metrics.increment('wallet_reconciliation_divergences_total', {
      kind,
    });
    this.deps.logger.error(message, fields);
  }
}
