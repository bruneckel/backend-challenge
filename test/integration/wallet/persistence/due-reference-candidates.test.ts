import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  AT,
  type OpenedWallet,
  money,
  openedWallet,
  pendingTransaction,
  storeOpenedWallet,
} from '@test/support/domain-builders';
import {
  type PersistenceHarness,
  createPersistenceHarness,
} from '@test/support/persistence';
import {
  type WagerTransaction,
  WagerTransactionKind,
} from '@wallet/domain/transaction/wager-transaction';

let harness: PersistenceHarness;
let opened: OpenedWallet;

const minutesAfter = (minutes: number) =>
  new Date(AT.getTime() + minutes * 60_000);

beforeAll(async () => {
  harness = await createPersistenceHarness();
  opened = openedWallet('100.00');
  await harness.unitOfWork.run((scope) => storeOpenedWallet(scope, opened));
});

afterAll(async () => {
  await harness.close();
});

function waitingRefundDueAt(nextAttemptAt: Date): WagerTransaction {
  const refund = pendingTransaction(
    opened.wallet,
    WagerTransactionKind.Refund,
    '10.00',
    { referenceExternalTransactionId: 'ext-missing' },
  );
  refund.markPendingReference(money('100.00'), nextAttemptAt, AT);
  return refund;
}

const candidatesAt = (now: Date, limit: number) =>
  harness.unitOfWork.run(({ transactions }) =>
    transactions.findDueReferenceCandidates(now, limit),
  );

describe('due reference candidates', () => {
  test('lists the waiting transactions that are due, the oldest attempt first', async () => {
    const late = waitingRefundDueAt(minutesAfter(3));
    const early = waitingRefundDueAt(minutesAfter(1));
    const notDue = waitingRefundDueAt(minutesAfter(10));
    const settled = pendingTransaction(
      opened.wallet,
      WagerTransactionKind.Bet,
      '10.00',
    );
    settled.markProcessed(undefined, money('90.00'), AT);
    await harness.unitOfWork.run(async ({ transactions }) => {
      for (const transaction of [late, early, notDue, settled]) {
        await transactions.insert(transaction);
      }
    });

    expect(await candidatesAt(minutesAfter(5), 10)).toEqual([
      { transactionId: early.id, walletId: opened.wallet.id },
      { transactionId: late.id, walletId: opened.wallet.id },
    ]);
  });

  test('returns at most the requested number of candidates', async () => {
    const candidates = await candidatesAt(minutesAfter(5), 1);

    expect(candidates).toHaveLength(1);
  });
});
