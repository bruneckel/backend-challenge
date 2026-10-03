import type { UnitOfWork } from '@shared/application/unit-of-work';
import {
  TransactionNotFoundError,
  WalletNotFoundError,
} from '@wallet/application/errors';
import type { LedgerCursor } from '@wallet/application/ports/ledger-repository';
import type { WageringScope } from '@wallet/application/ports/wagering-scope';
import {
  type LedgerEntryView,
  type LedgerPage,
  type TransactionView,
  type WalletView,
  toLedgerEntryView,
  toTransactionView,
  toWalletView,
} from '@wallet/application/views';

export interface LedgerQuery {
  beforeVersion?: number;
  limit: number;
}

export interface WalletQueriesDependencies {
  unitOfWork: UnitOfWork<WageringScope>;
}

export class WalletQueries {
  constructor(private readonly deps: WalletQueriesDependencies) {}

  getWallet(walletId: string): Promise<WalletView> {
    return this.deps.unitOfWork.run(async ({ wallets }) => {
      const wallet = await wallets.findById(walletId);
      if (wallet === null) {
        throw new WalletNotFoundError(walletId);
      }
      return toWalletView(wallet);
    });
  }

  getLedger(walletId: string, query: LedgerQuery): Promise<LedgerPage> {
    return this.deps.unitOfWork.run(async ({ wallets, ledger }) => {
      if ((await wallets.findById(walletId)) === null) {
        throw new WalletNotFoundError(walletId);
      }
      const entries = await ledger.page(walletId, {
        beforeVersion: query.beforeVersion,
        limit: query.limit + 1,
      });
      const items = entries.slice(0, query.limit).map(toLedgerEntryView);
      const last = items.at(-1);
      return {
        items,
        nextBeforeVersion:
          entries.length > query.limit && last !== undefined
            ? last.walletVersion
            : null,
      };
    });
  }

  getLedgerAfter(
    walletId: string,
    afterVersion: number,
    limit: number,
  ): Promise<LedgerEntryView[]> {
    return this.deps.unitOfWork.run(async ({ ledger }) =>
      (await ledger.after(walletId, afterVersion, limit)).map(
        toLedgerEntryView,
      ),
    );
  }

  async getLedgerAfterMany(
    cursors: readonly LedgerCursor[],
    limit: number,
  ): Promise<ReadonlyMap<string, LedgerEntryView[]>> {
    if (cursors.length === 0) {
      return new Map();
    }
    return this.deps.unitOfWork.run(async ({ ledger }) => {
      const grouped = new Map<string, LedgerEntryView[]>();
      for (const entry of await ledger.afterMany(cursors, limit)) {
        const items = grouped.get(entry.walletId) ?? [];
        items.push(toLedgerEntryView(entry));
        grouped.set(entry.walletId, items);
      }
      return grouped;
    });
  }

  getWalletVersions(
    walletIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    return this.deps.unitOfWork.run(({ wallets }) =>
      wallets.versionsOf(walletIds),
    );
  }

  getTransaction(transactionId: string): Promise<TransactionView> {
    return this.deps.unitOfWork.run(async ({ transactions }) => {
      const transaction = await transactions.findById(transactionId);
      if (transaction === null) {
        throw new TransactionNotFoundError(transactionId);
      }
      return toTransactionView(transaction);
    });
  }

  getTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionView> {
    return this.deps.unitOfWork.run(async ({ transactions }) => {
      const transaction = await transactions.findByExternalId(
        providerId,
        externalTransactionId,
      );
      if (transaction === null) {
        throw new TransactionNotFoundError(
          `${providerId}/${externalTransactionId}`,
        );
      }
      return toTransactionView(transaction);
    });
  }
}
