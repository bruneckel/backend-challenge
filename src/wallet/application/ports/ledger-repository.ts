import type { WalletLedgerEntry } from '@wallet/domain/ledger/wallet-ledger-entry';
import type { Money } from '@wallet/domain/money/money';

export interface LedgerPageRequest {
  beforeVersion?: number;
  limit: number;
}

export interface ReconciliationSnapshot {
  storedBalance: Money;
  credits: Money;
  debits: Money;
  entries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  page(
    walletId: string,
    request: LedgerPageRequest,
  ): Promise<WalletLedgerEntry[]>;
  reconciliationSnapshot(
    walletId: string,
  ): Promise<ReconciliationSnapshot | null>;
}
