import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { waitUntil } from '@test/support/async';
import { commandFor, referencing } from '@test/support/commands';
import { walletInvariantViolations } from '@test/support/invariants';
import {
  type PersistenceHarness,
  createPersistenceHarness,
} from '@test/support/persistence';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { startWorkerProcess } from '@test/support/processes';
import {
  type TestQueues,
  createTestQueues,
  createTestSqsClient,
} from '@test/support/sqs';
import {
  type Wagering,
  createWagering,
  openWalletWith,
} from '@test/support/wagering';
import { WagerTransactionKind } from '@wallet/domain/transaction/wager-transaction';

let harness: PersistenceHarness;
let wagering: Wagering;
let sqs: SQSClient;
let queues: TestQueues;
const { Bet, Win, Refund, Rollback } = WagerTransactionKind;

beforeAll(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork, 3);
  wagering.clock.set(new Date('2026-01-01T00:00:00.000Z'));
  sqs = createTestSqsClient();
  queues = await createTestQueues(sqs);
});

afterAll(async () => {
  await queues.delete();
  sqs.destroy();
  await harness.close();
});

async function waitingCount(): Promise<number> {
  const [row] = await harness.database.sql`
    select count(*)::int as count from wager_transactions where status = 'PENDING_REFERENCE'`;
  return row.count;
}

describe('C7 on two worker processes', () => {
  test('settles late references and expires missing ones exactly once', async () => {
    const settled = [];
    for (let index = 0; index < 6; index += 1) {
      const wallet = await openWalletWith(wagering, '100.00');
      const bet = commandFor(wallet, Bet, '10.00');
      const refund = await wagering.submit.execute(referencing(bet, Refund));
      await wagering.submit.execute(bet);
      settled.push({ wallet, refund });
    }
    const orphanWallet = await openWalletWith(wagering, '100.00');
    const orphan = await wagering.submit.execute(
      referencing(commandFor(orphanWallet, Win, '10.00'), Rollback),
    );
    const environment = {
      DATABASE_URL: harness.database.url,
      ...queues.environment,
      OUTBOX_PUBLISHER_ENABLED: 'false',
      CONSUMER_ENABLED: 'false',
      REFERENCE_MAX_ATTEMPTS: '3',
      REFERENCE_BACKOFF_BASE_MS: '50',
      REFERENCE_BACKOFF_MAX_MS: '200',
      REFERENCE_SCHEDULER_POLL_INTERVAL_MS: '25',
      REFERENCE_SCHEDULER_BATCH_SIZE: '3',
      DB_POOL_SIZE: '3',
    };
    const workers = await Promise.all(
      [1, 2].map((number) =>
        startWorkerProcess({
          ...environment,
          INSTANCE_ID: `scheduler-${number}`,
        }),
      ),
    );

    try {
      await waitUntil(async () => (await waitingCount()) === 0, {
        timeoutMs: 20_000,
        description: 'every waiting transaction to settle',
      });
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
    }

    const events = await harness.database.sql`
      select payload -> 'data' ->> 'transactionId' as transaction_id, event_type
      from outbox_messages
      where event_type in ('WagerTransactionProcessed', 'WagerTransactionRejected')`;
    const count = (transactionId: string, eventType: string) =>
      events.filter(
        (event: { transaction_id: string; event_type: string }) =>
          event.transaction_id === transactionId &&
          event.event_type === eventType,
      ).length;
    for (const { wallet, refund } of settled) {
      expect(count(refund.transactionId, 'WagerTransactionProcessed')).toBe(1);
      expect(
        await walletInvariantViolations(harness.database.sql, wallet.id),
      ).toEqual([]);
    }
    const [orphanState] = await harness.database.sql`
      select status, failure_code from wager_transactions where id = ${orphan.transactionId}`;
    expect(orphanState).toEqual({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
    });
    expect(count(orphan.transactionId, 'WagerTransactionRejected')).toBe(1);
  });
});
