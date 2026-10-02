import { describe, expect, test } from 'bun:test';
import {
  BadRequestException,
  MethodNotAllowedException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  IdempotencyKeyRequiredError,
  RequestValidationError,
} from '@platform/http/request-errors';
import { problemFor } from '@platform/http/problem';
import { TransientFailure } from '@shared/application/transient-failure';
import { NestedUnitOfWorkError } from '@shared/application/unit-of-work';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  TransactionNotFoundError,
  WalletNotFoundError,
} from '@wallet/application/errors';
import { DuplicateWagerTransactionError } from '@wallet/application/ports/wager-transaction-repository';
import {
  StaleWalletVersionError,
  WalletAlreadyExistsError,
} from '@wallet/application/ports/wallet-repository';
import { InvalidMoneyError } from '@wallet/domain/money/money';
import { InvalidWagerTransactionError } from '@wallet/domain/transaction/wager-transaction';
import { InvalidCursorError } from '@wallet/infrastructure/http/ledger-cursor';

describe('problemFor', () => {
  test.each([
    [
      'a wallet that does not exist',
      new WalletNotFoundError('w'),
      404,
      'WALLET_NOT_FOUND',
      false,
    ],
    [
      'a transaction that does not exist',
      new TransactionNotFoundError('t'),
      404,
      'TRANSACTION_NOT_FOUND',
      false,
    ],
    [
      'a duplicate wallet',
      new WalletAlreadyExistsError('p', 'BRL'),
      409,
      'WALLET_ALREADY_EXISTS',
      false,
    ],
    [
      'an idempotency key reused with another payload',
      new IdempotencyKeyConflictError('k'),
      409,
      'IDEMPOTENCY_KEY_CONFLICT',
      false,
    ],
    [
      'an external id reused with another key',
      new ExternalTransactionConflictError('p', 'e'),
      409,
      'EXTERNAL_TRANSACTION_CONFLICT',
      false,
    ],
    [
      'a duplicate insert that survived the retry',
      new DuplicateWagerTransactionError('IDEMPOTENCY_KEY'),
      409,
      'DUPLICATE_WAGER_TRANSACTION',
      true,
    ],
    [
      'an OPENING submitted from outside',
      new InvalidWagerTransactionError('UNSUPPORTED_KIND', 'x'),
      400,
      'UNSUPPORTED_KIND',
      false,
    ],
    [
      'a reversal without a reference',
      new InvalidWagerTransactionError('REFERENCE_REQUIRED', 'x'),
      400,
      'REFERENCE_REQUIRED',
      false,
    ],
    [
      'a BET with a reference',
      new InvalidWagerTransactionError('REFERENCE_NOT_ALLOWED', 'x'),
      400,
      'REFERENCE_NOT_ALLOWED',
      false,
    ],
    [
      'a zero BET',
      new InvalidWagerTransactionError('INVALID_AMOUNT', 'x'),
      400,
      'INVALID_AMOUNT',
      false,
    ],
    [
      'invalid money',
      new InvalidMoneyError('x'),
      400,
      'INVALID_PAYLOAD',
      false,
    ],
    [
      'an invalid body',
      new RequestValidationError('body', []),
      400,
      'INVALID_PAYLOAD',
      false,
    ],
    [
      'an invalid path parameter',
      new RequestValidationError('param', []),
      400,
      'INVALID_REQUEST',
      false,
    ],
    [
      'an invalid query string',
      new RequestValidationError('query', []),
      400,
      'INVALID_REQUEST',
      false,
    ],
    [
      'a missing idempotency key',
      new IdempotencyKeyRequiredError(),
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      false,
    ],
    [
      'an invalid ledger cursor',
      new InvalidCursorError(),
      400,
      'INVALID_CURSOR',
      false,
    ],
    [
      'a lock wait that timed out',
      new TransientFailure('lock_timeout'),
      503,
      'SERVICE_UNAVAILABLE',
      true,
    ],
    [
      'a lost database connection',
      new TransientFailure('connection'),
      503,
      'SERVICE_UNAVAILABLE',
      true,
    ],
    ['an unknown route', new NotFoundException(), 404, 'NOT_FOUND', false],
    [
      'a body that is too large',
      new PayloadTooLargeException(),
      413,
      'PAYLOAD_TOO_LARGE',
      false,
    ],
    [
      'a body the framework could not parse',
      new BadRequestException('JSON Parse error'),
      400,
      'INVALID_PAYLOAD',
      false,
    ],
    [
      'a method the framework does not allow',
      new MethodNotAllowedException(),
      405,
      'INVALID_REQUEST',
      false,
    ],
    ['a programming error', new Error('boom'), 500, 'INTERNAL_ERROR', true],
    [
      'a nested unit of work',
      new NestedUnitOfWorkError(),
      500,
      'INTERNAL_ERROR',
      true,
    ],
    [
      'a stale wallet version',
      new StaleWalletVersionError('w', 1),
      500,
      'INTERNAL_ERROR',
      true,
    ],
    [
      'a raw database error',
      Object.assign(new Error('duplicate key'), { code: '23505' }),
      500,
      'INTERNAL_ERROR',
      true,
    ],
  ] as const)('maps %s', (_, error, status, code, retryable) => {
    expect(problemFor(error)).toMatchObject({ status, code, retryable });
  });

  test('asks the client to come back after a second when the service is unavailable', () => {
    expect(problemFor(new TransientFailure('deadlock')).headers).toEqual({
      'retry-after': '1',
    });
  });

  test('lists the invalid fields of a request without echoing their values', () => {
    const problem = problemFor(
      new RequestValidationError('body', [
        { message: 'Invalid string', path: ['money', { key: 'amount' }] },
      ]),
    );

    expect(problem.errors).toEqual([
      { path: 'money.amount', message: 'Invalid string' },
    ]);
  });

  test('never exposes the message of an unexpected error', () => {
    const problem = problemFor(
      new Error('connection string postgresql://user:secret@db'),
    );

    expect(JSON.stringify(problem)).not.toContain('secret');
  });
});
