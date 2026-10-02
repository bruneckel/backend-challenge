import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { TransientFailure } from '@shared/application/transient-failure';
import { commandFor, referencing } from '@test/support/commands';
import { walletInvariantViolations } from '@test/support/invariants';
import {
  type PersistenceHarness,
  createPersistenceHarness,
} from '@test/support/persistence';
import {
  START,
  type Wagering,
  createWagering,
  openWalletWith,
} from '@test/support/wagering';
import { FailPendingTransaction } from '@wallet/application/use-cases/fail-pending-transaction';
import type { ProcessPendingReference } from '@wallet/application/use-cases/process-pending-reference';
import { ResolvePendingReferences } from '@wallet/application/use-cases/resolve-pending-references';
import { WagerTransactionKind } from '@wallet/domain/transaction/wager-transaction';

let harness: PersistenceHarness;
let wagering: Wagering;
const { Bet, Refund } = WagerTransactionKind;
const later = (seconds: number) => new Date(START.getTime() + seconds * 1000);

beforeEach(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork, 3);
});

afterEach(async () => {
  await harness.close();
});

function resolver(
  process: Pick<
    ProcessPendingReference,
    'execute'
  > = wagering.processPendingReference,
): ResolvePendingReferences {
  return new ResolvePendingReferences({
    unitOfWork: harness.unitOfWork,
    clock: wagering.clock,
    process,
    fail: new FailPendingTransaction({
      unitOfWork: harness.unitOfWork,
      clock: wagering.clock,
    }),
    batchSize: 10,
    maxProcessingFailures: 3,
  });
}

async function waitingRefund() {
  const wallet = await openWalletWith(wagering, '100.00');
  const bet = commandFor(wallet, Bet, '10.00');
  const refund = await wagering.submit.execute(referencing(bet, Refund));
  return { wallet, bet, refund };
}

async function stateOf(transactionId: string) {
  const [row] = await harness.database.sql`
    select status, failure_code, reference_attempts,
      result_balance_amount::text as result_balance, next_reference_attempt_at
    from wager_transactions where id = ${transactionId}`;
  return row;
}

describe('ResolvePendingReferences', () => {
  test('settles the due waiting transactions and leaves the others for later', async () => {
    const settled = await waitingRefund();
    const waiting = await waitingRefund();
    await wagering.submit.execute(settled.bet);
    wagering.clock.set(later(2));

    const summary = await resolver().runOnce();

    expect(summary).toEqual({
      candidates: 2,
      processed: 1,
      rejected: 0,
      stillPending: 1,
      skipped: 0,
      failed: 0,
      transientFailures: 0,
    });
    expect((await stateOf(settled.refund.transactionId)).status).toBe(
      'PROCESSED',
    );
    expect(await stateOf(waiting.refund.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 1,
    });
    for (const { wallet } of [settled, waiting]) {
      expect(
        await walletInvariantViolations(harness.database.sql, wallet.id),
      ).toEqual([]);
    }
  });

  test('rejects a transaction whose reference never arrives once the attempts run out', async () => {
    const { refund } = await waitingRefund();
    const outcomes = [];

    for (const at of [later(60), later(120), later(180)]) {
      wagering.clock.set(at);
      outcomes.push(await resolver().runOnce());
    }

    expect(outcomes.map((summary) => summary.rejected)).toEqual([0, 0, 1]);
    expect(await stateOf(refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
    });
  });

  test('marks a transaction FAILED after repeated processing errors and keeps its observed balance', async () => {
    const { refund } = await waitingRefund();
    const broken = resolver({
      execute: async () => {
        throw new Error('row cannot be read');
      },
    });
    wagering.clock.set(later(2));

    const summaries = [
      await broken.runOnce(),
      await broken.runOnce(),
      await broken.runOnce(),
    ];

    expect(summaries.map((summary) => summary.failed)).toEqual([0, 0, 1]);
    expect(await stateOf(refund.transactionId)).toEqual({
      status: 'FAILED',
      failure_code: 'PROCESSING_FAILED',
      reference_attempts: 0,
      result_balance: '100.00',
      next_reference_attempt_at: null,
    });
  });

  test('does not count transient failures toward FAILED', async () => {
    const { refund } = await waitingRefund();
    const unavailable = resolver({
      execute: async () => {
        throw new TransientFailure('lock_timeout');
      },
    });
    wagering.clock.set(later(2));
    const summaries = [];

    for (let run = 0; run < 5; run += 1) {
      summaries.push(await unavailable.runOnce());
    }

    expect(summaries.every((summary) => summary.transientFailures === 1)).toBe(
      true,
    );
    expect((await stateOf(refund.transactionId)).status).toBe(
      'PENDING_REFERENCE',
    );
  });
});
