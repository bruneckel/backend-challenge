import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
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
import type { WalletView } from '@wallet/application/views';
import { WagerTransactionKind } from '@wallet/domain/transaction/wager-transaction';

let harness: PersistenceHarness;
let wagering: Wagering;
const touchedWallets = new Set<string>();
const { Bet, Refund } = WagerTransactionKind;
const later = (seconds: number) => new Date(START.getTime() + seconds * 1000);

beforeAll(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork, 3);
});

beforeEach(() => {
  wagering.clock.set(START);
});

afterEach(async () => {
  for (const walletId of touchedWallets) {
    expect(
      await walletInvariantViolations(harness.database.sql, walletId),
    ).toEqual([]);
  }
  touchedWallets.clear();
});

afterAll(async () => {
  await harness.close();
});

async function waitingRefund() {
  const wallet: WalletView = await openWalletWith(wagering, '100.00');
  touchedWallets.add(wallet.id);
  const bet = commandFor(wallet, Bet, '10.00');
  const refund = await wagering.submit.execute(referencing(bet, Refund));
  return {
    wallet,
    bet,
    refund,
    candidate: { transactionId: refund.transactionId, walletId: wallet.id },
  };
}

async function storedTransaction(transactionId: string) {
  const [row] = await harness.database.sql`
    select status, failure_code, reference_transaction_id, reference_attempts, next_reference_attempt_at,
      result_balance_amount::text as result_balance
    from wager_transactions where id = ${transactionId}`;
  return row;
}

async function eventTypes(walletId: string): Promise<string[]> {
  const rows = await harness.database.sql`
    select event_type from outbox_messages where message_group_id = ${walletId} order by id`;
  return rows.map((row: { event_type: string }) => row.event_type);
}

describe('ProcessPendingReference', () => {
  test('applies a waiting REFUND once its BET is processed', async () => {
    const { wallet, bet, refund, candidate } = await waitingRefund();
    const betResult = await wagering.submit.execute(bet);
    wagering.clock.set(later(2));

    const outcome = await wagering.processPendingReference.execute(candidate);

    expect(outcome).toBe('processed');
    expect(await storedTransaction(refund.transactionId)).toEqual({
      status: 'PROCESSED',
      failure_code: null,
      reference_transaction_id: betResult.transactionId,
      reference_attempts: 0,
      next_reference_attempt_at: null,
      result_balance: '100.00',
    });
    expect((await eventTypes(wallet.id)).slice(-2)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('leaves a waiting transaction alone until it is due', async () => {
    const { candidate, refund } = await waitingRefund();

    expect(await wagering.processPendingReference.execute(candidate)).toBe(
      'skipped',
    );
    expect(await storedTransaction(refund.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 0,
    });
  });

  test('schedules another attempt with a longer backoff while the reference is missing', async () => {
    const { wallet, candidate, refund } = await waitingRefund();
    const eventsBefore = await eventTypes(wallet.id);
    wagering.clock.set(later(2));

    const outcome = await wagering.processPendingReference.execute(candidate);

    expect(outcome).toBe('still_pending');
    expect(await storedTransaction(refund.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 1,
      next_reference_attempt_at: later(4),
    });
    expect(await eventTypes(wallet.id)).toEqual(eventsBefore);
  });

  test('rejects with REFERENCE_NOT_FOUND once the attempts run out and publishes the rejection', async () => {
    const { wallet, candidate, refund } = await waitingRefund();
    const outcomes: string[] = [];

    for (const at of [later(60), later(120), later(180)]) {
      wagering.clock.set(at);
      outcomes.push(await wagering.processPendingReference.execute(candidate));
    }

    expect(outcomes).toEqual(['still_pending', 'still_pending', 'rejected']);
    expect(await storedTransaction(refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      next_reference_attempt_at: null,
      result_balance: '100.00',
    });
    expect((await eventTypes(wallet.id)).at(-1)).toBe(
      'WagerTransactionRejected',
    );
  });

  test('lets only one of two concurrent workers settle the same candidate', async () => {
    const { bet, candidate } = await waitingRefund();
    await wagering.submit.execute(bet);
    wagering.clock.set(later(2));

    const outcomes = await Promise.all([
      wagering.processPendingReference.execute(candidate),
      wagering.processPendingReference.execute(candidate),
    ]);

    expect(outcomes.sort()).toEqual(['processed', 'skipped']);
  });

  test('skips a candidate that is not waiting for a reference', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    touchedWallets.add(wallet.id);
    const bet = await wagering.submit.execute(commandFor(wallet, Bet, '10.00'));
    wagering.clock.set(later(3600));

    expect(
      await wagering.processPendingReference.execute({
        transactionId: bet.transactionId,
        walletId: wallet.id,
      }),
    ).toBe('skipped');
  });
});
