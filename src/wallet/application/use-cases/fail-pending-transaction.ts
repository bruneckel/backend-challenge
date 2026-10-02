import type { Clock } from '@shared/application/clock';
import type { UnitOfWork } from '@shared/application/unit-of-work';
import type { PendingReferenceCandidate } from '@wallet/application/ports/wager-transaction-repository';
import type { WageringScope } from '@wallet/application/ports/wagering-scope';
import { FailureCode } from '@wallet/domain/transaction/failure-code';
import { WagerTransactionStatus } from '@wallet/domain/transaction/wager-transaction';

export interface FailPendingTransactionDependencies {
  unitOfWork: UnitOfWork<WageringScope>;
  clock: Clock;
}

export class FailPendingTransaction {
  constructor(private readonly deps: FailPendingTransactionDependencies) {}

  execute(candidate: PendingReferenceCandidate): Promise<'failed' | 'skipped'> {
    return this.deps.unitOfWork.run(async ({ wallets, transactions }) => {
      const wallet = await wallets.lockForUpdate(candidate.walletId);
      const transaction = await transactions.lockById(candidate.transactionId);
      if (
        wallet === null ||
        transaction === null ||
        transaction.walletId !== wallet.id ||
        transaction.status !== WagerTransactionStatus.PendingReference
      ) {
        return 'skipped';
      }
      transaction.fail(FailureCode.ProcessingFailed, this.deps.clock.now());
      await transactions.updatePending(transaction);
      return 'failed';
    });
  }
}
