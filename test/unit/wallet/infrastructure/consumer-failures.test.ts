import { describe, expect, test } from 'bun:test';
import { MessageIdConflictError } from '@messaging/application/errors';
import { TransientFailure } from '@shared/application/transient-failure';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  WalletNotFoundError,
} from '@wallet/application/errors';
import { DuplicateWagerTransactionError } from '@wallet/application/ports/wager-transaction-repository';
import { InvalidMoneyError } from '@wallet/domain/money/money';
import { InvalidWagerTransactionError } from '@wallet/domain/transaction/wager-transaction';
import {
  REDRIVABLE_REASONS,
  classifyConsumerFailure,
} from '@wallet/infrastructure/messaging/consumer-failures';

describe('classifyConsumerFailure', () => {
  test.each([
    [
      'a message id reused with another payload',
      new MessageIdConflictError('m'),
      'MESSAGE_ID_CONFLICT',
    ],
    [
      'an idempotency key reused with another payload',
      new IdempotencyKeyConflictError('k'),
      'IDEMPOTENCY_KEY_CONFLICT',
    ],
    [
      'an external id reused with another key',
      new ExternalTransactionConflictError('p', 'e'),
      'EXTERNAL_TRANSACTION_CONFLICT',
    ],
    [
      'a wallet that does not exist',
      new WalletNotFoundError('w'),
      'WALLET_NOT_FOUND',
    ],
    [
      'an OPENING sent through the queue',
      new InvalidWagerTransactionError('UNSUPPORTED_KIND', 'x'),
      'INVALID_MESSAGE',
    ],
    [
      'a reversal without a reference',
      new InvalidWagerTransactionError('REFERENCE_REQUIRED', 'x'),
      'INVALID_MESSAGE',
    ],
    ['invalid money', new InvalidMoneyError('x'), 'INVALID_MESSAGE'],
  ] as const)('sends %s to the dead-letter queue', (_, error, reason) => {
    expect(classifyConsumerFailure(error)).toEqual({
      type: 'dead_letter',
      reason,
    });
  });

  test.each([
    ['a lock wait that timed out', new TransientFailure('lock_timeout')],
    ['a deadlock', new TransientFailure('deadlock')],
    ['a statement timeout', new TransientFailure('statement_timeout')],
    [
      'a duplicate insert that survived the retry',
      new DuplicateWagerTransactionError('IDEMPOTENCY_KEY'),
    ],
    ['an unexpected error', new Error('boom')],
  ])('retries %s later', (_, error) => {
    expect(classifyConsumerFailure(error)).toEqual({
      type: 'retry',
      pauseConsumer: false,
    });
  });

  test('retries a lost database connection and pauses the consumer', () => {
    expect(classifyConsumerFailure(new TransientFailure('connection'))).toEqual(
      { type: 'retry', pauseConsumer: true },
    );
  });
});

describe('dead letters that may go back to the queue', () => {
  test('are the ones a retry or a fix outside the message can solve', () => {
    expect([...REDRIVABLE_REASONS].sort()).toEqual([
      'RETRIES_EXHAUSTED',
      'WALLET_NOT_FOUND',
    ]);
  });
});
