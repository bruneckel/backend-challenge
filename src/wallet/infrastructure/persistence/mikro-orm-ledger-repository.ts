import type { EntityManager } from '@mikro-orm/postgresql';
import type { LedgerPageRequest, LedgerRepository } from '@wallet/application/ports/ledger-repository';
import type { WalletLedgerEntry } from '@wallet/domain/ledger/wallet-ledger-entry';
import { LedgerEntryRecord, toLedgerEntry, toLedgerEntryRow } from './ledger-entry-record';

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, toLedgerEntryRow(entry));
  }

  async page(walletId: string, request: LedgerPageRequest): Promise<WalletLedgerEntry[]> {
    const rows = await this.em.find(
      LedgerEntryRecord,
      request.beforeVersion === undefined ? { walletId } : { walletId, walletVersion: { $lt: request.beforeVersion } },
      { orderBy: { walletVersion: 'desc' }, limit: request.limit, disableIdentityMap: true },
    );
    return rows.map(toLedgerEntry);
  }
}
