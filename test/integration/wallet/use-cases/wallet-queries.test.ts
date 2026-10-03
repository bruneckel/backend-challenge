import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { inconsistentWallets } from '@test/support/invariants';
import { rejectionOf } from '@test/support/async';
import { commandFor, referencing } from '@test/support/commands';
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
import {
  TransactionNotFoundError,
  WalletNotFoundError,
} from '@wallet/application/errors';
import { WagerTransactionKind } from '@wallet/domain/transaction/wager-transaction';

let harness: PersistenceHarness;
let wagering: Wagering;
const { Bet, Win, Refund } = WagerTransactionKind;

beforeAll(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork);
});

afterEach(async () => {
  expect(await inconsistentWallets(harness.database.sql)).toEqual([]);
});

afterAll(async () => {
  await harness.close();
});

describe('WalletQueries', () => {
  test('shows the current state of a wallet', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    await wagering.submit.execute(commandFor(wallet, Bet, '30.00'));

    expect(await wagering.queries.getWallet(wallet.id)).toEqual({
      ...wallet,
      balance: { amount: '70.00', currency: 'BRL' },
      version: 2,
    });
  });

  test('reports an unknown wallet as not found', async () => {
    expect(
      await rejectionOf(wagering.queries.getWallet(Bun.randomUUIDv7())),
    ).toBeInstanceOf(WalletNotFoundError);
  });

  test('pages the ledger from the newest movement with a cursor for the next page', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const bet = await wagering.submit.execute(commandFor(wallet, Bet, '10.00'));
    await wagering.submit.execute(commandFor(wallet, Win, '5.00'));
    await wagering.submit.execute(commandFor(wallet, Bet, '1.00'));

    const first = await wagering.queries.getLedger(wallet.id, { limit: 2 });
    const second = await wagering.queries.getLedger(wallet.id, {
      beforeVersion: first.nextBeforeVersion ?? undefined,
      limit: 2,
    });

    expect(first.items.map((item) => item.walletVersion)).toEqual([4, 3]);
    expect(first.nextBeforeVersion).toBe(3);
    expect(second.items.map((item) => item.walletVersion)).toEqual([2, 1]);
    expect(second.nextBeforeVersion).toBeNull();
    expect(second.items[0]).toEqual({
      id: expect.any(String),
      transactionId: bet.transactionId,
      direction: 'DEBIT',
      money: { amount: '10.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '90.00', currency: 'BRL' },
      walletVersion: 2,
      createdAt: START,
    });
  });

  test('reads the ledger after a version, oldest first', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const bet = await wagering.submit.execute(commandFor(wallet, Bet, '10.00'));
    await wagering.submit.execute(commandFor(wallet, Win, '5.00'));
    await wagering.submit.execute(commandFor(wallet, Bet, '1.00'));

    const first = await wagering.queries.getLedgerAfter(wallet.id, 1, 2);
    const rest = await wagering.queries.getLedgerAfter(wallet.id, 3, 10);

    expect(first.map((item) => item.walletVersion)).toEqual([2, 3]);
    expect(rest.map((item) => item.walletVersion)).toEqual([4]);
    expect(first[0]?.transactionId).toBe(bet.transactionId);
    expect(first[0]?.balanceAfter).toEqual({
      amount: '90.00',
      currency: 'BRL',
    });
  });

  test('reads the current version of the given wallets', async () => {
    const quiet = await openWalletWith(wagering, '100.00');
    const busy = await openWalletWith(wagering, '100.00');
    await wagering.submit.execute(commandFor(busy, Bet, '10.00'));

    const versions = await wagering.queries.getWalletVersions([
      quiet.id,
      busy.id,
      Bun.randomUUIDv7(),
    ]);

    expect(Object.fromEntries(versions)).toEqual({
      [quiet.id]: 1,
      [busy.id]: 2,
    });
  });

  test('reports the ledger of an unknown wallet as not found', async () => {
    expect(
      await rejectionOf(
        wagering.queries.getLedger(Bun.randomUUIDv7(), { limit: 10 }),
      ),
    ).toBeInstanceOf(WalletNotFoundError);
  });

  test('shows a transaction by id and by provider and external id', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const betCommand = commandFor(wallet, Bet, '10.00');
    const bet = await wagering.submit.execute(betCommand);
    const refundCommand = referencing(betCommand, Refund);
    const refund = await wagering.submit.execute(refundCommand);

    const byId = await wagering.queries.getTransaction(refund.transactionId);
    const byExternalId = await wagering.queries.getTransactionByExternalId(
      'provider-a',
      refundCommand.externalTransactionId,
    );

    expect(byId).toEqual({
      transactionId: refund.transactionId,
      providerId: 'provider-a',
      externalTransactionId: refundCommand.externalTransactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'REFUND',
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: betCommand.externalTransactionId,
      referenceTransactionId: bet.transactionId,
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
      createdAt: START,
      processedAt: START,
    });
    expect(byExternalId).toEqual(byId);
  });

  test('reports an unknown transaction as not found', async () => {
    expect(
      await rejectionOf(wagering.queries.getTransaction(Bun.randomUUIDv7())),
    ).toBeInstanceOf(TransactionNotFoundError);
    expect(
      await rejectionOf(
        wagering.queries.getTransactionByExternalId('provider-a', 'missing'),
      ),
    ).toBeInstanceOf(TransactionNotFoundError);
  });
});
