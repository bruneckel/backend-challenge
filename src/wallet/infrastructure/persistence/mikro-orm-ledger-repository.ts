import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  LedgerPageRequest,
  LedgerRepository,
  ReconciliationSnapshot,
} from '@wallet/application/ports/ledger-repository';
import type { WalletLedgerEntry } from '@wallet/domain/ledger/wallet-ledger-entry';
import { Money } from '@wallet/domain/money/money';
import {
  LedgerEntryRecord,
  toLedgerEntry,
  toLedgerEntryRow,
} from './ledger-entry-record';

interface ReconciliationRow {
  currency: string;
  stored: string;
  credits: string;
  debits: string;
  entries: number;
}

const RECONCILIATION_SQL = `
  select w.currency, w.balance_amount::text as stored,
    coalesce(sum(l.amount) filter (where l.direction = 'CREDIT'), 0.00)::text as credits,
    coalesce(sum(l.amount) filter (where l.direction = 'DEBIT'), 0.00)::text as debits,
    count(l.id)::int as entries
  from wallets w
  left join wallet_ledger_entries l on l.wallet_id = w.id
  where w.id = ?
  group by w.id`;

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, toLedgerEntryRow(entry));
  }

  async page(
    walletId: string,
    request: LedgerPageRequest,
  ): Promise<WalletLedgerEntry[]> {
    const rows = await this.em.find(
      LedgerEntryRecord,
      request.beforeVersion === undefined
        ? { walletId }
        : { walletId, walletVersion: { $lt: request.beforeVersion } },
      {
        orderBy: { walletVersion: 'desc' },
        limit: request.limit,
        disableIdentityMap: true,
      },
    );
    return rows.map(toLedgerEntry);
  }

  async reconciliationSnapshot(
    walletId: string,
  ): Promise<ReconciliationSnapshot | null> {
    const [row] = await this.em.execute<ReconciliationRow[]>(
      RECONCILIATION_SQL,
      [walletId],
    );
    if (row === undefined) {
      return null;
    }
    const money = (amount: string) =>
      Money.from({ amount, currency: row.currency });
    return {
      storedBalance: money(row.stored),
      credits: money(row.credits),
      debits: money(row.debits),
      entries: row.entries,
    };
  }
}
