import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
import { ResolvePendingReferences } from '@wallet/application/use-cases/resolve-pending-references';
import { WagerTransactionKind } from '@wallet/domain/transaction/wager-transaction';

let harness: PersistenceHarness;
let wagering: Wagering;
const { Bet, Win, Refund, Rollback } = WagerTransactionKind;
const later = (seconds: number) => new Date(START.getTime() + seconds * 1000);

beforeEach(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork, 3);
});

afterEach(async () => {
  await harness.close();
});

const scheduler = () =>
  new ResolvePendingReferences({
    unitOfWork: harness.unitOfWork,
    clock: wagering.clock,
    process: wagering.processPendingReference,
    fail: new FailPendingTransaction({
      unitOfWork: harness.unitOfWork,
      clock: wagering.clock,
    }),
    batchSize: 5,
    maxProcessingFailures: 3,
  });

async function drainWithTwoSchedulers(): Promise<void> {
  const [first, second] = [scheduler(), scheduler()];
  for (;;) {
    const summaries = await Promise.all([first.runOnce(), second.runOnce()]);
    if (summaries.every((summary) => summary.candidates === 0)) {
      return;
    }
  }
}

async function eventsAbout(transactionId: string, eventType: string) {
  const [row] = await harness.database.sql`
    select count(*)::int as count from outbox_messages
    where event_type = ${eventType} and payload -> 'data' ->> 'transactionId' = ${transactionId}`;
  return row.count;
}

async function stateOf(transactionId: string) {
  const [row] = await harness.database.sql`
    select status, failure_code from wager_transactions where id = ${transactionId}`;
  return row;
}

describe('C7 references that arrive out of order', () => {
  test('two schedulers settle REFUNDs that arrived before their BETs exactly once', async () => {
    const cases = [];
    for (let index = 0; index < 8; index += 1) {
      const wallet = await openWalletWith(wagering, '100.00');
      const bet = commandFor(wallet, Bet, '10.00');
      const refund = await wagering.submit.execute(referencing(bet, Refund));
      cases.push({ wallet, bet, refund });
    }
    for (const { bet } of cases) {
      await wagering.submit.execute(bet);
    }
    wagering.clock.set(later(2));

    await drainWithTwoSchedulers();

    for (const { wallet, refund } of cases) {
      expect(await stateOf(refund.transactionId)).toEqual({
        status: 'PROCESSED',
        failure_code: null,
      });
      expect(
        await eventsAbout(refund.transactionId, 'WagerTransactionProcessed'),
      ).toBe(1);
      expect((await wagering.queries.getWallet(wallet.id)).balance.amount).toBe(
        '100.00',
      );
      expect(
        await walletInvariantViolations(harness.database.sql, wallet.id),
      ).toEqual([]);
    }
  });

  test('two schedulers reject a ROLLBACK whose reference never arrives and announce it once', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const win = commandFor(wallet, Win, '10.00');
    const rollback = await wagering.submit.execute(referencing(win, Rollback));

    for (const at of [later(60), later(120), later(180), later(240)]) {
      wagering.clock.set(at);
      await drainWithTwoSchedulers();
    }

    expect(await stateOf(rollback.transactionId)).toEqual({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
    });
    expect(
      await eventsAbout(rollback.transactionId, 'WagerTransactionRejected'),
    ).toBe(1);
    expect(
      await walletInvariantViolations(harness.database.sql, wallet.id),
    ).toEqual([]);
  });

  test('a late reference settles correctly while other operations hit the same wallet', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const bet = commandFor(wallet, Bet, '10.00');
    const refund = await wagering.submit.execute(referencing(bet, Refund));
    wagering.clock.set(later(2));
    let stop = false;
    const schedulers = [scheduler(), scheduler()].map(async (instance) => {
      while (!stop) {
        await instance.runOnce();
        await Bun.sleep(5);
      }
    });

    await Promise.all([
      wagering.submit.execute(bet),
      ...Array.from({ length: 20 }, () =>
        wagering.submit.execute(commandFor(wallet, Bet, '1.00')),
      ),
      ...Array.from({ length: 5 }, () =>
        wagering.submit.execute(commandFor(wallet, Win, '2.00')),
      ),
    ]);
    await Bun.sleep(100);
    stop = true;
    await Promise.all(schedulers);
    await drainWithTwoSchedulers();

    expect((await stateOf(refund.transactionId)).status).toBe('PROCESSED');
    expect(
      await eventsAbout(refund.transactionId, 'WagerTransactionProcessed'),
    ).toBe(1);
    expect((await wagering.queries.getWallet(wallet.id)).balance.amount).toBe(
      '90.00',
    );
    expect(
      await walletInvariantViolations(harness.database.sql, wallet.id),
    ).toEqual([]);
  });
});
