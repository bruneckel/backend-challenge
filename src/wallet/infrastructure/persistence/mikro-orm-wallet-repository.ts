import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { classifyDatabaseError } from '@platform/database/database-failure';
import {
  StaleWalletVersionError,
  WalletAlreadyExistsError,
  type WalletRepository,
} from '@wallet/application/ports/wallet-repository';
import type { Wallet } from '@wallet/domain/wallet/wallet';
import { WalletRecord, toWallet, toWalletRow } from './wallet-record';

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const row = await this.em.findOne(
      WalletRecord,
      { id },
      { disableIdentityMap: true },
    );
    return row === null ? null : toWallet(row);
  }

  async findByOwner(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null> {
    const row = await this.em.findOne(
      WalletRecord,
      { playerId, currency },
      { disableIdentityMap: true },
    );
    return row === null ? null : toWallet(row);
  }

  async lockForUpdate(id: string): Promise<Wallet | null> {
    const row = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return row === null ? null : toWallet(row);
  }

  async versionsOf(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.em.find(
      WalletRecord,
      { id: { $in: [...ids] } },
      { fields: ['id', 'version'], disableIdentityMap: true },
    );
    return new Map(rows.map((row) => [row.id, row.version]));
  }

  async idsAfter(after: string | undefined, limit: number): Promise<string[]> {
    const rows = await this.em.find(
      WalletRecord,
      after === undefined ? {} : { id: { $gt: after } },
      {
        fields: ['id'],
        orderBy: { id: 'asc' },
        limit,
        disableIdentityMap: true,
      },
    );
    return rows.map((row) => row.id);
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletRecord, toWalletRow(wallet));
    } catch (error) {
      const failure = classifyDatabaseError(error);
      if (
        failure.kind === 'unique_violation' &&
        failure.constraint === 'wallets_player_currency_key'
      ) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency, {
          cause: error,
        });
      }
      throw error;
    }
  }

  async applyBalanceChange(
    wallet: Wallet,
    expectedVersion: number,
  ): Promise<void> {
    const { balanceAmount, version, updatedAt } = toWalletRow(wallet);
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balanceAmount, version, updatedAt },
    );
    if (affected !== 1) {
      throw new StaleWalletVersionError(wallet.id, expectedVersion);
    }
  }
}
