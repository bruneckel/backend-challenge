import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { MessageIdConflictError } from '@messaging/application/errors';
import { InboxMessage } from '@messaging/domain/inbox-message';
import { MikroOrmUnitOfWork } from '@platform/database/mikro-orm-unit-of-work';
import { gate, rejectionOf } from '@test/support/async';
import { commandFor as command, referencing } from '@test/support/commands';
import { walletInvariantViolations } from '@test/support/invariants';
import { type PersistenceHarness, createPersistenceHarness } from '@test/support/persistence';
import { START, type Wagering, createWagering } from '@test/support/wagering';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  WalletNotFoundError,
} from '@wallet/application/errors';
import type { SubmitWagerTransactionCommand } from '@wallet/application/use-cases/submit-wager-transaction';
import type { WalletView } from '@wallet/application/views';
import {
  InvalidWagerTransactionError,
  type SubmittableKind,
  WagerTransactionKind,
} from '@wallet/domain/transaction/wager-transaction';
import { createWageringScope } from '@wallet/infrastructure/persistence/wagering-scope';

let harness: PersistenceHarness;
let wagering: Wagering;
const touchedWallets = new Set<string>();
const { Bet, Win, Loss, Refund, Rollback } = WagerTransactionKind;

beforeAll(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork);
});

afterEach(async () => {
  for (const walletId of touchedWallets) {
    expect(await walletInvariantViolations(harness.database.sql, walletId)).toEqual([]);
  }
  touchedWallets.clear();
});

afterAll(async () => {
  await harness.close();
});

async function walletWith(amount = '100.00', currency = 'BRL'): Promise<WalletView> {
  const wallet = await wagering.openWallet.execute({
    playerId: Bun.randomUUIDv7(),
    initialBalance: { amount, currency },
    correlationId: 'correlation-1',
  });
  touchedWallets.add(wallet.id);
  return wallet;
}

const submit = (input: SubmitWagerTransactionCommand) => wagering.submit.execute(input);

async function storedWallet(walletId: string) {
  const [row] = await harness.database.sql`
    select balance_amount::text as balance, version from wallets where id = ${walletId}`;
  return row;
}

async function eventTypes(walletId: string): Promise<string[]> {
  const rows = await harness.database.sql`
    select event_type from outbox_messages where message_group_id = ${walletId} order by id`;
  return rows.map((row: { event_type: string }) => row.event_type);
}

async function rowCounts(walletId: string) {
  const [counts] = await harness.database.sql`
    select (select count(*)::int from wager_transactions where wallet_id = ${walletId}) as transactions,
      (select count(*)::int from wallet_ledger_entries where wallet_id = ${walletId}) as entries,
      (select count(*)::int from outbox_messages where message_group_id = ${walletId}) as events`;
  return counts;
}

describe('SubmitWagerTransaction outcomes', () => {
  test('debits a BET and answers with the balance after it', async () => {
    const wallet = await walletWith('100.00');

    const result = await submit(command(wallet, Bet, '25.00'));

    expect(result).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await storedWallet(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    expect(await eventTypes(wallet.id)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('debits a BET down to a zero balance', async () => {
    const wallet = await walletWith('100.00');

    const result = await submit(command(wallet, Bet, '100.00'));

    expect(result.balance).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  test('rejects a BET larger than the balance with INSUFFICIENT_FUNDS and keeps the balance', async () => {
    const wallet = await walletWith('100.00');

    const result = await submit(command(wallet, Bet, '100.01'));

    expect(result).toEqual({
      transactionId: expect.any(String),
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await storedWallet(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    expect((await eventTypes(wallet.id)).slice(2)).toEqual(['WagerTransactionRejected']);
  });

  test('credits a WIN', async () => {
    const wallet = await walletWith('100.00');

    const result = await submit(command(wallet, Win, '30.00'));

    expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '130.00', currency: 'BRL' } });
  });

  test('records a LOSS without moving the balance or writing the ledger', async () => {
    const wallet = await walletWith('100.00');

    const result = await submit(command(wallet, Loss, '0.00'));

    expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00', currency: 'BRL' } });
    expect(await storedWallet(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    expect((await eventTypes(wallet.id)).slice(2)).toEqual(['WagerTransactionProcessed']);
  });

  test('refunds a processed BET and links the reversal to it', async () => {
    const wallet = await walletWith('100.00');
    const bet = command(wallet, Bet, '40.00');
    const betResult = await submit(bet);

    const result = await submit(referencing(bet, Refund));

    expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00', currency: 'BRL' } });
    const [refund] = await harness.database.sql`
      select reference_transaction_id from wager_transactions where id = ${result.transactionId}`;
    expect(refund.reference_transaction_id).toBe(betResult.transactionId);
  });

  test('rolls back a WIN with a debit of the same amount', async () => {
    const wallet = await walletWith('100.00');
    const bet = command(wallet, Bet, '10.00');
    await submit(bet);
    const win = referencing(bet, Win, '30.00');
    await submit(win);

    const result = await submit(referencing(win, Rollback));

    expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '90.00', currency: 'BRL' } });
  });

  test('rejects a second REFUND of the same BET with REFERENCE_ALREADY_REVERSED', async () => {
    const wallet = await walletWith('100.00');
    const bet = command(wallet, Bet, '40.00');
    await submit(bet);
    await submit(referencing(bet, Refund));

    const result = await submit(referencing(bet, Refund));

    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' });
  });

  test('rejects a ROLLBACK that would overdraw the wallet with REVERSAL_INSUFFICIENT_FUNDS', async () => {
    const wallet = await walletWith('100.00');
    const bet = command(wallet, Bet, '50.00');
    await submit(bet);
    const refund = referencing(bet, Refund);
    await submit(refund);
    await submit(command(wallet, Bet, '100.00'));

    const result = await submit(referencing(refund, Rollback));

    expect(result).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
      balance: { amount: '0.00', currency: 'BRL' },
    });
  });

  test.each([
    ['another player', 'WALLET_PLAYER_MISMATCH', { playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1' }],
    ['another currency', 'CURRENCY_MISMATCH', { money: { amount: '10.00', currency: 'USD' } }],
  ] as const)('rejects a BET from %s with %s', async (_, failureCode, overrides) => {
    const wallet = await walletWith('100.00');

    const result = await submit(command(wallet, Bet, '10.00', overrides));

    expect(result).toMatchObject({ status: 'REJECTED', failureCode, balance: { amount: '100.00', currency: 'BRL' } });
  });

  test('rejects a REFUND of a BET from another round with REFERENCE_MISMATCH', async () => {
    const wallet = await walletWith('100.00');
    const bet = command(wallet, Bet, '10.00');
    await submit(bet);

    const result = await submit({ ...referencing(bet, Refund), roundId: 'round-2' });

    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_MISMATCH' });
  });

  test('rejects a REFUND of a WIN with INVALID_REFERENCE_KIND', async () => {
    const wallet = await walletWith('100.00');
    const win = command(wallet, Win, '10.00');
    await submit(win);

    const result = await submit(referencing(win, Refund));

    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'INVALID_REFERENCE_KIND' });
  });

  test('rejects a REFUND for another amount with REFERENCE_AMOUNT_MISMATCH', async () => {
    const wallet = await walletWith('100.00');
    const bet = command(wallet, Bet, '10.00');
    await submit(bet);

    const result = await submit(referencing(bet, Refund, '9.99'));

    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_AMOUNT_MISMATCH' });
  });

  test('rejects a REFUND of a rejected BET with REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await walletWith('100.00');
    const bet = command(wallet, Bet, '500.00');
    await submit(bet);

    const result = await submit(referencing(bet, Refund));

    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_PROCESSED' });
  });

  test('keeps a REFUND that arrives before its BET waiting for the reference', async () => {
    const wallet = await walletWith('100.00');
    const bet = command(wallet, Bet, '10.00');

    const result = await submit(referencing(bet, Refund));

    expect(result).toEqual({
      transactionId: expect.any(String),
      status: 'PENDING_REFERENCE',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect((await eventTypes(wallet.id)).slice(2)).toEqual(['WagerTransactionPendingReference']);
    const [row] = await harness.database.sql`
      select next_reference_attempt_at from wager_transactions where id = ${result.transactionId}`;
    expect(row.next_reference_attempt_at).toEqual(new Date(START.getTime() + 1000));
  });

  test('keeps a ROLLBACK of a WIN that is itself waiting', async () => {
    const wallet = await walletWith('100.00');
    const bet = command(wallet, Bet, '10.00');
    const win = referencing(bet, Win, '30.00');
    await submit(win);

    const result = await submit(referencing(win, Rollback));

    expect(result.status).toBe('PENDING_REFERENCE');
  });
});

describe('SubmitWagerTransaction idempotency', () => {
  test('replays an identical request with the original result even after the balance changed', async () => {
    const wallet = await walletWith('100.00');
    const bet = command(wallet, Bet, '25.00');
    const original = await submit(bet);
    await submit(command(wallet, Bet, '50.00'));
    const before = await rowCounts(wallet.id);

    const replay = await submit(bet);

    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(await rowCounts(wallet.id)).toEqual(before);
  });

  test('replays a rejected request with its original failure', async () => {
    const wallet = await walletWith('100.00');
    const bet = command(wallet, Bet, '150.00');
    const original = await submit(bet);
    await submit(command(wallet, Win, '100.00'));

    expect(await submit(bet)).toEqual({ ...original, idempotentReplay: true });
  });

  test('refuses the same idempotency key with a different payload and writes nothing', async () => {
    const wallet = await walletWith('100.00');
    const bet = command(wallet, Bet, '25.00');
    await submit(bet);
    const before = await rowCounts(wallet.id);

    const failure = await rejectionOf(submit({ ...bet, money: { amount: '26.00', currency: 'BRL' } }));

    expect(failure).toBeInstanceOf(IdempotencyKeyConflictError);
    expect(await rowCounts(wallet.id)).toEqual(before);
  });

  test('refuses a new idempotency key for an external id that was already used', async () => {
    const wallet = await walletWith('100.00');
    const bet = command(wallet, Bet, '25.00');
    await submit(bet);

    const failure = await rejectionOf(submit({ ...bet, idempotencyKey: 'regenerated-key' }));

    expect(failure).toBeInstanceOf(ExternalTransactionConflictError);
  });

  test('refuses a transaction for an unknown wallet and writes nothing', async () => {
    const wallet = await walletWith('100.00');

    const failure = await rejectionOf(submit(command(wallet, Bet, '10.00', { walletId: Bun.randomUUIDv7() })));

    expect(failure).toBeInstanceOf(WalletNotFoundError);
    expect(await rowCounts(wallet.id)).toMatchObject({ transactions: 1, entries: 1 });
  });

  test.each([
    ['an OPENING', 'UNSUPPORTED_KIND', { kind: WagerTransactionKind.Opening as unknown as SubmittableKind }],
    ['a REFUND without a reference', 'REFERENCE_REQUIRED', { kind: Refund }],
    ['a BET with a reference', 'REFERENCE_NOT_ALLOWED', { referenceExternalTransactionId: 'ext-1' }],
    ['a zero BET', 'INVALID_AMOUNT', { money: { amount: '0.00', currency: 'BRL' } }],
  ] as const)('refuses %s before touching the database', async (_, code, overrides) => {
    const wallet = await walletWith('100.00');

    const failure = await rejectionOf(submit(command(wallet, Bet, '10.00', overrides)));

    expect(failure).toBeInstanceOf(InvalidWagerTransactionError);
    expect(failure).toMatchObject({ code });
    expect(await rowCounts(wallet.id)).toMatchObject({ transactions: 1 });
  });

  test('resolves a racing insert of the same key on another wallet as a conflict', async () => {
    const first = await walletWith('100.00');
    const second = await walletWith('100.00');
    const inserted = gate();
    const release = gate();
    const slowUnitOfWork = new MikroOrmUnitOfWork(
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
    const slowSubmit = createWagering(slowUnitOfWork).submit;
    const winner = command(first, Bet, '10.00', { idempotencyKey: `shared-${Bun.randomUUIDv7()}` });
    const loser = command(second, Bet, '10.00', { idempotencyKey: winner.idempotencyKey });

    const winning = slowSubmit.execute(winner);
    await inserted.opened;
    const losing = rejectionOf(submit(loser));
    await Bun.sleep(100);
    release.open();

    expect((await winning).status).toBe('PROCESSED');
    expect(await losing).toBeInstanceOf(IdempotencyKeyConflictError);
    expect(await rowCounts(second.id)).toMatchObject({ transactions: 1, entries: 1 });
  });
});

describe('SubmitWagerTransaction atomicity', () => {
  test('writes nothing when the unit of work fails right before commit', async () => {
    const wallet = await walletWith('100.00');
    const failingUnitOfWork = new MikroOrmUnitOfWork(
      harness.orm,
      (em) => {
        const scope = createWageringScope(em);
        const enqueue = scope.outbox.enqueue.bind(scope.outbox);
        scope.outbox.enqueue = async (messages) => {
          await enqueue(messages);
          throw new Error('crash before commit');
        };
        return scope;
      },
      { lockTimeoutMs: 2000 },
    );
    const failingSubmit = createWagering(failingUnitOfWork).submit;
    const bet = command(wallet, Bet, '25.00');
    const message = InboxMessage.receive({ messageId: Bun.randomUUIDv7(), consumerName: 'wager-commands', payloadHash: 'b'.repeat(64), receivedAt: START });
    const before = await rowCounts(wallet.id);

    const failure = await rejectionOf(failingSubmit.executeDelivery(bet, message));

    expect(failure).toMatchObject({ message: 'crash before commit' });
    expect(await rowCounts(wallet.id)).toEqual(before);
    expect(await storedWallet(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    const inbox = await harness.database.sql`select 1 from inbox_messages where message_id = ${message.messageId}`;
    expect(inbox).toHaveLength(0);
  });
});

describe('SubmitWagerTransaction deliveries', () => {
  const delivery = (messageId: string = Bun.randomUUIDv7(), payloadHash = 'c'.repeat(64)) =>
    InboxMessage.receive({ messageId, consumerName: 'wager-commands', payloadHash, receivedAt: START });

  async function inboxRow(messageId: string) {
    const [row] = await harness.database.sql`
      select transaction_id, processed_at from inbox_messages where message_id = ${messageId}`;
    return row;
  }

  test('records the delivery in the inbox together with its effect', async () => {
    const wallet = await walletWith('100.00');
    const message = delivery();

    const outcome = await wagering.submit.executeDelivery(command(wallet, Bet, '25.00'), message);

    expect(outcome.type).toBe('handled');
    const transactionId = outcome.type === 'handled' ? outcome.result.transactionId : undefined;
    expect(await inboxRow(message.messageId)).toEqual({ transaction_id: transactionId, processed_at: START });
  });

  test('acknowledges a redelivery of the same message without a second effect', async () => {
    const wallet = await walletWith('100.00');
    const bet = command(wallet, Bet, '25.00');
    const message = delivery();
    await wagering.submit.executeDelivery(bet, message);

    const outcome = await wagering.submit.executeDelivery(bet, delivery(message.messageId));

    expect(outcome).toEqual({ type: 'duplicate' });
    expect(await storedWallet(wallet.id)).toEqual({ balance: '75.00', version: 2 });
  });

  test('refuses a message id reused with a different payload', async () => {
    const wallet = await walletWith('100.00');
    const message = delivery();
    await wagering.submit.executeDelivery(command(wallet, Bet, '25.00'), message);

    const failure = await rejectionOf(
      wagering.submit.executeDelivery(command(wallet, Bet, '30.00'), delivery(message.messageId, 'd'.repeat(64))),
    );

    expect(failure).toBeInstanceOf(MessageIdConflictError);
    expect(await storedWallet(wallet.id)).toEqual({ balance: '75.00', version: 2 });
  });

  test('records another message for an operation already applied as a replay', async () => {
    const wallet = await walletWith('100.00');
    const bet = command(wallet, Bet, '25.00');
    const original = await submit(bet);
    const message = delivery();

    const outcome = await wagering.submit.executeDelivery(bet, message);

    expect(outcome).toEqual({ type: 'handled', result: { ...original, idempotentReplay: true } });
    expect(await inboxRow(message.messageId)).toEqual({ transaction_id: original.transactionId, processed_at: START });
  });
});
