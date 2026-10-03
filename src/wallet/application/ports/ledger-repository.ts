import type { WalletLedgerEntry } from '@wallet/domain/ledger/wallet-ledger-entry';
import type { Money } from '@wallet/domain/money/money';

export interface LedgerPageRequest {
  beforeVersion?: number;
  limit: number;
}

export interface LedgerCursor {
  walletId: string;
  afterVersion: number;
}

export interface ReconciliationSnapshot {
  storedBalance: Money;
  storedVersion: number;
  credits: Money;
  debits: Money;
  entries: number;
  firstEntryVersion: number | null;
  lastEntryVersion: number | null;
  chainBreaks: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  page(
    walletId: string,
    request: LedgerPageRequest,
  ): Promise<WalletLedgerEntry[]>;
  after(
    walletId: string,
    afterVersion: number,
    limit: number,
  ): Promise<WalletLedgerEntry[]>;
  afterMany(
    cursors: readonly LedgerCursor[],
    limit: number,
  ): Promise<WalletLedgerEntry[]>;
  reconciliationSnapshot(
    walletId: string,
  ): Promise<ReconciliationSnapshot | null>;
}
