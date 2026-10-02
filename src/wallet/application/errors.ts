import { ApplicationError } from '@shared/application/application-error';

export class WalletNotFoundError extends ApplicationError {
  override readonly code = 'WALLET_NOT_FOUND';

  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} was not found`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  override readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(description: string) {
    super(`Wager transaction ${description} was not found`);
  }
}

export class IdempotencyKeyConflictError extends ApplicationError {
  override readonly code = 'IDEMPOTENCY_KEY_CONFLICT';

  constructor(readonly idempotencyKey: string) {
    super('A transaction with this idempotency key already exists with a different payload');
  }
}

export class ExternalTransactionConflictError extends ApplicationError {
  override readonly code = 'EXTERNAL_TRANSACTION_CONFLICT';

  constructor(
    readonly providerId: string,
    readonly externalTransactionId: string,
  ) {
    super(`Provider ${providerId} already used external transaction ${externalTransactionId} with another idempotency key`);
  }
}
