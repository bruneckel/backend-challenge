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
    return {
      walletId,
      storedBalance: snapshot.storedBalance.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero(),
      checkedEntries: snapshot.entries,
    };
  }
}
