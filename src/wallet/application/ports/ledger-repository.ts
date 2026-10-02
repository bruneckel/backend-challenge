import type { WalletLedgerEntry } from '@wallet/domain/ledger/wallet-ledger-entry';

export interface LedgerPageRequest {
  beforeVersion?: number;
  limit: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  page(walletId: string, request: LedgerPageRequest): Promise<WalletLedgerEntry[]>;
}
