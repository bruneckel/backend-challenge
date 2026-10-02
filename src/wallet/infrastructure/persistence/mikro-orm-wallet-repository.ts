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

  async lockForUpdate(id: string): Promise<Wallet | null> {
    const row = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return row === null ? null : toWallet(row);
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
