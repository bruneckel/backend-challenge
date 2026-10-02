import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { InboxMessage } from '@messaging/domain/inbox-message';
import { MikroOrmUnitOfWork } from '@platform/database/mikro-orm-unit-of-work';
import { gate, rejectionOf } from '@test/support/async';
import { commandFor, referencing } from '@test/support/commands';
import {
  type PersistenceHarness,
  createPersistenceHarness,
} from '@test/support/persistence';
import { RecordingMetrics } from '@test/support/recording-metrics';
import {
  START,
  type Wagering,
  createWagering,
  openWalletWith,
} from '@test/support/wagering';
import { WagerTransactionKind } from '@wallet/domain/transaction/wager-transaction';
import { createWageringScope } from '@wallet/infrastructure/persistence/wagering-scope';

let harness: PersistenceHarness;
let metrics: RecordingMetrics;
let wagering: Wagering;
const { Bet, Refund } = WagerTransactionKind;

beforeAll(async () => {
  harness = await createPersistenceHarness();
});

beforeEach(() => {
  metrics = new RecordingMetrics();
  wagering = createWagering(harness.unitOfWork, 3, { metrics });
});

afterAll(async () => {
  await harness.close();
});

const delivery = (messageId: string, payloadHash = 'c'.repeat(64)) =>
  InboxMessage.receive({
    messageId,
    consumerName: 'wager-transactions-consumer',
    payloadHash,
    receivedAt: START,
  });

describe('wagering instrumentation', () => {
  test('times each submission by outcome and measures the wallet lock wait', async () => {
    const wallet = await openWalletWith(wagering, '100.00');

    await wagering.submit.execute(commandFor(wallet, Bet, '10.00'));

    expect(
      metrics.observed('wager_processing_duration_seconds', {
        channel: 'http',
        kind: 'BET',
        outcome: 'PROCESSED',
      }),
    ).toHaveLength(1);
    expect(metrics.observed('wallet_lock_wait_seconds')).toHaveLength(1);
  });

  test('counts duplicate deliveries and message ids reused with another payload', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const messageId = `msg-${Bun.randomUUIDv7()}`;
    const request = commandFor(wallet, Bet, '10.00');
    await wagering.submit.executeDelivery(request, delivery(messageId));

    await wagering.submit.executeDelivery(request, delivery(messageId));
    await rejectionOf(
      wagering.submit.executeDelivery(
        commandFor(wallet, Bet, '11.00'),
        delivery(messageId, 'd'.repeat(64)),
      ),
    );

    expect(metrics.count('inbox_duplicates_total')).toBe(1);
    expect(
      metrics.count('idempotency_conflicts_total', {
        channel: 'sqs',
        type: 'message_id',
      }),
    ).toBe(1);
    expect(
      metrics.count('wager_transactions_total', {
        kind: 'BET',
        status: 'PROCESSED',
        channel: 'sqs',
      }),
    ).toBe(1);
  });

  test('counts the unit of work re-run after a racing insert of the same key', async () => {
    const first = await openWalletWith(wagering, '100.00');
    const second = await openWalletWith(wagering, '100.00');
    const inserted = gate();
    const release = gate();
    const slow = new MikroOrmUnitOfWork(
      harness.orm,
      (em) => {
        const scope = createWageringScope(em);
        const insert = scope.transactions.insert.bind(scope.transactions);
        scope.transactions.insert = async (transaction) => {
          await insert(transaction);
          inserted.open();
          await release.opened;
        };
        return scope;
      },
      { lockTimeoutMs: 5000 },
    );
    const key = `shared-${Bun.randomUUIDv7()}`;
    const winning = createWagering(slow).submit.execute(
      commandFor(first, Bet, '10.00', { idempotencyKey: key }),
    );
    await inserted.opened;
    const losing = rejectionOf(
      wagering.submit.execute(
        commandFor(second, Bet, '10.00', { idempotencyKey: key }),
      ),
    );
    await Bun.sleep(100);
    release.open();
    await winning;
    await losing;

    expect(
      metrics.count('db_transaction_retries_total', { sqlstate: '23505' }),
    ).toBe(1);
  });

  test('counts waiting transactions settled by the worker and the attempts of the others', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const bet = commandFor(wallet, Bet, '10.00');
    const settled = await wagering.submit.execute(referencing(bet, Refund));
    const waiting = await wagering.submit.execute(
      referencing(commandFor(wallet, Bet, '5.00'), Refund),
    );
    await wagering.submit.execute(bet);
    wagering.clock.set(new Date(START.getTime() + 2000));

    await wagering.processPendingReference.execute({
      transactionId: settled.transactionId,
      walletId: wallet.id,
    });
    await wagering.processPendingReference.execute({
      transactionId: waiting.transactionId,
      walletId: wallet.id,
    });

    expect(
      metrics.count('wager_transactions_total', {
        kind: 'REFUND',
        status: 'PROCESSED',
        channel: 'worker',
      }),
    ).toBe(1);
    expect(metrics.count('pending_reference_retries_total')).toBe(1);
  });
});
