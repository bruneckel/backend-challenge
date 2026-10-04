import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  AT,
  LATER,
  type OpenedWallet,
  money,
  openedWallet,
  pendingTransaction,
  storeOpenedWallet,
} from '@test/support/domain-builders';
import { gate, rejectionOf } from '@test/support/async';
import {
  type PersistenceHarness,
  createPersistenceHarness,
  plain,
} from '@test/support/persistence';
import type { WageringScope } from '@wallet/application/ports/wagering-scope';
import {
  DuplicateWagerTransactionError,
  StaleTransactionStateError,
} from '@wallet/application/ports/wager-transaction-repository';
import { FailureCode } from '@wallet/domain/transaction/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@wallet/domain/transaction/wager-transaction';

let harness: PersistenceHarness;
let opened: OpenedWallet;

beforeAll(async () => {
  harness = await createPersistenceHarness();
  opened = openedWallet('100.00');
  await harness.unitOfWork.run((scope) => storeOpenedWallet(scope, opened));
});

afterAll(async () => {
  await harness.close();
});

const run = <T>(work: (scope: WageringScope) => Promise<T>) =>
  harness.unitOfWork.run(work);

async function stored(
  transaction: WagerTransaction,
): Promise<WagerTransaction> {
  await run(({ transactions }) => transactions.insert(transaction));
  return transaction;
}

function processedBet(amount = '10.00'): WagerTransaction {
  const bet = pendingTransaction(
    opened.wallet,
    WagerTransactionKind.Bet,
    amount,
  );
  bet.markProcessed(undefined, money('90.00'), LATER);
  return bet;
}

function waitingRefund(
  referenceExternalTransactionId = 'ext-missing',
  amount = '10.00',
): WagerTransaction {
  const refund = pendingTransaction(
    opened.wallet,
    WagerTransactionKind.Refund,
    amount,
    { referenceExternalTransactionId },
  );
  refund.markPendingReference(money('100.00'), LATER, AT);
  return refund;
}

describe('MikroOrmWagerTransactionRepository', () => {
  test('round-trips the OPENING of a wallet', async () => {
    const found = await run(({ transactions }) =>
      transactions.findById(opened.opening!.id),
    );

    expect(plain(found?.toState())).toEqual(plain(opened.opening!.toState()));
  });

  test.each([
    ['processed BET', () => processedBet()],
    [
      'rejected BET',
      () => {
        const bet = pendingTransaction(
          opened.wallet,
          WagerTransactionKind.Bet,
          '500.00',
        );
        bet.reject(FailureCode.InsufficientFunds, money('100.00'), LATER);
        return bet;
      },
    ],
    [
      'failed BET',
      () => {
        const bet = pendingTransaction(
          opened.wallet,
          WagerTransactionKind.Bet,
          '10.00',
        );
        bet.fail(FailureCode.ProcessingFailed, LATER);
        return bet;
      },
    ],
    [
      'zero LOSS',
      () => {
        const loss = pendingTransaction(
          opened.wallet,
          WagerTransactionKind.Loss,
          '0.00',
        );
        loss.markProcessed(undefined, money('100.00'), LATER);
        return loss;
      },
    ],
    [
      'REFUND waiting for its second attempt',
      () => {
        const refund = waitingRefund();
        refund.scheduleReferenceRetry(LATER, LATER);
        return refund;
      },
    ],
  ] as const)('round-trips a %s', async (_, build) => {
    const transaction = await stored(build());

    const found = await run(({ transactions }) =>
      transactions.findById(transaction.id),
    );

    expect(plain(found?.toState())).toEqual(plain(transaction.toState()));
  });

  test('round-trips a processed reversal that points to its reference', async () => {
    const bet = await stored(processedBet());
    const refund = pendingTransaction(
      opened.wallet,
      WagerTransactionKind.Refund,
      '10.00',
      {
        referenceExternalTransactionId: bet.externalTransactionId,
      },
    );
    refund.markProcessed(bet.id, money('100.00'), LATER);
    await stored(refund);

    const found = await run(({ transactions }) =>
      transactions.findById(refund.id),
    );

    expect(plain(found?.toState())).toEqual(plain(refund.toState()));
    expect(found?.referenceTransactionId).toBe(bet.id);
  });

  test('finds a transaction by provider and idempotency key and by provider and external id', async () => {
    const bet = await stored(processedBet());

    const byKey = await run(({ transactions }) =>
      transactions.findByIdempotencyKey(bet.providerId, bet.idempotencyKey),
    );
    const byKeyOfAnotherProvider = await run(({ transactions }) =>
      transactions.findByIdempotencyKey('provider-b', bet.idempotencyKey),
    );
    const byExternalId = await run(({ transactions }) =>
      transactions.findByExternalId(bet.providerId, bet.externalTransactionId),
    );

    expect(byKey?.id).toBe(bet.id);
    expect(byKeyOfAnotherProvider).toBeNull();
    expect(byExternalId?.id).toBe(bet.id);
  });

  test('returns null for unknown ids and keys', async () => {
    expect(
      await run(({ transactions }) =>
        transactions.findById(Bun.randomUUIDv7()),
      ),
    ).toBeNull();
    expect(
      await run(({ transactions }) =>
        transactions.findByIdempotencyKey('provider-a', 'unknown-key'),
      ),
    ).toBeNull();
    expect(
      await run(({ transactions }) =>
        transactions.findByExternalId('provider-a', 'unknown'),
      ),
    ).toBeNull();
    expect(
      await run(({ transactions }) =>
        transactions.lockById(Bun.randomUUIDv7()),
      ),
    ).toBeNull();
  });

  test('reports a reused idempotency key as a duplicate', async () => {
    const bet = await stored(processedBet());
    const reused = pendingTransaction(
      opened.wallet,
      WagerTransactionKind.Bet,
      '10.00',
      { idempotencyKey: bet.idempotencyKey },
    );
    reused.markProcessed(undefined, money('90.00'), LATER);

    const insert = run(({ transactions }) => transactions.insert(reused));

    const failure = await rejectionOf(insert);
    expect(failure).toBeInstanceOf(DuplicateWagerTransactionError);
    expect(failure).toMatchObject({ key: 'IDEMPOTENCY_KEY' });
  });

  test('reports a reused external id of the same provider as a duplicate', async () => {
    const bet = await stored(processedBet());
    const reused = pendingTransaction(
      opened.wallet,
      WagerTransactionKind.Bet,
      '10.00',
      {
        externalTransactionId: bet.externalTransactionId,
      },
    );
    reused.markProcessed(undefined, money('90.00'), LATER);

    const insert = run(({ transactions }) => transactions.insert(reused));

    const failure = await rejectionOf(insert);
    expect(failure).toBeInstanceOf(DuplicateWagerTransactionError);
    expect(failure).toMatchObject({ key: 'EXTERNAL_TRANSACTION' });
  });

  test('persists the outcome of a waiting transaction', async () => {
    const bet = await stored(processedBet());
    const refund = await stored(waitingRefund(bet.externalTransactionId));

    await run(async ({ transactions }) => {
      const locked = await transactions.lockById(refund.id);
      locked!.markProcessed(bet.id, money('100.00'), LATER);
      await transactions.updatePending(locked!);
    });

    const found = await run(({ transactions }) =>
      transactions.findById(refund.id),
    );
    expect(found?.status).toBe(WagerTransactionStatus.Processed);
    expect(found?.referenceTransactionId).toBe(bet.id);
    expect(found?.processedAt).toEqual(LATER);
    expect(found?.nextReferenceAttemptAt).toBeUndefined();
  });

  test('persists another attempt of a waiting transaction', async () => {
    const refund = await stored(waitingRefund());
    const nextAttempt = new Date('2026-10-02T12:10:00.000Z');

    await run(async ({ transactions }) => {
      const locked = await transactions.lockById(refund.id);
      locked!.scheduleReferenceRetry(nextAttempt, LATER);
      await transactions.updatePending(locked!);
    });

    const found = await run(({ transactions }) =>
      transactions.findById(refund.id),
    );
    expect(found?.status).toBe(WagerTransactionStatus.PendingReference);
    expect(found?.referenceAttempts).toBe(1);
    expect(found?.nextReferenceAttemptAt).toEqual(nextAttempt);
  });

  test('refuses to overwrite a transaction that is no longer waiting', async () => {
    const refund = await stored(waitingRefund());
    const staleCopy = WagerTransaction.rehydrate(refund.toState());
    await run(async ({ transactions }) => {
      const locked = await transactions.lockById(refund.id);
      locked!.reject(FailureCode.ReferenceNotFound, money('100.00'), LATER);
      await transactions.updatePending(locked!);
    });
    staleCopy.fail(FailureCode.ProcessingFailed, LATER);

    const update = run(({ transactions }) =>
      transactions.updatePending(staleCopy),
    );

    expect(await rejectionOf(update)).toBeInstanceOf(
      StaleTransactionStateError,
    );
    const found = await run(({ transactions }) =>
      transactions.findById(refund.id),
    );
    expect(found?.status).toBe(WagerTransactionStatus.Rejected);
  });

  test('knows whether a reference already has a processed reversal of a kind', async () => {
    const bet = await stored(processedBet());
    const refund = pendingTransaction(
      opened.wallet,
      WagerTransactionKind.Refund,
      '10.00',
      {
        referenceExternalTransactionId: bet.externalTransactionId,
      },
    );
    refund.markProcessed(bet.id, money('100.00'), LATER);

    const before = await run(({ transactions }) =>
      transactions.hasProcessedReversal(bet.id, WagerTransactionKind.Refund),
    );
    await stored(refund);
    const afterRefund = await run(({ transactions }) =>
      transactions.hasProcessedReversal(bet.id, WagerTransactionKind.Refund),
    );
    const afterRollback = await run(({ transactions }) =>
      transactions.hasProcessedReversal(bet.id, WagerTransactionKind.Rollback),
    );

    expect([before, afterRefund, afterRollback]).toEqual([false, true, false]);
  });

  test('makes a second locker of a transaction wait for the first commit', async () => {
    const refund = await stored(waitingRefund());
    const firstLocked = gate();
    const order: string[] = [];

    const first = run(async ({ transactions }) => {
      await transactions.lockById(refund.id);
      order.push('first locked');
      firstLocked.open();
      await Bun.sleep(150);
      order.push('first committing');
    });
    await firstLocked.opened;
    const second = run(async ({ transactions }) => {
      await transactions.lockById(refund.id);
      order.push('second locked');
    });
    await Promise.all([first, second]);

    expect(order).toEqual([
      'first locked',
      'first committing',
      'second locked',
    ]);
  });
});
