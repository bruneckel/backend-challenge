import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { classifyDatabaseError } from '@platform/database/database-failure';
import {
  type DuplicateTransactionKey,
  DuplicateWagerTransactionError,
  StaleTransactionStateError,
  type WagerTransactionRepository,
} from '@wallet/application/ports/wager-transaction-repository';
import {
  type WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '@wallet/domain/transaction/wager-transaction';
import {
  WagerTransactionRecord,
  toWagerTransaction,
  toWagerTransactionProgress,
  toWagerTransactionRow,
} from './wager-transaction-record';

const DUPLICATE_KEYS: Readonly<Record<string, DuplicateTransactionKey>> = {
  wager_transactions_idempotency_key_key: 'IDEMPOTENCY_KEY',
  wager_transactions_provider_external_key: 'EXTERNAL_TRANSACTION',
};

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  findById(id: string): Promise<WagerTransaction | null> {
    return this.findOne({ id });
  }

  findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    return this.findOne({ idempotencyKey });
  }

  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async lockById(id: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(
      WagerTransactionRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return row === null ? null : toWagerTransaction(row);
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    try {
      await this.em.insert(
        WagerTransactionRecord,
        toWagerTransactionRow(transaction),
      );
    } catch (error) {
      const failure = classifyDatabaseError(error);
      const key =
        failure.kind === 'unique_violation'
          ? DUPLICATE_KEYS[failure.constraint ?? '']
          : undefined;
      if (key !== undefined) {
        throw new DuplicateWagerTransactionError(key, { cause: error });
      }
      throw error;
    }
  }

  async updatePending(transaction: WagerTransaction): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: transaction.id, status: WagerTransactionStatus.PendingReference },
      toWagerTransactionProgress(transaction),
    );
    if (affected !== 1) {
      throw new StaleTransactionStateError(transaction.id);
    }
  }

  async hasProcessedReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  private async findOne(
    where: Partial<
      Record<
        'id' | 'idempotencyKey' | 'providerId' | 'externalTransactionId',
        string
      >
    >,
  ) {
    const row = await this.em.findOne(WagerTransactionRecord, where, {
      disableIdentityMap: true,
    });
    return row === null ? null : toWagerTransaction(row);
  }
}
