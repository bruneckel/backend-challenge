import { MessageIdConflictError } from '@messaging/application/errors';
import { TransientFailure } from '@shared/application/transient-failure';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  WalletNotFoundError,
} from '@wallet/application/errors';
import { InvalidMoneyError } from '@wallet/domain/money/money';
import { InvalidWagerTransactionError } from '@wallet/domain/transaction/wager-transaction';

export type DeadLetterReason =
  | 'INVALID_MESSAGE'
  | 'MESSAGE_ID_CONFLICT'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'EXTERNAL_TRANSACTION_CONFLICT'
  | 'WALLET_NOT_FOUND'
  | 'RETRIES_EXHAUSTED';

export type ConsumerFailure =
  | { type: 'dead_letter'; reason: DeadLetterReason }
  | { type: 'retry'; pauseConsumer: boolean };

const PERMANENT_FAILURES: ReadonlyArray<
  [new (...args: never[]) => Error, DeadLetterReason]
> = [
  [MessageIdConflictError, 'MESSAGE_ID_CONFLICT'],
  [IdempotencyKeyConflictError, 'IDEMPOTENCY_KEY_CONFLICT'],
  [ExternalTransactionConflictError, 'EXTERNAL_TRANSACTION_CONFLICT'],
  [WalletNotFoundError, 'WALLET_NOT_FOUND'],
  [InvalidWagerTransactionError, 'INVALID_MESSAGE'],
  [InvalidMoneyError, 'INVALID_MESSAGE'],
];

export function classifyConsumerFailure(error: unknown): ConsumerFailure {
  const permanent = PERMANENT_FAILURES.find(([type]) => error instanceof type);
  if (permanent !== undefined) {
    return { type: 'dead_letter', reason: permanent[1] };
  }
  return {
    type: 'retry',
    pauseConsumer:
      error instanceof TransientFailure && error.reason === 'connection',
  };
}
