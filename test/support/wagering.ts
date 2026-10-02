import { CanonicalJsonFingerprinter } from '@platform/crypto/canonical-json-fingerprinter';
import { UuidV7Generator } from '@platform/ids/uuid-v7-generator';
import type { Clock } from '@shared/application/clock';
import type { UnitOfWork } from '@shared/application/unit-of-work';
import { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import type { WageringScope } from '@wallet/application/ports/wagering-scope';
import { OpenWallet } from '@wallet/application/use-cases/open-wallet';
import { ProcessPendingReference } from '@wallet/application/use-cases/process-pending-reference';
import { ReconcileWallet } from '@wallet/application/use-cases/reconcile-wallet';
import { SubmitWagerTransaction } from '@wallet/application/use-cases/submit-wager-transaction';
import { WalletQueries } from '@wallet/application/use-cases/wallet-queries';
import type { WalletView } from '@wallet/application/views';
import { SettlementPolicy } from '@wallet/domain/settlement/settlement-policy';

export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  set(at: Date): void {
    this.current = at;
  }
}

export interface Wagering {
  clock: FixedClock;
  openWallet: OpenWallet;
  submit: SubmitWagerTransaction;
  processPendingReference: ProcessPendingReference;
  queries: WalletQueries;
  reconcile: ReconcileWallet;
}

export const START = new Date('2026-10-02T12:00:00.000Z');

export function createWagering(unitOfWork: UnitOfWork<WageringScope>, maxReferenceAttempts = 3): Wagering {
  const clock = new FixedClock(START);
  const ids = new UuidV7Generator();
  const fingerprinter = new CanonicalJsonFingerprinter();
  const settlement = new SettlementPolicy({
    maxReferenceAttempts,
    referenceBackoff: ExponentialBackoff.create({ baseMs: 1000, maxMs: 4000, random: () => 1 }),
  });
  return {
    clock,
    openWallet: new OpenWallet({ unitOfWork, fingerprinter, clock, ids }),
    submit: new SubmitWagerTransaction({ unitOfWork, fingerprinter, clock, ids, settlement }),
    processPendingReference: new ProcessPendingReference({ unitOfWork, clock, ids, settlement }),
    queries: new WalletQueries({ unitOfWork }),
    reconcile: new ReconcileWallet({ unitOfWork }),
  };
}

export function openWalletWith(wagering: Wagering, amount = '100.00', currency = 'BRL'): Promise<WalletView> {
  return wagering.openWallet.execute({
    playerId: Bun.randomUUIDv7(),
    initialBalance: { amount, currency },
    correlationId: 'correlation-1',
  });
}
