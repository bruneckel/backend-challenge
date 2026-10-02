import { ApplicationError } from '@shared/application/application-error';
import type { WagerTransaction, WagerTransactionKind } from '@wallet/domain/transaction/wager-transaction';

export type DuplicateTransactionKey = 'IDEMPOTENCY_KEY' | 'EXTERNAL_TRANSACTION';

export class DuplicateWagerTransactionError extends ApplicationError {
  override readonly code = 'DUPLICATE_WAGER_TRANSACTION';

  constructor(
    readonly key: DuplicateTransactionKey,
    options?: ErrorOptions,
  ) {
    super(`A wager transaction with the same ${key === 'IDEMPOTENCY_KEY' ? 'idempotency key' : 'external id'} already exists`, options);
  }
}

export class StaleTransactionStateError extends ApplicationError {
  override readonly code = 'STALE_TRANSACTION_STATE';

  constructor(readonly transactionId: string) {
    super(`Wager transaction ${transactionId} is no longer waiting for its reference`);
  }
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  lockById(id: string): Promise<WagerTransaction | null>;
  insert(transaction: WagerTransaction): Promise<void>;
  updatePending(transaction: WagerTransaction): Promise<void>;
  hasProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean>;
}
