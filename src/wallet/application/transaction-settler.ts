import type { IdGenerator } from '@shared/application/id-generator';
import type { Metrics } from '@shared/application/metrics';
import type {
  SettlementOutcome,
  SettlementPolicy,
} from '@wallet/domain/settlement/settlement-policy';
import type { WagerTransaction } from '@wallet/domain/transaction/wager-transaction';
import type { Wallet } from '@wallet/domain/wallet/wallet';
import { StaleWalletVersionError } from './ports/wallet-repository';
import type { WageringScope } from './ports/wagering-scope';
import { type EventOrigin, settlementEvents } from './settlement-events';

export interface Settlement {
  transaction: WagerTransaction;
  wallet: Wallet;
  expectedVersion: number;
  outcome: SettlementOutcome;
}

export class TransactionSettler {
  constructor(
    private readonly policy: SettlementPolicy,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
  ) {}

  async lockWallet(
    scope: WageringScope,
    walletId: string,
  ): Promise<Wallet | null> {
    const started = performance.now();
    const wallet = await scope.wallets.lockForUpdate(walletId);
    this.metrics.observe(
      'wallet_lock_wait_seconds',
      (performance.now() - started) / 1000,
    );
    return wallet;
  }

  async settle(
    scope: WageringScope,
    transaction: WagerTransaction,
    wallet: Wallet,
    at: Date,
  ): Promise<Settlement> {
    const reference =
      transaction.referenceExternalTransactionId === undefined
        ? null
        : await scope.transactions.findByExternalId(
            transaction.providerId,
            transaction.referenceExternalTransactionId,
          );
    const referenceAlreadyReversed =
      reference !== null && transaction.requiresReference()
        ? await scope.transactions.hasProcessedReversal(
            reference.id,
            transaction.kind,
          )
        : false;
    const expectedVersion = wallet.version;
    const outcome = this.policy.settle({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      at,
    });
    return { transaction, wallet, expectedVersion, outcome };
  }

  async recordNew(
    scope: WageringScope,
    settlement: Settlement,
    origin: EventOrigin,
  ): Promise<void> {
    await scope.transactions.insert(settlement.transaction);
    await this.recordEffects(scope, settlement, origin);
  }

  async recordProgress(
    scope: WageringScope,
    settlement: Settlement,
    origin: EventOrigin,
  ): Promise<void> {
    await scope.transactions.updatePending(settlement.transaction);
    await this.recordEffects(scope, settlement, origin);
  }

  private async recordEffects(
    scope: WageringScope,
    settlement: Settlement,
    origin: EventOrigin,
  ): Promise<void> {
    const { wallet, expectedVersion, outcome } = settlement;
    if (outcome.type === 'processed' && outcome.ledgerEntry !== null) {
      await this.applyBalanceChange(scope, wallet, expectedVersion);
      await scope.ledger.append(outcome.ledgerEntry);
    }
    await scope.outbox.enqueue(settlementEvents(this.ids, origin, settlement));
  }

  private async applyBalanceChange(
    scope: WageringScope,
    wallet: Wallet,
    expectedVersion: number,
  ): Promise<void> {
    try {
      await scope.wallets.applyBalanceChange(wallet, expectedVersion);
    } catch (error) {
      if (error instanceof StaleWalletVersionError) {
        this.metrics.increment('wallet_version_conflicts_total');
      }
      throw error;
    }
  }
}
