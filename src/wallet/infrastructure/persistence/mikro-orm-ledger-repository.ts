import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  LedgerCursor,
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
  version: number;
  credits: string;
  debits: string;
  entries: number;
  first_version: number | null;
  last_version: number | null;
  chain_breaks: number;
}

const RECONCILIATION_SQL = `
  with chain as (
    select wallet_version, direction, amount, balance_before,
      lag(balance_after) over (order by wallet_version) as previous_after,
      lag(wallet_version) over (order by wallet_version) as previous_version
    from wallet_ledger_entries
    where wallet_id = ?
  )
  select w.currency, w.balance_amount::text as stored, w.version,
    coalesce(sum(c.amount) filter (where c.direction = 'CREDIT'), 0.00)::text as credits,
    coalesce(sum(c.amount) filter (where c.direction = 'DEBIT'), 0.00)::text as debits,
    count(c.wallet_version)::int as entries,
    min(c.wallet_version) as first_version,
    max(c.wallet_version) as last_version,
    count(*) filter (
      where (c.previous_version is null and c.balance_before <> 0)
         or (c.previous_version is not null
             and (c.balance_before <> c.previous_after
                  or c.wallet_version <> c.previous_version + 1))
    )::int as chain_breaks
  from wallets w
  left join chain c on true
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

  async after(
    walletId: string,
    afterVersion: number,
    limit: number,
  ): Promise<WalletLedgerEntry[]> {
    const rows = await this.em.find(
      LedgerEntryRecord,
      { walletId, walletVersion: { $gt: afterVersion } },
      {
        orderBy: { walletVersion: 'asc' },
        limit,
        disableIdentityMap: true,
      },
    );
    return rows.map(toLedgerEntry);
  }

  async afterMany(
    cursors: readonly LedgerCursor[],
    limit: number,
  ): Promise<WalletLedgerEntry[]> {
    if (cursors.length === 0) {
      return [];
    }
    const rows = await this.em.find(
      LedgerEntryRecord,
      {
        $or: cursors.map(({ walletId, afterVersion }) => ({
          walletId,
          walletVersion: { $gt: afterVersion },
        })),
      },
      {
        orderBy: { walletId: 'asc', walletVersion: 'asc' },
        limit,
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
      [walletId, walletId],
    );
    if (row === undefined) {
      return null;
    }
    const money = (amount: string) =>
      Money.from({ amount, currency: row.currency });
    return {
      storedBalance: money(row.stored),
      storedVersion: row.version,
      credits: money(row.credits),
      debits: money(row.debits),
      entries: row.entries,
      firstEntryVersion: row.first_version,
      lastEntryVersion: row.last_version,
      chainBreaks: row.chain_breaks,
    };
  }
}
